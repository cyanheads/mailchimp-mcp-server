/**
 * @fileoverview Tests for `mailchimp_merge_fields` list enrichment — the
 * `filters` echo and the empty-page `notice` on the assembled tool result —
 * against a stubbed `fetch`.
 * @module tests/tools/mailchimp-merge-fields.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpMergeFieldsTool } from '@/mcp-server/tools/definitions/mailchimp-merge-fields.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';

const BASE_CONFIG: ServerConfig = {
  apiKey: 'abcdef0123456789abcdef0123456789-us22',
  baseUrl: 'https://us22.api.mailchimp.com/3.0',
  timeoutMs: 1_000,
  maxRetries: 0,
  concurrencyLimit: 4,
  dataCenter: 'us22',
};

const EMPTY_NOTICE = 'This audience has no merge fields. Add one with `operation: create`.';
const PAST_END_NOTICE =
  'No merge fields on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.';

const FNAME = { merge_id: 1, tag: 'FNAME', name: 'First Name', type: 'text', required: false };

function stubFetch(body: unknown): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return urls;
}

function texts(result: Awaited<ReturnType<typeof runToolContract>>): string[] {
  return result.content.map((block) => (block.type === 'text' ? block.text : ''));
}

describe('mailchimpMergeFieldsTool — list enrichment', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('non-empty page echoes count/offset defaults; the audience ID path segment is not echoed', async () => {
    const urls = stubFetch({ merge_fields: [FNAME], total_items: 4 });
    const result = await runToolContract(mailchimpMergeFieldsTool, {
      operation: 'list',
      audienceId: 'aud1',
    });
    const url = new URL(urls[0] ?? '');
    expect(url.pathname).toBe('/3.0/lists/aud1/merge-fields');
    expect(Object.fromEntries(url.searchParams)).toEqual({ count: '80', offset: '0' });
    expect(result.structuredContent).toMatchObject({
      totalItems: 4,
      filters: { count: 80, offset: 0 },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const [body, trailer] = texts(result);
    expect(body).toContain('# Merge fields (1 of 4)');
    expect(body).toContain('- [1] `FNAME` — First Name [text]');
    expect(trailer).toBe('\n\n**Filters:** count `80` · offset `0`');
  });

  it('empty audience: one no-fields notice after the filters line', async () => {
    stubFetch({ merge_fields: [], total_items: 0 });
    const result = await runToolContract(mailchimpMergeFieldsTool, {
      operation: 'list',
      audienceId: 'aud1',
      count: 10,
    });
    expect(result.structuredContent).toMatchObject({
      totalItems: 0,
      mergeFields: [],
      filters: { count: 10, offset: 0 },
      notice: EMPTY_NOTICE,
    });
    expect(texts(result)[1]).toBe(
      `\n\n**Filters:** count \`10\` · offset \`0\`\n> ${EMPTY_NOTICE}`,
    );
  });

  it('offset past a nonzero totalItems gets the past-end notice', async () => {
    stubFetch({ merge_fields: [], total_items: 4 });
    const result = await runToolContract(mailchimpMergeFieldsTool, {
      operation: 'list',
      audienceId: 'aud1',
      offset: 80,
    });
    expect(result.structuredContent).toMatchObject({
      totalItems: 4,
      filters: { count: 80, offset: 80 },
      notice: PAST_END_NOTICE,
    });
  });

  it('get carries neither filters nor notice', async () => {
    stubFetch(FNAME);
    const result = await runToolContract(mailchimpMergeFieldsTool, {
      operation: 'get',
      audienceId: 'aud1',
      mergeId: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('filters');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.content).toHaveLength(1);
  });
});
