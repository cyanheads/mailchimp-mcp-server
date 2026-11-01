/**
 * @fileoverview Tests for the `mailchimp_reports` tool through its public
 * contract: upstream requests (path + query), `structuredContent`, the
 * `filters` / `notice` enrichment, and `content[]` Markdown rendering of
 * report rows. Stubs `fetch` beneath the real `MailchimpService`.
 * @module tests/tools/mailchimp-reports.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpReportsTool } from '@/mcp-server/tools/definitions/mailchimp-reports.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';
import { reportFixture, SENT, reportText as text } from '../helpers/report-fixture.js';

const BASE_CONFIG: ServerConfig = {
  apiKey: 'abcdef0123456789abcdef0123456789-us22',
  baseUrl: 'https://us22.api.mailchimp.com/3.0',
  timeoutMs: 1_000,
  maxRetries: 0,
  concurrencyLimit: 4,
  dataCenter: 'us22',
};

let requests: URL[] = [];

/** Serve slice data plus its sent parent and record every requested URL. */
function serve(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      requests.push(url);
      const response =
        url.pathname === '/3.0/reports/c1'
          ? { ...SENT, ...(typeof body === 'object' && body !== null ? body : {}) }
          : body;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

const run = (input: Parameters<typeof runToolContract<typeof mailchimpReportsTool>>[1]) =>
  runToolContract(mailchimpReportsTool, input);

const lastRequest = (): URL => {
  // Slice assertions inspect the primary read, before the optional parent diagnostic.
  const url = requests.findLast((url) => url.pathname !== '/3.0/reports/c1') ?? requests.at(-1);
  if (!url) throw new Error('no upstream request recorded');
  return url;
};

const queryOf = (url: URL): Record<string, string> => Object.fromEntries(url.searchParams);

/** `structuredContent` as a plain record, for reading enrichment keys the result type omits. */
const sc = (result: Awaited<ReturnType<typeof run>>): Record<string, unknown> => ({
  ...(result.structuredContent ?? {}),
});

const textOf = (result: Awaited<ReturnType<typeof run>>): string =>
  result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

/** The `format()` text alone — `content[0]`, before the enrichment trailer. */
const formatOf = (result: Awaited<ReturnType<typeof run>>): string => {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('content[0] is not text');
  return block.text;
};

/** The Markdown table lines (header, delimiter, rows) in `markdown`, in order. */
const tableLines = (markdown: string): string[] =>
  markdown.split('\n').filter((line) => line.startsWith('|'));

beforeEach(() => {
  requests = [];
  setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMailchimpServiceForTesting(undefined);
});

describe('mailchimpReportsTool — characterization', () => {
  it('list summarizes reports and passes totalItems through', async () => {
    serve({
      reports: [
        {
          id: 'c1',
          campaign_title: 'Spring',
          subject_line: 'Hello',
          send_time: '2026-04-01T10:00:00+00:00',
          emails_sent: 120,
          opens: { open_rate: 0.5 },
          clicks: { click_rate: 0.1 },
          unsubscribed: 2,
          abuse_reports: 0,
          list_name: 'Main',
        },
      ],
      total_items: 7,
    });
    const result = await run({ operation: 'list' });
    expect(lastRequest().pathname).toBe('/3.0/reports');
    expect(result.structuredContent).toMatchObject({
      operation: 'list',
      totalItems: 7,
      reports: [
        {
          id: 'c1',
          campaignTitle: 'Spring',
          subjectLine: 'Hello',
          emailsSent: 120,
          openRate: 0.5,
          clickRate: 0.1,
          unsubscribed: 2,
          abuseReports: 0,
          audienceName: 'Main',
        },
      ],
    });
  });

  it('slice locations returns camelCase rows and totalItems', async () => {
    serve({
      locations: [{ country_code: 'US', region: 'WA', region_name: 'Washington', opens: 4 }],
      total_items: 1,
    });
    const result = await run({ operation: 'slice', dimension: 'locations', campaignId: 'c1' });
    expect(lastRequest().pathname).toBe('/3.0/reports/c1/locations');
    expect(queryOf(lastRequest())).toEqual({ count: '20', offset: '0' });
    expect(result.structuredContent).toMatchObject({
      operation: 'slice',
      dimension: 'locations',
      campaignId: 'c1',
      totalItems: 1,
      rows: [{ countryCode: 'US', region: 'WA', regionName: 'Washington', opens: 4 }],
    });
  });
});

describe('mailchimpReportsTool — click-details linkId (#25)', () => {
  const MEMBERS = {
    members: [
      {
        email_id: 'e1',
        email_address: 'ada@example.com',
        merge_fields: { FNAME: 'Ada' },
        vip: false,
        clicks: 3,
        campaign_id: 'c1',
        url_id: 'L1',
        list_id: 'a1',
        list_is_active: true,
        contact_status: 'subscribed',
        _links: [],
      },
    ],
    total_items: 12,
  };

  it('lists the members who clicked the link, paged by count/offset', async () => {
    serve(MEMBERS);
    const result = await run({
      operation: 'slice',
      dimension: 'click-details',
      campaignId: 'c1',
      linkId: 'L1',
      count: 5,
      offset: 10,
    });
    expect(lastRequest().pathname).toBe('/3.0/reports/c1/click-details/L1/members');
    expect(queryOf(lastRequest())).toEqual({ count: '5', offset: '10' });
    expect(result.structuredContent).toMatchObject({
      dimension: 'click-details',
      totalItems: 12,
      rows: [{ emailAddress: 'ada@example.com', clicks: 3, contactStatus: 'subscribed' }],
    });
  });

  it('renders member rows with link-clicker leading columns and echoes linkId', async () => {
    serve(MEMBERS);
    const result = await run({
      operation: 'slice',
      dimension: 'click-details',
      campaignId: 'c1',
      linkId: 'L1',
    });
    expect(result.structuredContent).toMatchObject({ linkId: 'L1' });
    const text = textOf(result);
    expect(text).toContain('_linkId: L1_');
    expect(tableLines(text)).toEqual([
      '| emailAddress | clicks | contactStatus | vip | emailId | mergeFields | campaignId | urlId | listId | listIsActive |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| ada@example.com | 3 | subscribed | false | e1 | {"FNAME":"Ada"} | c1 | L1 | a1 | true |',
    ]);
  });

  it('gives an empty member page its own notice', async () => {
    serve({ members: [], total_items: 0 });
    const result = await run({
      operation: 'slice',
      dimension: 'click-details',
      campaignId: 'c1',
      linkId: 'L1',
    });
    expect(result.structuredContent).toMatchObject({
      rows: [],
      filters: { count: 20, offset: 0 },
      notice: expect.stringContaining('without `linkId`'),
    });
  });
});

describe('mailchimpReportsTool — filters / notice enrichment (#7)', () => {
  it('list echoes defaults and adds no notice on a non-empty page', async () => {
    serve({ reports: [{ id: 'c1', send_time: '2026-04-01T10:00:00+00:00' }], total_items: 1 });
    const result = await run({ operation: 'list' });
    expect(queryOf(lastRequest())).toEqual({ count: '20', offset: '0' });
    expect(sc(result).filters).toEqual({ count: 20, offset: 0 });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).toContain('**Filters:** count `20` · offset `0`');
  });

  it('list echoes narrowing filters by input name and names them in one notice', async () => {
    serve({ reports: [], total_items: 0 });
    const result = await run({
      operation: 'list',
      type: 'regular',
      sinceSendTime: '2026-01-01T00:00:00Z',
    });
    expect(queryOf(lastRequest())).toEqual({
      count: '20',
      offset: '0',
      type: 'regular',
      since_send_time: '2026-01-01T00:00:00Z',
    });
    expect(sc(result).filters).toEqual({
      count: 20,
      offset: 0,
      type: 'regular',
      sinceSendTime: '2026-01-01T00:00:00Z',
    });
    const notice = String(sc(result).notice);
    expect(notice).toBe(
      'No campaign reports match `type`, `sinceSendTime`; widen or drop those filters.',
    );
    expect(notice).not.toContain('regular');
    const text = textOf(result);
    expect(text.split(notice).length - 1).toBe(1);
    expect(text).toContain(`> ${notice}`);
    expect(sc(result).totalItems).toBe(0);
  });

  it('list with no filters and no reports says only sent campaigns have reports', async () => {
    serve({ reports: [], total_items: 0 });
    const result = await run({ operation: 'list' });
    expect(sc(result).notice).toBe(
      'No campaign reports exist yet; only sent campaigns have reports.',
    );
  });

  it('list offset past a nonzero total gets the offset-past-end notice', async () => {
    serve({ reports: [], total_items: 5 });
    const result = await run({ operation: 'list', offset: 5, type: 'rss' });
    expect(sc(result).totalItems).toBe(5);
    expect(sc(result).notice).toBe(
      'No campaign reports on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.',
    );
  });

  it('get populates neither filters nor notice', async () => {
    serve({ id: 'c1', send_time: '2026-04-01T10:00:00+00:00' });
    const result = await run({ operation: 'get', campaignId: 'c1' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('filters');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('**Filters:**');
  });

  const SLICES = [
    { dimension: 'abuse-reports', key: 'abuse_reports', filters: undefined },
    { dimension: 'advice', key: 'advice', filters: undefined },
    { dimension: 'domain-performance', key: 'domains', filters: undefined },
    { dimension: 'click-details', key: 'urls_clicked', filters: { count: 20, offset: 0 } },
    { dimension: 'locations', key: 'locations', filters: { count: 20, offset: 0 } },
    { dimension: 'sent-to', key: 'sent_to', filters: { count: 20, offset: 0 } },
    { dimension: 'unsubscribed', key: 'unsubscribes', filters: { count: 20, offset: 0 } },
    { dimension: 'open-details', key: 'members', filters: { count: 20, offset: 0 } },
    { dimension: 'email-activity', key: 'emails', filters: { count: 20, offset: 0 } },
  ] as const;

  it.each(SLICES)(
    '$dimension: filters equal the query sent; empty page → one notice',
    async ({ dimension, key, filters }) => {
      serve({ [key]: [], total_items: 0 });
      const result = await run({ operation: 'slice', dimension, campaignId: 'c1' });
      const sent = queryOf(lastRequest());
      if (filters) {
        expect(sc(result).filters).toEqual(filters);
        expect(sent).toEqual(
          Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, String(v)])),
        );
      } else {
        expect(result.structuredContent).not.toHaveProperty('filters');
        expect(sent).toEqual({});
      }
      const notice = sc(result).notice;
      expect(typeof notice).toBe('string');
      expect(textOf(result).split(String(notice)).length - 1).toBe(1);
      expect(textOf(result)).toContain('# Rows (0 of 0)');
      expect(textOf(result)).not.toMatch(/^\|/m);
    },
  );

  it.each(SLICES)(
    '$dimension: a non-empty page keeps filters and has no notice',
    async ({ dimension, key, filters }) => {
      serve({ [key]: [{ id: 'r1', email_address: 'a@example.com' }], total_items: 1 });
      const result = await run({ operation: 'slice', dimension, campaignId: 'c1' });
      expect(sc(result).filters).toEqual(filters);
      expect(result.structuredContent).not.toHaveProperty('notice');
    },
  );

  it.each(['open-details', 'email-activity'] as const)(
    '%s sends and echoes since; empty since sends nothing',
    async (dimension) => {
      const key = dimension === 'open-details' ? 'members' : 'emails';
      serve({ [key]: [], total_items: 0 });
      const withSince = await run({
        operation: 'slice',
        dimension,
        campaignId: 'c1',
        since: '2026-04-01T00:00:00Z',
        count: 50,
        offset: 0,
      });
      expect(queryOf(lastRequest())).toEqual({
        count: '50',
        offset: '0',
        since: '2026-04-01T00:00:00Z',
      });
      expect(sc(withSince).filters).toEqual({
        count: 50,
        offset: 0,
        since: '2026-04-01T00:00:00Z',
      });
      expect(sc(withSince).notice).toBe(
        'Nothing was recorded after `since`; move `since` earlier or drop it.',
      );

      const emptySince = await run({ operation: 'slice', dimension, campaignId: 'c1', since: '' });
      expect(queryOf(lastRequest())).toEqual({ count: '20', offset: '0' });
      expect(sc(emptySince).filters).toEqual({ count: 20, offset: 0 });
    },
  );

  it('single-object reads (eepurl, subscriberHash) send no query and add no enrichment', async () => {
    serve({ eepurl: 'http://eepurl.com/x', clicks: { clicks: 0 } });
    const eepurl = await run({ operation: 'slice', dimension: 'eepurl', campaignId: 'c1' });
    expect(queryOf(lastRequest())).toEqual({});
    expect(eepurl.structuredContent).not.toHaveProperty('filters');
    expect(eepurl.structuredContent).not.toHaveProperty('notice');

    serve({ email_address: 'a@example.com', opens_count: 2 });
    const member = await run({
      operation: 'slice',
      dimension: 'open-details',
      campaignId: 'c1',
      subscriberHash: 'h1',
    });
    expect(lastRequest().pathname).toBe('/3.0/reports/c1/open-details/h1');
    expect(queryOf(lastRequest())).toEqual({});
    expect(member.structuredContent).not.toHaveProperty('filters');
    expect(member.structuredContent).not.toHaveProperty('totalItems');
  });

  it('slice offset past a nonzero total gets the offset-past-end notice', async () => {
    serve({ sent_to: [], total_items: 3 });
    const result = await run({
      operation: 'slice',
      dimension: 'sent-to',
      campaignId: 'c1',
      offset: 3,
    });
    expect(sc(result).notice).toBe(
      'No rows on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.',
    );
  });
});

