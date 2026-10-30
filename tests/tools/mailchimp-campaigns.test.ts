/**
 * @fileoverview Tests for `mailchimp_campaigns` list enrichment: the `filters`
 * echo of the query sent upstream and the empty-page `notice`, asserted on the
 * assembled tool result (`structuredContent` and the `content[]` trailer)
 * through `runToolContract`, against a stubbed `fetch`.
 * @module tests/tools/mailchimp-campaigns.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpCampaignsTool } from '@/mcp-server/tools/definitions/mailchimp-campaigns.tool.js';
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

const NO_MATCH_NOTICE =
  'No campaigns matched. Widen or drop `status`, `listId`, `sinceSendTime`, and `beforeSendTime`; with none set, the account has no campaigns yet — create a draft with `operation: create`.';
const PAST_END_NOTICE =
  'No campaigns on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.';

const CAMPAIGN = {
  id: 'c1',
  web_id: 77,
  type: 'regular',
  status: 'sent',
  settings: { subject_line: 'Spring news', title: 'Spring' },
};

/** Stubs `fetch` with one JSON body and returns the recorded request URLs. */
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

function queryOf(url: string | undefined): Record<string, string> {
  return Object.fromEntries(new URL(url ?? '').searchParams);
}

function texts(result: Awaited<ReturnType<typeof runToolContract>>): string[] {
  return result.content.map((block) => (block.type === 'text' ? block.text : ''));
}

describe('mailchimpCampaignsTool — list enrichment', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('non-empty page echoes the defaulted query as filters and sets no notice', async () => {
    const urls = stubFetch({ campaigns: [CAMPAIGN], total_items: 3 });
    const result = await runToolContract(mailchimpCampaignsTool, { operation: 'list' });

    expect(result.isError).toBeFalsy();
    expect(queryOf(urls[0])).toEqual({ count: '10', offset: '0' });
    expect(result.structuredContent).toMatchObject({
      operation: 'list',
      totalItems: 3,
      filters: { count: 10, offset: 0 },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const [body, trailer] = texts(result);
    expect(body).toContain('# Campaigns (1 of 3)');
    expect(body).toContain(
      '**"Spring news"** [title: Spring] (`c1`) webId:77 — type:regular, status:sent',
    );
    expect(trailer).toBe('\n\n**Filters:** count `10` · offset `0`');
    expect(result.content).toHaveLength(2);
  });

  it('empty filtered page echoes every sent filter and adds the no-match notice once', async () => {
    const urls = stubFetch({ campaigns: [], total_items: 0 });
    const result = await runToolContract(mailchimpCampaignsTool, {
      operation: 'list',
      status: 'sent',
      listId: 'abc123',
      sinceSendTime: '2026-01-01T00:00:00Z',
      beforeSendTime: '2026-02-01T00:00:00Z',
      count: 25,
      offset: 5,
    });

    expect(queryOf(urls[0])).toEqual({
      count: '25',
      offset: '5',
      status: 'sent',
      list_id: 'abc123',
      since_send_time: '2026-01-01T00:00:00Z',
      before_send_time: '2026-02-01T00:00:00Z',
    });
    expect(result.structuredContent).toMatchObject({
      totalItems: 0,
      campaigns: [],
      filters: {
        count: 25,
        offset: 5,
        status: 'sent',
        listId: 'abc123',
        sinceSendTime: '2026-01-01T00:00:00Z',
        beforeSendTime: '2026-02-01T00:00:00Z',
      },
      notice: NO_MATCH_NOTICE,
    });
    const [body, trailer] = texts(result);
    expect(body).toBe('Operation: list\n\n# Campaigns (0 of 0)');
    expect(trailer).toBe(
      `\n\n**Filters:** count \`25\` · offset \`5\` · status \`sent\` · listId \`abc123\` · sinceSendTime \`2026-01-01T00:00:00Z\` · beforeSendTime \`2026-02-01T00:00:00Z\`\n> ${NO_MATCH_NOTICE}`,
    );
  });

  it('empty-string filters are dropped from both the request and filters', async () => {
    const urls = stubFetch({ campaigns: [], total_items: 0 });
    const result = await runToolContract(mailchimpCampaignsTool, {
      operation: 'list',
      status: '',
      listId: '',
    });
    expect(queryOf(urls[0])).toEqual({ count: '10', offset: '0' });
    expect(result.structuredContent).toMatchObject({ filters: { count: 10, offset: 0 } });
    expect(Object.keys((result.structuredContent as { filters: object }).filters)).toEqual([
      'count',
      'offset',
    ]);
  });

  it('offset at or past a nonzero totalItems gets the past-end notice', async () => {
    stubFetch({ campaigns: [], total_items: 5 });
    const atEnd = await runToolContract(mailchimpCampaignsTool, { operation: 'list', offset: 5 });
    expect(atEnd.structuredContent).toMatchObject({ totalItems: 5, notice: PAST_END_NOTICE });

    const pastEnd = await runToolContract(mailchimpCampaignsTool, {
      operation: 'list',
      offset: 40,
    });
    expect(pastEnd.structuredContent).toMatchObject({ totalItems: 5, notice: PAST_END_NOTICE });
    expect(texts(pastEnd)[1]).toBe(
      `\n\n**Filters:** count \`10\` · offset \`40\`\n> ${PAST_END_NOTICE}`,
    );
  });

  it('nonzero offset over an empty collection is a no-match, not past-end', async () => {
    stubFetch({ campaigns: [], total_items: 0 });
    const result = await runToolContract(mailchimpCampaignsTool, { operation: 'list', offset: 10 });
    expect(result.structuredContent).toMatchObject({ notice: NO_MATCH_NOTICE });
  });

  it('non-list operations carry neither filters nor notice', async () => {
    stubFetch(CAMPAIGN);
    const result = await runToolContract(mailchimpCampaignsTool, {
      operation: 'get',
      campaignId: 'c1',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('filters');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.content).toHaveLength(1);
  });
});
