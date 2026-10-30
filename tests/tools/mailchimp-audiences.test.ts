/**
 * @fileoverview Tests for the `mailchimp_audiences` tool, run through the real
 * `MailchimpService` against a stubbed `fetch`: create/update request bodies
 * (partial `contact` / `campaignDefaults` updates merge current values),
 * `filters` / `notice` enrichment on list reads, and `content[]` rendering of
 * activity, growth, and signup-form rows.
 * @module tests/tools/mailchimp-audiences.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpAudiencesTool as tool } from '@/mcp-server/tools/definitions/mailchimp-audiences.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';

const CONFIG: ServerConfig = {
  apiKey: 'abcdef0123456789abcdef0123456789-us22',
  baseUrl: 'https://us22.api.mailchimp.com/3.0',
  timeoutMs: 1_000,
  maxRetries: 0,
  concurrencyLimit: 4,
  dataCenter: 'us22',
};

interface Recorded {
  body: unknown;
  method: string;
  path: string;
  query: Record<string, string>;
}

type Route = (req: Recorded) => unknown;

let requests: Recorded[];
let routes: Map<string, Route>;

/** Route key is `METHOD /path` relative to the API base. */
function route(key: string, respond: Route | unknown): void {
  routes.set(key, typeof respond === 'function' ? (respond as Route) : () => respond);
}

