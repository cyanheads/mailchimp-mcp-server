/**
 * @fileoverview Tests for `mailchimp_segments` list enrichment on `list` and
 * `list-members` — the `filters` echo and the empty-page `notice` on the
 * assembled tool result — against a stubbed `fetch`.
 * @module tests/tools/mailchimp-segments.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpSegmentsTool } from '@/mcp-server/tools/definitions/mailchimp-segments.tool.js';
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

const LIST_NO_MATCH =
  'No segments matched. Drop the `type` filter to list every segment type; with no `type` set, this audience has no segments yet — create one with `operation: create`.';
const LIST_PAST_END =
  'No segments on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.';
const MEMBERS_EMPTY =
  'This segment has no members. Add subscribers to a static segment with `operation: batch-update-members`; a saved segment fills as subscribers meet its conditions.';
const MEMBERS_PAST_END =
  'No members on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.';

const SEGMENT = { id: 11, name: 'VIPs', type: 'static', member_count: 2 };
const MEMBER = { id: 'h1', email_address: 'a@example.com', status: 'subscribed' };

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

describe('mailchimpSegmentsTool — list enrichment', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('list: non-empty page echoes the defaulted query; no notice', async () => {
    const urls = stubFetch({ segments: [SEGMENT], total_items: 9 });
    const result = await runToolContract(mailchimpSegmentsTool, {
      operation: 'list',
      audienceId: 'aud1',
    });
    expect(Object.fromEntries(new URL(urls[0] ?? '').searchParams)).toEqual({
      count: '20',
      offset: '0',
    });
    expect(result.structuredContent).toMatchObject({
      totalItems: 9,
      filters: { count: 20, offset: 0 },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const [body, trailer] = texts(result);
    expect(body).toContain('# Segments (1 of 9)');
    expect(body).toContain('- **VIPs** (`11`) — type:static, memberCount 2');
    expect(trailer).toBe('\n\n**Filters:** count `20` · offset `0`');
  });

  it('list: empty page with `type` echoes it and adds the no-match notice', async () => {
    const urls = stubFetch({ segments: [], total_items: 0 });
    const result = await runToolContract(mailchimpSegmentsTool, {
      operation: 'list',
      audienceId: 'aud1',
      type: 'fuzzy',
    });
    expect(Object.fromEntries(new URL(urls[0] ?? '').searchParams)).toEqual({
      count: '20',
      offset: '0',
      type: 'fuzzy',
    });
    expect(result.structuredContent).toMatchObject({
      totalItems: 0,
      segments: [],
      filters: { count: 20, offset: 0, type: 'fuzzy' },
      notice: LIST_NO_MATCH,
    });
    expect(texts(result)[1]).toBe(
      `\n\n**Filters:** count \`20\` · offset \`0\` · type \`fuzzy\`\n> ${LIST_NO_MATCH}`,
    );
  });

  it('list: offset past a nonzero totalItems gets the past-end notice', async () => {
    stubFetch({ segments: [], total_items: 9 });
    const result = await runToolContract(mailchimpSegmentsTool, {
      operation: 'list',
      audienceId: 'aud1',
      offset: 9,
    });
    expect(result.structuredContent).toMatchObject({ totalItems: 9, notice: LIST_PAST_END });
  });

  it('list-members: echoes count/offset (segment ID stays a path segment)', async () => {
    const urls = stubFetch({ members: [MEMBER], total_items: 2 });
    const result = await runToolContract(mailchimpSegmentsTool, {
      operation: 'list-members',
      audienceId: 'aud1',
      segmentId: 11,
      count: 1,
    });
    const url = new URL(urls[0] ?? '');
    expect(url.pathname).toBe('/3.0/lists/aud1/segments/11/members');
    expect(Object.fromEntries(url.searchParams)).toEqual({ count: '1', offset: '0' });
    expect(result.structuredContent).toMatchObject({
      totalItems: 2,
      filters: { count: 1, offset: 0 },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(texts(result)[0]).toContain('- [h1] a@example.com — status:subscribed');
  });

  it('list-members: empty segment gets the no-members notice', async () => {
    stubFetch({ members: [], total_items: 0 });
    const result = await runToolContract(mailchimpSegmentsTool, {
      operation: 'list-members',
      audienceId: 'aud1',
      segmentId: 11,
    });
    expect(result.structuredContent).toMatchObject({
      members: [],
      filters: { count: 20, offset: 0 },
      notice: MEMBERS_EMPTY,
    });
    expect(texts(result)[1]).toBe(
      `\n\n**Filters:** count \`20\` · offset \`0\`\n> ${MEMBERS_EMPTY}`,
    );
  });

  it('list-members: offset past a nonzero totalItems gets the past-end notice', async () => {
    stubFetch({ members: [], total_items: 2 });
    const result = await runToolContract(mailchimpSegmentsTool, {
      operation: 'list-members',
      audienceId: 'aud1',
      segmentId: 11,
      offset: 5,
    });
    expect(result.structuredContent).toMatchObject({ totalItems: 2, notice: MEMBERS_PAST_END });
  });

  it('get carries neither filters nor notice', async () => {
    stubFetch(SEGMENT);
    const result = await runToolContract(mailchimpSegmentsTool, {
      operation: 'get',
      audienceId: 'aud1',
      segmentId: 11,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('filters');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.content).toHaveLength(1);
  });
});
