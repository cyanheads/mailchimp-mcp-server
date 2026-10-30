/**
 * @fileoverview `mailchimp_subscribers` list reads end to end through the real
 * service with a stubbed `fetch`: the query each branch sends upstream, the
 * `structuredContent` rows, the `filters` / `notice` enrichment, and the
 * Markdown tables `format()` renders for activity, events, and goals.
 * @module tests/tools/mailchimp-subscribers.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpSubscribersTool as tool } from '@/mcp-server/tools/definitions/mailchimp-subscribers.tool.js';
import {
  MailchimpService,
  mailchimpMemberHash,
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

const email = 'ada@example.com';
const hash = mailchimpMemberHash(email);
const memberPath = `/3.0/lists/a/members/${hash}`;

/** Upstream bodies keyed by request path; the stub records every URL it serves. */
let routes: Map<string, unknown>;
let requested: URL[];

beforeEach(() => {
  routes = new Map();
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      requested.push(url);
      const body = routes.get(url.pathname);
      if (body === undefined) throw new Error(`unrouted ${url.pathname}`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
});

afterEach(() => {
  setMailchimpServiceForTesting(undefined);
  vi.unstubAllGlobals();
});

type Result = Awaited<ReturnType<typeof runToolContract>>;
const lastQuery = () => Object.fromEntries(requested.at(-1)?.searchParams ?? []);
const text = (result: Result) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
/** One top-level `structuredContent` field, untyped — the SDK types the object as `{}`. */
const field = (result: Result, key: string): unknown =>
  (result.structuredContent as Record<string, unknown> | undefined)?.[key];

/** The `format()` text alone — `content[0]`, before the enrichment trailer. */
const formatOf = (result: Result): string => {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('content[0] is not text');
  return block.text;
};

/** The Markdown table lines (header, delimiter, rows) in `markdown`, in order. */
const tableLines = (markdown: string): string[] =>
  markdown.split('\n').filter((line) => line.startsWith('|'));

describe('list reads — structuredContent and upstream query', () => {
  it('list sends count/offset/status and summarizes members', async () => {
    routes.set('/3.0/lists/a/members', {
      members: [{ id: hash, email_address: email, status: 'subscribed', full_name: 'Ada L' }],
      total_items: 7,
    });
    const result = await runToolContract(tool, {
      operation: 'list',
      audienceId: 'a',
      status: 'subscribed',
      count: 5,
      offset: 2,
    });
    expect(lastQuery()).toEqual({ count: '5', offset: '2', status: 'subscribed' });
    expect(result.structuredContent).toMatchObject({
      operation: 'list',
      totalItems: 7,
      subscribers: [{ id: hash, email, status: 'subscribed', fullName: 'Ada L' }],
    });
  });

  it('list-tags, list-notes, list-events send count/offset with defaults', async () => {
    routes.set(`${memberPath}/tags`, {
      tags: [{ id: 3, name: 'vip', date_added: '2026-01-01' }],
      total_items: 1,
    });
    routes.set(`${memberPath}/notes`, {
      notes: [{ id: 9, note: 'hi', created_at: '2026-01-02' }],
      total_items: 1,
    });
    routes.set(`${memberPath}/events`, {
      events: [{ name: 'purchased', occurred_at: '2026-01-03', properties: { sku: 'A' } }],
      total_items: 1,
    });
    const tags = await runToolContract(tool, { operation: 'list-tags', audienceId: 'a', email });
    expect(lastQuery()).toEqual({ count: '20', offset: '0' });
    expect(tags.structuredContent).toMatchObject({
      totalItems: 1,
      tagsActive: [{ id: 3, name: 'vip', dateAdded: '2026-01-01' }],
    });
    const notes = await runToolContract(tool, { operation: 'list-notes', audienceId: 'a', email });
    expect(lastQuery()).toEqual({ count: '20', offset: '0' });
    expect(notes.structuredContent).toMatchObject({
      totalItems: 1,
      notes: [{ id: 9, note: 'hi', createdAt: '2026-01-02' }],
    });
    const events = await runToolContract(tool, {
      operation: 'list-events',
      audienceId: 'a',
      email,
      count: 50,
    });
    expect(lastQuery()).toEqual({ count: '50', offset: '0' });
    expect(events.structuredContent).toMatchObject({
      totalItems: 1,
      events: [{ name: 'purchased', occurredAt: '2026-01-03', properties: { sku: 'A' } }],
    });
  });

  it('list-activity sends count/offset; list-goals sends no query', async () => {
    routes.set(`${memberPath}/activity-feed`, {
      activity: [
        {
          activity_type: 'click',
          created_at_timestamp: '2026-02-01T00:00:00+00:00',
          campaign_id: 'c1',
          campaign_title: 'Spring',
          link_clicked: 'https://example.com/a',
        },
      ],
    });
    routes.set(`${memberPath}/goals`, {
      goals: [{ goal_id: 4, event: 'visit', last_visited_at: '2026-02-02', data: 'x' }],
      total_items: 1,
    });
    const activity = await runToolContract(tool, {
      operation: 'list-activity',
      audienceId: 'a',
      email,
      offset: 10,
    });
    expect(lastQuery()).toEqual({ count: '20', offset: '10' });
    // The activity-feed endpoint carries no `total_items`, so none is reported.
    expect(field(activity, 'totalItems')).toBeUndefined();
    expect(activity.structuredContent).toMatchObject({
      activity: [
        {
          activityType: 'click',
          createdAtTimestamp: '2026-02-01T00:00:00+00:00',
          campaignId: 'c1',
          campaignTitle: 'Spring',
          linkClicked: 'https://example.com/a',
        },
      ],
    });
    const goals = await runToolContract(tool, { operation: 'list-goals', audienceId: 'a', email });
    expect(lastQuery()).toEqual({});
    expect(goals.structuredContent).toMatchObject({
      totalItems: 1,
      goals: [{ goalId: 4, event: 'visit', lastVisitedAt: '2026-02-02', data: 'x' }],
    });
  });
});

/**
 * Blockquote lines in the enrichment trailer — the `content[]` blocks after the
 * one `format()` returns — plus a check that the notice text appears nowhere
 * else in `content[]`.
 */
const quoteLines = (result: Awaited<ReturnType<typeof runToolContract>>) => {
  const notice = field(result, 'notice');
  if (typeof notice === 'string') expect(text(result).split(notice)).toHaveLength(2);
  return result.content
    .slice(1)
    .flatMap((block) => (block.type === 'text' ? block.text.split('\n') : []))
    .filter((line) => line.startsWith('>'));
};

describe('filters and notice enrichment', () => {
  const sub = { id: hash, email_address: email, status: 'subscribed' };

  it('non-empty list echoes the sent query on both surfaces and carries no notice', async () => {
    routes.set('/3.0/lists/a/members', { members: [sub], total_items: 7 });
    const result = await runToolContract(tool, {
      operation: 'list',
      audienceId: 'a',
      status: 'subscribed',
      count: 5,
      offset: 2,
    });
    expect(field(result, 'filters')).toEqual({ count: 5, offset: 2, status: 'subscribed' });
    expect(lastQuery()).toEqual({ count: '5', offset: '2', status: 'subscribed' });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(text(result)).toContain('**Filters:** count `5` · offset `2` · status `subscribed`');
    expect(quoteLines(result)).toEqual([]);
  });

  it('empty list with a status filter names the filter and a next step, once', async () => {
    routes.set('/3.0/lists/a/members', { members: [], total_items: 0 });
    const result = await runToolContract(tool, {
      operation: 'list',
      audienceId: 'a',
      status: 'cleaned',
    });
    expect(field(result, 'filters')).toEqual({ count: 20, offset: 0, status: 'cleaned' });
    const notice = field(result, 'notice');
    expect(notice).toBe(
      'No subscribers matched `status`. Drop `status` or choose another value to page the rest of the audience.',
    );
    expect(quoteLines(result)).toEqual([`> ${notice}`]);
    expect(field(result, 'totalItems')).toBe(0);
  });

  it('empty unfiltered list reports an empty audience', async () => {
    routes.set('/3.0/lists/a/members', { members: [], total_items: 0 });
    const result = await runToolContract(tool, { operation: 'list', audienceId: 'a' });
    expect(field(result, 'filters')).toEqual({ count: 20, offset: 0 });
    expect(field(result, 'notice')).toBe(
      'This audience has no members. Add one with `mailchimp_upsert_subscriber` or a batch with `mailchimp_import_subscribers`.',
    );
  });

  it.each([
    ['list', '/3.0/lists/a/members', { members: [], total_items: 7 }, 'subscribers'],
    ['list-tags', `${memberPath}/tags`, { tags: [], total_items: 3 }, 'tags'],
    ['list-notes', `${memberPath}/notes`, { notes: [], total_items: 3 }, 'notes'],
    ['list-events', `${memberPath}/events`, { events: [], total_items: 3 }, 'events'],
  ] as const)(
    '%s offset at or past totalItems gets the offset-past-end notice',
    async (operation, path, body, noun) => {
      routes.set(path, body);
      const result = await runToolContract(tool, {
        operation,
        audienceId: 'a',
        email: operation === 'list' ? undefined : email,
        offset: body.total_items,
      });
      expect(field(result, 'filters')).toEqual({ count: 20, offset: body.total_items });
      expect(field(result, 'notice')).toBe(
        `No ${noun} on this page: \`offset\` is at or past \`totalItems\`. Lower \`offset\` to page back into the results.`,
      );
      expect(field(result, 'totalItems')).toBe(body.total_items);
      expect(quoteLines(result)).toHaveLength(1);
    },
  );

  it.each([
    [
      'list-tags',
      `${memberPath}/tags`,
      { tags: [], total_items: 0 },
      'This subscriber has no active tags. Add some with `operation: set-tags`.',
    ],
    [
      'list-notes',
      `${memberPath}/notes`,
      { notes: [], total_items: 0 },
      'This subscriber has no notes. Add one with `operation: add-note`.',
    ],
    [
      'list-events',
      `${memberPath}/events`,
      { events: [], total_items: 0 },
      'No custom events are recorded for this subscriber. Integrations post them through the Mailchimp events API; `list-activity` holds campaign engagement.',
    ],
    [
      'list-activity',
      `${memberPath}/activity-feed`,
      { activity: [] },
      'No activity is recorded for this subscriber. Entries appear once a campaign is sent to them or they sign up, open, click, or unsubscribe.',
    ],
  ] as const)(
    '%s empty first page: filters with defaults and one notice',
    async (operation, path, body, notice) => {
      routes.set(path, body);
      const result = await runToolContract(tool, { operation, audienceId: 'a', email });
      expect(field(result, 'filters')).toEqual({ count: 20, offset: 0 });
      expect(field(result, 'notice')).toBe(notice);
      expect(quoteLines(result)).toEqual([`> ${notice}`]);
    },
  );

  it('list-activity past offset 0 with no upstream total says the total is unknown', async () => {
    routes.set(`${memberPath}/activity-feed`, { activity: [] });
    const result = await runToolContract(tool, {
      operation: 'list-activity',
      audienceId: 'a',
      email,
      offset: 40,
    });
    expect(field(result, 'filters')).toEqual({ count: 20, offset: 40 });
    expect(field(result, 'notice')).toBe(
      'No activity on this page. The activity feed reports no total, so `offset` may be past the end: retry with `offset: 0`.',
    );
  });

  it('list-goals sends no query, so it omits filters; empty goals get a notice', async () => {
    routes.set(`${memberPath}/goals`, { goals: [], total_items: 0 });
    const result = await runToolContract(tool, {
      operation: 'list-goals',
      audienceId: 'a',
      email,
      count: 5,
    });
    expect(lastQuery()).toEqual({});
    expect(result.structuredContent).not.toHaveProperty('filters');
    expect(text(result)).not.toContain('**Filters:**');
    expect(field(result, 'notice')).toBe(
      'No goal events are recorded for this subscriber. Goal events come from the Mailchimp Goal tracking script on your site.',
    );
  });

  it.each([
    ['list-tags', `${memberPath}/tags`, { tags: [{ id: 1, name: 't' }], total_items: 1 }],
    ['list-notes', `${memberPath}/notes`, { notes: [{ id: 1, note: 'n' }], total_items: 1 }],
    ['list-goals', `${memberPath}/goals`, { goals: [{ goal_id: 1 }], total_items: 1 }],
  ] as const)('%s with rows carries no notice', async (operation, path, body) => {
    routes.set(path, body);
    const result = await runToolContract(tool, { operation, audienceId: 'a', email });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(quoteLines(result)).toEqual([]);
  });

  it('non-list operations populate neither field', async () => {
    routes.set(memberPath, sub);
    const result = await runToolContract(tool, { operation: 'get', audienceId: 'a', email });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('filters');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });
});

describe('format() — activity, events, goals as Markdown tables', () => {
  const activityRows = [
    {
      link_clicked: 'https://example.com/a?x=1',
      campaign_title: 'Spring',
      campaign_id: 'c1',
      created_at_timestamp: '2026-02-01T00:00:00+00:00',
      activity_type: 'click',
    },
    {
      activity_type: 'conversation',
      created_at_timestamp: '2026-02-02T00:00:00+00:00',
      campaign_id: 'c2',
      campaign_title: 'Reply thread',
      message_text: 'line one\n- line two',
    },
  ];

  it('activity leads with its documented columns and moves a multi-line value below', async () => {
    routes.set(`${memberPath}/activity-feed`, { activity: activityRows });
    const result = await runToolContract(tool, {
      operation: 'list-activity',
      audienceId: 'a',
      email,
    });
    expect(formatOf(result)).toBe(
      [
        'Operation: list-activity',
        '',
        '',
        '# Activity (2 events)',
        '',
        '| activityType | createdAtTimestamp | campaignId | campaignTitle | linkClicked | messageText |',
        '| --- | --- | --- | --- | --- | --- |',
        '| click | 2026-02-01T00:00:00+00:00 | c1 | Spring | https://example.com/a?x=1 |  |',
        '| conversation | 2026-02-02T00:00:00+00:00 | c2 | Reply thread |  | (below) |',
        '',
        '**Row 2 · messageText:** line one\\',
        '\\- line two',
      ].join('\n'),
    );
  });

  it('events and goals render tables led by their documented keys', async () => {
    routes.set(`${memberPath}/events`, {
      events: [
        {
          name: 'purchased',
          occurred_at: '2026-01-03',
          properties: { sku: 'A' },
          is_syncing: false,
        },
      ],
      total_items: 1,
    });
    routes.set(`${memberPath}/goals`, {
      goals: [{ goal_id: 4, event: 'visit', last_visited_at: '2026-02-02', data: '*x*' }],
      total_items: 1,
    });
    const events = text(
      await runToolContract(tool, { operation: 'list-events', audienceId: 'a', email }),
    );
    expect(tableLines(events)).toEqual([
      '| name | occurredAt | properties | isSyncing |',
      '| --- | --- | --- | --- |',
      '| purchased | 2026-01-03 | {"sku":"A"} | false |',
    ]);
    const goals = text(
      await runToolContract(tool, { operation: 'list-goals', audienceId: 'a', email }),
    );
    expect(tableLines(goals)).toEqual([
      '| goalId | event | lastVisitedAt | data |',
      '| --- | --- | --- | --- |',
      '| 4 | visit | 2026-02-02 | \\*x\\* |',
    ]);
  });

  it.each([
    ['list-activity', `${memberPath}/activity-feed`, { activity: [] }, '# Activity (0 events)'],
    ['list-events', `${memberPath}/events`, { events: [], total_items: 0 }, '# Events (0)'],
    ['list-goals', `${memberPath}/goals`, { goals: [], total_items: 0 }, '# Goals (0)'],
  ] as const)(
    '%s with zero rows renders the count header and no table',
    async (operation, path, body, header) => {
      routes.set(path, body);
      const md = text(await runToolContract(tool, { operation, audienceId: 'a', email }));
      expect(md).toContain(header);
      expect(md.split('\n').filter((line) => line.startsWith('|'))).toEqual([]);
    },
  );

  it('row-shape descriptions name the camelCase keys rows carry', () => {
    const shape = tool.output.shape;
    expect(shape.activity.description).toMatch(/activityType.*createdAtTimestamp.*campaignId/);
    expect(shape.activity.description).not.toMatch(/campaign_id|parent_campaign/);
    expect(shape.events.description).toMatch(/name.*occurredAt.*properties/);
    expect(shape.events.description).not.toMatch(/occurred_at|is_syncing/);
    expect(shape.goals.description).toMatch(/goalId.*event.*lastVisitedAt.*data/);
    expect(shape.goals.description).not.toMatch(/goal_id|last_visited_at/);
  });
});