beforeEach(() => {
  requests = [];
  routes = new Map();
  setMailchimpServiceForTesting(new MailchimpService(CONFIG));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const req: Recorded = {
        method: init?.method ?? 'GET',
        path: url.pathname.replace('/3.0', ''),
        query: Object.fromEntries(url.searchParams),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      requests.push(req);
      const handler = routes.get(`${req.method} ${req.path}`);
      if (!handler) {
        return new Response(JSON.stringify({ title: 'Not routed', detail: req.path }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(handler(req)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMailchimpServiceForTesting(undefined);
});

/** The concatenated `content[]` text. */
function text(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? '')
    .join('\n');
}

/**
 * GFM table-row cells: split on pipes not preceded by a backslash, dropping
 * the outer edges. A raw `|` inside a value adds a cell, so a cell-count
 * mismatch against the header is a broken row.
 */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

const CURRENT = {
  id: 'aud1',
  name: 'Newsletter',
  contact: {
    company: 'Acme',
    address1: '1 Main St',
    address2: 'Suite 5',
    city: 'Portland',
    state: 'OR',
    zip: '97201',
    country: 'US',
    phone: '555-0100',
  },
  campaign_defaults: {
    from_name: 'Acme',
    from_email: 'news@acme.test',
    subject: 'Acme news',
    language: 'fr',
  },
};

const FULL_CREATE = {
  operation: 'create' as const,
  name: 'Newsletter',
  permissionReminder: 'You signed up at acme.test',
  contact: {
    company: 'Acme',
    address1: '1 Main St',
    city: 'Portland',
    state: 'OR',
    zip: '97201',
    country: 'US',
  },
  campaignDefaults: { fromName: 'Acme', fromEmail: 'news@acme.test' },
};

describe('create', () => {
  it('posts the full contact and campaign defaults, defaulting subject, language, and email type', async () => {
    route('POST /lists', (req: Recorded) => ({ id: 'new', ...(req.body as object) }));
    const result = await runToolContract(tool, FULL_CREATE);
    expect(result.isError).toBeFalsy();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /lists']);
    expect(requests[0]?.body).toEqual({
      name: 'Newsletter',
      permission_reminder: 'You signed up at acme.test',
      email_type_option: false,
      contact: {
        company: 'Acme',
        address1: '1 Main St',
        city: 'Portland',
        state: 'OR',
        zip: '97201',
        country: 'US',
      },
      campaign_defaults: {
        from_name: 'Acme',
        from_email: 'news@acme.test',
        subject: '',
        language: 'en',
      },
    });
    expect(result.structuredContent).toMatchObject({
      operation: 'create',
      audience: { id: 'new', name: 'Newsletter' },
    });
  });

  it('rejects a partial create, naming every missing field, before any request', async () => {
    const result = await runToolContract(tool, {
      operation: 'create',
      name: 'Newsletter',
      contact: { city: 'Portland' },
    });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(text(result)).toContain(
      'Missing required fields for create: contact.company, contact.address1, contact.state, contact.zip, contact.country, permissionReminder, campaignDefaults.fromName, campaignDefaults.fromEmail.',
    );
  });
});

describe('update', () => {
  it('sends only top-level fields the caller set, with no read first', async () => {
    route('PATCH /lists/aud1', { ...CURRENT, name: 'Renamed' });
    const result = await runToolContract(tool, {
      operation: 'update',
      audienceId: 'aud1',
      name: 'Renamed',
      doubleOptin: true,
    });
    expect(result.structuredContent).toMatchObject({ audience: { name: 'Renamed' } });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['PATCH /lists/aud1']);
    expect(requests[0]?.body).toEqual({ name: 'Renamed', double_optin: true });
  });

  it('a partial contact keeps every omitted subfield at its current value', async () => {
    route('GET /lists/aud1', CURRENT);
    route('PATCH /lists/aud1', CURRENT);
    const result = await runToolContract(tool, {
      operation: 'update',
      audienceId: 'aud1',
      contact: { city: 'Seattle', zip: '' },
    });
    expect(result.isError).toBeFalsy();
    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({ contact: { ...CURRENT.contact, city: 'Seattle' } });
  });

  it('a partial campaignDefaults keeps every omitted subfield at its current value', async () => {
    route('GET /lists/aud1', CURRENT);
    route('PATCH /lists/aud1', CURRENT);
    await runToolContract(tool, {
      operation: 'update',
      audienceId: 'aud1',
      campaignDefaults: { subject: 'Fresh news' },
    });
    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({
      campaign_defaults: { ...CURRENT.campaign_defaults, subject: 'Fresh news' },
    });
  });

  it('reads only contact and campaign_defaults once, before the PATCH', async () => {
    route('GET /lists/aud1', CURRENT);
    route('PATCH /lists/aud1', CURRENT);
    await runToolContract(tool, {
      operation: 'update',
      audienceId: 'aud1',
      contact: { phone: '555-0199' },
      campaignDefaults: { fromName: 'Acme Co' },
    });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /lists/aud1',
      'PATCH /lists/aud1',
    ]);
    expect(requests[0]?.query).toEqual({ fields: 'contact,campaign_defaults' });
    expect(requests[1]?.body).toEqual({
      contact: { ...CURRENT.contact, phone: '555-0199' },
      campaign_defaults: { ...CURRENT.campaign_defaults, from_name: 'Acme Co' },
    });
  });

  it('rejects, without writing, when a required subfield has no current or supplied value', async () => {
    route('GET /lists/aud1', { contact: { city: 'Portland' } });
    route('PATCH /lists/aud1', CURRENT);
    const result = await runToolContract(tool, {
      operation: 'update',
      audienceId: 'aud1',
      contact: { company: 'Acme' },
    });
    expect(result.isError).toBe(true);
    expect(requests.map((r) => r.method)).toEqual(['GET']);
    expect(text(result)).toContain('contact.address1, contact.state, contact.zip, contact.country');
  });

  it('re-sends a required subfield Mailchimp stored blank instead of rejecting', async () => {
    route('GET /lists/aud1', { contact: { ...CURRENT.contact, state: '' } });
    route('PATCH /lists/aud1', CURRENT);
    const result = await runToolContract(tool, {
      operation: 'update',
      audienceId: 'aud1',
      contact: { city: 'Tokyo' },
    });
    expect(result.isError).toBeFalsy();
    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({ contact: { ...CURRENT.contact, state: '', city: 'Tokyo' } });
  });

  it('propagates cancellation from the read and never sends the PATCH', async () => {
    const controller = new AbortController();
    route('GET /lists/aud1', () => {
      controller.abort();
      return CURRENT;
    });
    route('PATCH /lists/aud1', CURRENT);
    const result = await runToolContract(
      tool,
      { operation: 'update', audienceId: 'aud1', contact: { city: 'Seattle' } },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(requests.map((r) => r.method)).not.toContain('PATCH');
  });
});

describe('list reads — structuredContent', () => {
  it('list: summaries and totalItems', async () => {
    route('GET /lists', {
      lists: [{ ...CURRENT, web_id: 7, stats: { member_count: 3, open_rate: 0.5 } }],
      total_items: 1,
    });
    const result = await runToolContract(tool, { operation: 'list' });
    expect(result.structuredContent).toMatchObject({
      operation: 'list',
      totalItems: 1,
      audiences: [
        { id: 'aud1', name: 'Newsletter', webId: 7, stats: { memberCount: 3, openRate: 0.5 } },
      ],
    });
    expect(text(result)).toContain('**Newsletter** (`aud1`) webId:7');
  });

  it('list-growth: keeps only the numbers upstream sent', async () => {
    route('GET /lists/aud1/growth-history', {
      history: [
        { list_id: 'aud1', month: '2026-09', subscribed: 4, unsubscribed: 0 },
        { list_id: 'aud1', month: '2026-08', existing: 2, imports: 1, optins: 3, cleaned: 0 },
      ],
      total_items: 2,
    });
    const result = await runToolContract(tool, { operation: 'list-growth', audienceId: 'aud1' });
    expect(result.structuredContent).toMatchObject({
      totalItems: 2,
      growth: [
        { month: '2026-09', subscribed: 4, unsubscribed: 0 },
        { month: '2026-08', existing: 2, imports: 1, optins: 3, cleaned: 0 },
      ],
    });
    const growth = (result.structuredContent as { growth: object[] }).growth;
    expect(growth[0]).not.toHaveProperty('existing');
  });

  it('list-clients, list-abuse-reports, list-locations: mapped rows', async () => {
    route('GET /lists/aud1/clients', {
      clients: [{ client: 'Gmail', members: 9 }],
      total_items: 1,
    });
    route('GET /lists/aud1/abuse-reports', {
      abuse_reports: [
        {
          id: 5,
          campaign_id: 'c1',
          email_address: 'a@b.test',
          email_id: 'e',
          list_id: 'aud1',
          date: '2026-09-01',
        },
      ],
      total_items: 1,
    });
    route('GET /lists/aud1/locations', {
      locations: [{ country: 'United States', cc: 'US', total: 8, percent: 0.8 }],
      total_items: 1,
    });
    const clients = await runToolContract(tool, { operation: 'list-clients', audienceId: 'aud1' });
    expect(clients.structuredContent).toMatchObject({ clients: [{ client: 'Gmail', members: 9 }] });
    expect(text(clients)).toContain('- Gmail: 9 members');
    const abuse = await runToolContract(tool, {
      operation: 'list-abuse-reports',
      audienceId: 'aud1',
    });
    expect(abuse.structuredContent).toMatchObject({
      abuseReports: [{ id: 5, campaignId: 'c1', email: 'a@b.test', date: '2026-09-01' }],
    });
    expect(text(abuse)).toContain('- [id:5] `a@b.test` (campaignId: c1) at 2026-09-01');
    const locations = await runToolContract(tool, {
      operation: 'list-locations',
      audienceId: 'aud1',
    });
    expect(locations.structuredContent).toMatchObject({
      locations: [{ country: 'United States', cc: 'US', total: 8, percent: 0.8 }],
    });
    expect(text(locations)).toContain('- United States (cc: US): total 8 (80.0%)');
  });

  it('customize-signup-forms: renders the saved form as a json fence', async () => {
    route('POST /lists/aud1/signup-forms', { type: 'classic', header: { text: 'Hi' } });
    const result = await runToolContract(tool, {
      operation: 'customize-signup-forms',
      audienceId: 'aud1',
      signupFormConfig: { header: { text: 'Hi' } },
    });
    expect(result.structuredContent).toMatchObject({
      signupForm: { type: 'classic', header: { text: 'Hi' } },
    });
    expect(text(result)).toContain(
      `\`\`\`json\n${JSON.stringify({ type: 'classic', header: { text: 'Hi' } }, null, 2)}\n\`\`\``,
    );
  });
});

describe('list reads — filters and notice enrichment (#7)', () => {
  const PAGED = [
    ['list', 'GET /lists', { lists: [], total_items: 0 }],
    ['list-growth', 'GET /lists/aud1/growth-history', { history: [], total_items: 0 }],
    ['list-abuse-reports', 'GET /lists/aud1/abuse-reports', { abuse_reports: [], total_items: 0 }],
  ] as const;

  it.each(PAGED)(
    '%s echoes count and offset exactly as sent upstream',
    async (operation, key, body) => {
      route(key, body);
      const result = await runToolContract(tool, {
        operation,
        audienceId: 'aud1',
        count: '25',
        offset: 50,
      });
      expect(requests[0]?.query).toEqual({ count: '25', offset: '50' });
      expect((result.structuredContent as { filters: unknown }).filters).toEqual({
        count: 25,
        offset: 50,
      });
      expect(text(result)).toContain('**Filters:** count `25` · offset `50`');
    },
  );

  it('list with no inputs echoes the defaults', async () => {
    route('GET /lists', { lists: [CURRENT], total_items: 1 });
    const result = await runToolContract(tool, { operation: 'list' });
    expect((result.structuredContent as { filters: unknown }).filters).toEqual({
      count: 10,
      offset: 0,
    });
  });

  it.each([
    ['list-activity', 'GET /lists/aud1/activity', { activity: [] }],
    ['list-locations', 'GET /lists/aud1/locations', { locations: [], total_items: 0 }],
  ] as const)('%s echoes count only, never the dropped offset', async (operation, key, body) => {
    route(key, body);
    const result = await runToolContract(tool, { operation, audienceId: 'aud1', offset: 5 });
    expect(requests[0]?.query).toEqual({ count: '10' });
    expect((result.structuredContent as { filters: unknown }).filters).toEqual({ count: 10 });
    expect(text(result)).toContain('**Filters:** count `10`');
    expect(text(result)).not.toContain('offset `');
  });

  it.each([
    ['list-clients', 'GET /lists/aud1/clients', { clients: [], total_items: 0 }],
    ['get-signup-forms', 'GET /lists/aud1/signup-forms', { signup_forms: [], total_items: 0 }],
  ] as const)(
    '%s sends no query parameters and carries no filters',
    async (operation, key, body) => {
      route(key, body);
      const result = await runToolContract(tool, { operation, audienceId: 'aud1' });
      expect(requests[0]?.query).toEqual({});
      expect(result.structuredContent).not.toHaveProperty('filters');
      expect(text(result)).not.toContain('**Filters:**');
    },
  );

  const EMPTY = [
    ['list', 'GET /lists', { lists: [], total_items: 0 }, 'This account has no audiences.'],
    ['list-activity', 'GET /lists/aud1/activity', { activity: [] }, 'no daily activity'],
    [
      'list-growth',
      'GET /lists/aud1/growth-history',
      { history: [], total_items: 0 },
      'no monthly growth history',
    ],
    [
      'list-clients',
      'GET /lists/aud1/clients',
      { clients: [], total_items: 0 },
      'no email clients',
    ],
    [
      'list-abuse-reports',
      'GET /lists/aud1/abuse-reports',
      { abuse_reports: [], total_items: 0 },
      'No abuse reports',
    ],
    [
      'list-locations',
      'GET /lists/aud1/locations',
      { locations: [], total_items: 0 },
      'no subscriber locations',
    ],
    [
      'get-signup-forms',
      'GET /lists/aud1/signup-forms',
      { signup_forms: [], total_items: 0 },
      'no customized signup forms',
    ],
  ] as const;

  it.each(EMPTY)(
    '%s: an empty array yields one notice, once in content[] as a blockquote',
    async (operation, key, body, phrase) => {
      route(key, body);
      const result = await runToolContract(tool, { operation, audienceId: 'aud1' });
      const notice = (result.structuredContent as { notice?: string }).notice;
      expect(notice).toContain(phrase);
      const content = text(result);
      expect(content.split(phrase)).toHaveLength(2);
      const noticeLine = content.split('\n').find((line) => line.includes(phrase));
      expect(noticeLine?.startsWith('> ')).toBe(true);
      // A wrong audienceId 404s before any list returns, so an empty list never means a bad ID.
      expect(notice).not.toContain('Confirm `audienceId`');
    },
  );

  it('list-abuse-reports: the empty-state line no longer lives in format()', async () => {
    route('GET /lists/aud1/abuse-reports', { abuse_reports: [], total_items: 0 });
    const result = await runToolContract(tool, {
      operation: 'list-abuse-reports',
      audienceId: 'aud1',
    });
    expect(text(result)).not.toContain('_None — deliverability is healthy._');
  });

  it.each([
    ['list', 'GET /lists', { lists: [], total_items: 3 }, 'audiences'],
    ['list-growth', 'GET /lists/aud1/growth-history', { history: [], total_items: 3 }, 'months'],
    [
      'list-abuse-reports',
      'GET /lists/aud1/abuse-reports',
      { abuse_reports: [], total_items: 3 },
      'abuse reports',
    ],
  ] as const)(
    '%s: offset at or past a nonzero total gets the offset-past-end notice',
    async (operation, key, body, noun) => {
      route(key, body);
      for (const offset of [3, 7]) {
        const result = await runToolContract(tool, { operation, audienceId: 'aud1', offset });
        const sc = result.structuredContent as { notice?: string; totalItems?: number };
        expect(sc.notice).toBe(
          `No ${noun} on this page: \`offset\` is at or past \`totalItems\`. Lower \`offset\` to page back into the results.`,
        );
        expect(sc.totalItems).toBe(3);
      }
    },
  );

  it('an offset past a zero total keeps the no-matches notice', async () => {
    route('GET /lists/aud1/abuse-reports', { abuse_reports: [], total_items: 0 });
    const result = await runToolContract(tool, {
      operation: 'list-abuse-reports',
      audienceId: 'aud1',
      offset: 40,
    });
    expect((result.structuredContent as { notice?: string }).notice).toContain('No abuse reports');
  });

  it('a non-empty page carries no notice', async () => {
    route('GET /lists/aud1/clients', {
      clients: [{ client: 'Gmail', members: 1 }],
      total_items: 1,
    });
    const result = await runToolContract(tool, { operation: 'list-clients', audienceId: 'aud1' });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(text(result)).not.toMatch(/^> /m);
  });

  it('get and update populate neither filters nor notice', async () => {
    route('GET /lists/aud1', CURRENT);
    route('PATCH /lists/aud1', CURRENT);
    for (const input of [
      { operation: 'get' as const, audienceId: 'aud1' },
      { operation: 'update' as const, audienceId: 'aud1', name: 'x' },
    ]) {
      const result = await runToolContract(tool, input);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).not.toHaveProperty('filters');
      expect(result.structuredContent).not.toHaveProperty('notice');
    }
  });
});

describe('row rendering (#10)', () => {
  const ACTIVITY = [
    {
      day: '2026-10-29',
      emails_sent: 120,
      unique_opens: 40,
      recipient_clicks: 9,
      hard_bounce: 0,
      soft_bounce: 1,
      subs: 3,
      unsubs: 1,
      other_adds: 0,
      other_removes: 0,
    },
    { day: '2026-10-28', subs: 2, note: 'a|b `c`', memo: 'line one\nline two', extra: null },
  ];

  it('list-activity leads with `day`, renders every key, and moves a multi-line value below', async () => {
    route('GET /lists/aud1/activity', { activity: ACTIVITY });
    const result = await runToolContract(tool, { operation: 'list-activity', audienceId: 'aud1' });
    expect((result.structuredContent as { activity: unknown }).activity).toEqual([
      {
        day: '2026-10-29',
        emailsSent: 120,
        uniqueOpens: 40,
        recipientClicks: 9,
        hardBounce: 0,
        softBounce: 1,
        subs: 3,
        unsubs: 1,
        otherAdds: 0,
        otherRemoves: 0,
      },
      { day: '2026-10-28', subs: 2, note: 'a|b `c`', memo: 'line one\nline two', extra: null },
    ]);
    const [block] = result.content as Array<{ type: string; text?: string }>;
    expect(block?.text).toBe(
      [
        'Operation: list-activity',
        '',
        '',
        '# Per-day activity (2 days)',
        '',
        '| day | emailsSent | uniqueOpens | recipientClicks | hardBounce | softBounce | subs | unsubs | otherAdds | otherRemoves | note | memo | extra |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| 2026-10-29 | 120 | 40 | 9 | 0 | 1 | 3 | 1 | 0 | 0 |  |  |  |',
        '| 2026-10-28 |  |  |  |  |  | 2 |  |  |  | a\\|b \\`c\\` | (below) | null |',
        '',
        '**Row 2 · memo:** line one\\',
        'line two',
      ].join('\n'),
    );
  });

  it('the GFM cell split detects a raw pipe as a broken row', () => {
    expect(cells('| a | b|c |')).toHaveLength(3);
    expect(cells('| a | b\\|c |')).toHaveLength(2);
  });

  it('list-activity with zero rows renders the header and no table', async () => {
    route('GET /lists/aud1/activity', { activity: [] });
    const result = await runToolContract(tool, { operation: 'list-activity', audienceId: 'aud1' });
    const content = text(result);
    expect(content).toContain('# Per-day activity (0 days)');
    expect(content).not.toMatch(/^\|/m);
  });

  it('list-growth renders an absent count as an empty cell, not 0', async () => {
    route('GET /lists/aud1/growth-history', {
      history: [{ list_id: 'aud1', month: '2026-09', subscribed: 4, unsubscribed: 0 }],
      total_items: 1,
    });
    const result = await runToolContract(tool, { operation: 'list-growth', audienceId: 'aud1' });
    const row = text(result)
      .split('\n')
      .find((line) => line.startsWith('| 2026-09'));
    expect(row).toBeDefined();
    expect(cells(row ?? '')).toEqual(['2026-09', '4', '0', '', '', '', '']);
  });

  it('list-growth with zero months renders the header and no table', async () => {
    route('GET /lists/aud1/growth-history', { history: [], total_items: 0 });
    const result = await runToolContract(tool, { operation: 'list-growth', audienceId: 'aud1' });
    expect(text(result)).toContain('# Growth history (0 months)');
    expect(text(result)).not.toMatch(/^\|/m);
  });

  it('get-signup-forms renders one json fence per form, longer than any backtick run', async () => {
    const forms = [
      { type: 'classic', header: { text: 'Join ````now````' }, contents: [] },
      { type: 'embedded', styles: [{ selector: 'page_label', options: [] }] },
    ];
    route('GET /lists/aud1/signup-forms', { signup_forms: forms, total_items: 2 });
    const result = await runToolContract(tool, {
      operation: 'get-signup-forms',
      audienceId: 'aud1',
    });
    expect((result.structuredContent as { signupForms: unknown }).signupForms).toEqual(forms);
    const content = text(result);
    expect(content).not.toMatch(/^- \{/m);
    expect(content).toContain(`\`\`\`\`\`json\n${JSON.stringify(forms[0], null, 2)}\n\`\`\`\`\``);
    expect(content).toContain(`\`\`\`json\n${JSON.stringify(forms[1], null, 2)}\n\`\`\``);
    expect(content.match(/^`{3,}json$/gm)).toHaveLength(2);
  });
});