describe('mailchimpReportsTool — row rendering (#10)', () => {
  const clickRow = (i: number) => ({
    id: `link${i}`,
    url: `https://example.com/p/${i}`,
    total_clicks: i,
    unique_clicks: i,
    click_percentage: 0.1,
    unique_click_percentage: 0.1,
    last_click: '2026-04-02T10:00:00+00:00',
    campaign_id: 'c1',
    ab_split: { a: { total_clicks_a: i }, b: { total_clicks_b: 0 } },
    _links: [{ rel: 'self' }],
  });

  it('renders every row (40 in, 40 out) with leading columns, every key, and no JSON bullets', async () => {
    const upstream = Array.from({ length: 40 }, (_, i) => clickRow(i));
    serve({ urls_clicked: upstream, total_items: 55 });
    const result = await run({
      operation: 'slice',
      dimension: 'click-details',
      campaignId: 'c1',
      count: 40,
    });
    const rows = sc(result).rows as Record<string, unknown>[];
    expect(rows).toHaveLength(40);
    expect(rows[3]).toEqual({
      id: 'link3',
      url: 'https://example.com/p/3',
      totalClicks: 3,
      uniqueClicks: 3,
      clickPercentage: 0.1,
      uniqueClickPercentage: 0.1,
      lastClick: '2026-04-02T10:00:00+00:00',
      campaignId: 'c1',
      abSplit: { a: { totalClicksA: 3 }, b: { totalClicksB: 0 } },
    });

    const text = formatOf(result);
    expect(text).not.toMatch(/^- \{/m);
    expect(text).not.toContain('more.');
    const lines = text.split('\n');
    // Values identical on every row render once above the table, in column order.
    expect(lines.slice(0, 13)).toEqual([
      'Operation: slice',
      'Dimension: click-details',
      '_campaignId: c1_',
      '',
      '# Rows (40 of 55)',
      '',
      '- **clickPercentage:** 0.1',
      '- **uniqueClickPercentage:** 0.1',
      '- **lastClick:** 2026-04-02T10:00:00+00:00',
      '- **campaignId:** c1',
      '',
      '| url | totalClicks | uniqueClicks | id | abSplit |',
      '| --- | --- | --- | --- | --- |',
    ]);
    expect(lines.slice(13)).toHaveLength(40);
    expect(lines.at(-1)).toBe(
      '| https://example.com/p/39 | 39 | 39 | link39 | {"a":{"totalClicksA":39},"b":{"totalClicksB":0}} |',
    );
  });

  it('wires the dimension leading columns first and moves a multi-line value below', async () => {
    serve({
      unsubscribes: [
        {
          email_address: 'a@example.com',
          timestamp: '2026-04-02T10:00:00+00:00',
          reason: 'too many emails',
          campaign_id: 'c1',
        },
        {
          campaign_id: 'c2',
          reason: 'line one\n- line two',
          timestamp: '2026-04-03T10:00:00+00:00',
          email_address: 'c@example.com',
        },
      ],
      total_items: 2,
    });
    const result = await run({ operation: 'slice', dimension: 'unsubscribed', campaignId: 'c1' });
    expect(formatOf(result)).toBe(
      [
        'Operation: slice',
        'Dimension: unsubscribed',
        '_campaignId: c1_',
        '',
        '# Rows (2 of 2)',
        '',
        '| emailAddress | timestamp | reason | campaignId |',
        '| --- | --- | --- | --- |',
        '| a@example.com | 2026-04-02T10:00:00+00:00 | too many emails | c1 |',
        '| c@example.com | 2026-04-03T10:00:00+00:00 | (below) | c2 |',
        '',
        '**Row 2 · reason:** line one\\',
        '\\- line two',
      ].join('\n'),
    );
  });

  it('renders advice as per-row lines and every extra key', async () => {
    serve({
      advice: [
        { type: 'positive', message: 'Opens beat *your* average.' },
        { type: 'negative', message: 'Clicks fell.', extra: 1 },
      ],
      total_items: 2,
    });
    const result = await run({ operation: 'slice', dimension: 'advice', campaignId: 'c1' });
    const text = textOf(result);
    expect(text).toContain('- positive: Opens beat \\*your\\* average.');
    expect(text).toContain('- negative: Clicks fell. · extra: 1');
    expect(text).not.toMatch(/^\|/m);
  });

  it('renders eepurl as key/value lines with nested values as JSON', async () => {
    serve({
      eepurl: 'http://eepurl.com/abc',
      clicks: { clicks: 4, first_click: '2026-04-02T10:00:00+00:00' },
      referrers: [],
    });
    const result = await run({ operation: 'slice', dimension: 'eepurl', campaignId: 'c1' });
    const text = textOf(result);
    expect(text).toContain('# Rows (1)');
    expect(text).toContain('- **eepurl:** http://eepurl.com/abc');
    expect(text).toContain('- **clicks:** {"clicks":4,"firstClick":"2026-04-02T10:00:00+00:00"}');
    expect(text).toContain('- **referrers:** \\[\\]');
  });

  it('falls back to a table of every key for domain-performance and email-activity', async () => {
    serve({
      domains: [
        { domain: 'gmail.com', emails_sent: 10, opens: 4 },
        { domain: 'example.org', emails_sent: 2, bounces: 1 },
      ],
      total_items: 2,
    });
    const domains = tableLines(
      textOf(await run({ operation: 'slice', dimension: 'domain-performance', campaignId: 'c1' })),
    );
    expect(domains).toEqual([
      '| domain | emailsSent | opens | bounces |',
      '| --- | --- | --- | --- |',
      '| gmail.com | 10 | 4 |  |',
      '| example.org | 2 |  | 1 |',
    ]);

    serve({
      emails: [
        {
          email_address: 'a@example.com',
          activity: [{ action: 'open', timestamp: '2026-04-02T10:00:00+00:00' }],
        },
      ],
      total_items: 1,
    });
    const activity = tableLines(
      textOf(await run({ operation: 'slice', dimension: 'email-activity', campaignId: 'c1' })),
    );
    expect(activity).toEqual([
      '| emailAddress | activity |',
      '| --- | --- |',
      '| a@example.com | \\[{"action":"open","timestamp":"2026-04-02T10:00:00+00:00"}\\] |',
    ]);
  });

  it('renders a single open-details member as a one-row table', async () => {
    serve({ email_address: 'a@example.com', opens_count: 2, opens: [{ timestamp: 't1' }] });
    const result = await run({
      operation: 'slice',
      dimension: 'open-details',
      campaignId: 'c1',
      subscriberHash: 'h1',
    });
    expect(tableLines(textOf(result))).toEqual([
      '| emailAddress | opensCount | opens |',
      '| --- | --- | --- |',
      '| a@example.com | 2 | \\[{"timestamp":"t1"}\\] |',
    ]);
  });
});

describe('report availability (#30, #36)', () => {
  const fixture = reportFixture();
  const reports = mailchimpReportsTool;

  it('keeps nonempty draft advice without requesting its parent report', async () => {
    fixture.route(() =>
      Response.json({
        advice: [{ type: 'advice-neutralstat', message: 'Suggestions follow sending' }],
        total_items: 1,
      }),
    );
    const result = await runToolContract(reports, {
      operation: 'slice',
      dimension: 'advice',
      campaignId: 'draft',
    });
    expect(result.structuredContent).toMatchObject({
      rows: [{ message: 'Suggestions follow sending' }],
    });
    expect(text(result)).toContain('Suggestions follow sending');
    expect(fixture.paths).toEqual(['/3.0/reports/draft/advice']);
  });

  it('draft recovery targets the existing campaign and does not invent status', async () => {
    fixture.route(() => Response.json({ id: 'draft', type: 'regular', send_time: '' }));
    const result = await runToolContract(reports, { operation: 'get', campaignId: 'draft' });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'campaign_not_sent' } },
    });
    expect(result.structuredContent).not.toHaveProperty('error.data.status');
    expect(text(result)).toContain('mailchimp_campaigns');
    expect(text(result)).not.toContain('mailchimp_send_campaign');
  });
  it.each(['locations', 'click-details', 'unsubscribed'] as const)(
    '%s empty draft discloses unsent state',
    async (dimension) => {
      fixture.route((path) =>
        Response.json(
          path.endsWith('/c1')
            ? { id: 'c1', send_time: '' }
            : { locations: [], urls_clicked: [], unsubscribes: [], total_items: 0 },
        ),
      );
      const result = await runToolContract(reports, {
        operation: 'slice',
        dimension,
        campaignId: 'c1',
        count: 1000,
      });
      expect(result.structuredContent).toMatchObject({
        rows: [],
        totalItems: 0,
        filters: { count: 1000, offset: 0 },
        notice: expect.stringContaining('not been sent'),
      });
      expect(text(result)).toContain('not been sent');
      expect(fixture.paths).toHaveLength(2);
    },
  );

  it('sent empty since/offset pages keep their precise notice', async () => {
    fixture.route((path) =>
      Response.json(path.endsWith('/c1') ? SENT : { members: [], total_items: 2 }),
    );
    const result = await runToolContract(reports, {
      operation: 'slice',
      dimension: 'open-details',
      campaignId: 'c1',
      since: '2026-01-01',
      offset: 2,
    });
    expect(result.structuredContent).toMatchObject({
      rows: [],
      filters: { count: 20, offset: 2, since: '2026-01-01' },
      notice: expect.stringContaining('at or past'),
    });
    expect(text(result)).toContain('at or past');
  });

  it.each([429, 500, 503])(
    'a diagnostic HTTP %s preserves the primary answer and discloses unknown status',
    async (status) => {
      fixture.route((path) =>
        path.endsWith('/c1')
          ? Response.json({ title: 'Diagnostic unavailable' }, { status })
          : Response.json({ locations: [], total_items: 0 }),
      );
      const result = await runToolContract(reports, {
        operation: 'slice',
        dimension: 'locations',
        campaignId: 'c1',
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        rows: [],
        notice: expect.stringContaining('could not be determined'),
      });
      expect(text(result)).toContain('could not be determined');
      expect(text(result)).not.toContain('not been sent');
    },
  );

  it.each([401, 403, 404])('a diagnostic HTTP %s remains a failure', async (status) => {
    fixture.route((path) =>
      path.endsWith('/c1')
        ? Response.json({ title: 'Diagnostic invalid' }, { status })
        : Response.json({ locations: [], total_items: 0 }),
    );
    const result = await runToolContract(reports, {
      operation: 'slice',
      dimension: 'locations',
      campaignId: 'c1',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(String(status));
  });

  it('caller cancellation during the diagnostic propagates', async () => {
    const controller = new AbortController();
    fixture.route((path, init) => {
      if (!path.endsWith('/c1')) return Response.json({ locations: [], total_items: 0 });
      controller.abort(new DOMException('Stop send-state check', 'AbortError'));
      return Promise.reject(init?.signal?.reason);
    });
    const result = await runToolContract(
      reports,
      { operation: 'slice', dimension: 'locations', campaignId: 'c1' },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(text(result)).toContain('Stop send-state check');
  });

  it('a local diagnostic timeout preserves the answer without cancelling its caller', async () => {
    const deadline = new AbortController();
    const caller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    fixture.route((path, init) => {
      if (!path.endsWith('/c1')) return Response.json({ locations: [], total_items: 0 });
      deadline.abort(new DOMException('Diagnostic deadline exceeded', 'TimeoutError'));
      return Promise.reject(init?.signal?.reason);
    });
    const result = await runToolContract(
      reports,
      { operation: 'slice', dimension: 'locations', campaignId: 'c1' },
      { context: { signal: caller.signal } },
    );
    expect(timeout).toHaveBeenCalledWith(2000);
    expect(caller.signal.aborted).toBe(false);
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain('could not be determined');
  });

  it('invalid slice arguments fail before any network calls', async () => {
    fixture.route(() => {
      throw new Error('Unexpected fetch');
    });
    const result = await runToolContract(reports, {
      operation: 'slice',
      campaignId: 'c1',
      dimension: 'locations',
      count: 1001,
    });
    expect(result.isError).toBe(true);
    expect(fixture.paths).toEqual([]);
  });

  it('the diagnostic deadline bounds retry backoff as well as network I/O', async () => {
    vi.useFakeTimers();
    const retrying = new MailchimpService({ ...BASE_CONFIG, maxRetries: 3 });
    setMailchimpServiceForTesting(retrying);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const deadline = new AbortController();
      setTimeout(
        () => deadline.abort(new DOMException('Diagnostic deadline exceeded', 'TimeoutError')),
        ms,
      );
      return deadline.signal;
    });
    fixture.route((path) =>
      path.endsWith('/c1')
        ? Response.json(
            { title: 'Rate limited' },
            { status: 429, headers: { 'retry-after': '30' } },
          )
        : Response.json({ locations: [], total_items: 0 }),
    );
    try {
      const pending = runToolContract(reports, {
        operation: 'slice',
        dimension: 'locations',
        campaignId: 'c1',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain('could not be determined');
      expect(fixture.paths).toEqual(['/3.0/reports/c1/locations', '/3.0/reports/c1']);
    } finally {
      retrying.dispose();
      vi.clearAllTimers();
    }
  });
});
