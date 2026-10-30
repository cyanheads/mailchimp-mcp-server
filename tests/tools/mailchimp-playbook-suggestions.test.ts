/**
 * @fileoverview Contract tests for `mailchimp_playbook` follow-up suggestions —
 * every topic driven through `runToolContract` against a real
 * `MailchimpService` with a stubbed `fetch`.
 * @module tests/tools/mailchimp-playbook-suggestions.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { mailchimpPlaybookTool } from '@/mcp-server/tools/definitions/mailchimp-playbook.tool.js';
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

type Routes = Record<string, unknown>;

/** Serve each upstream path (after `/3.0`) from `routes`; anything else is a 404. */
function stubFetch(routes: Routes): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname.replace(/^\/3\.0/, '');
    if (Object.hasOwn(routes, path)) {
      return new Response(JSON.stringify(routes[path]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ title: 'Resource Not Found', status: 404 }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const AUDIENCE = {
  id: 'aud1',
  name: 'Main List',
  stats: { member_count: 120, open_rate: 0.31, click_rate: 0.04, cleaned_count: 2 },
};
const SENT_REPORT = {
  id: 'cmp1',
  campaign_title: 'October issue',
  list_id: 'aud1',
  list_is_active: true,
  send_time: '2026-10-01T15:00:00+00:00',
  emails_sent: 118,
  opens: { open_rate: 0.3 },
  clicks: { click_rate: 0.05 },
};

interface Scenario {
  input: z.input<typeof mailchimpPlaybookTool.input>;
  name: string;
  routes: Routes;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'onboarding',
    input: { topic: 'onboarding' },
    routes: { '/': { account_name: 'Acme', pricing_plan_type: 'monthly', total_subscribers: 120 } },
  },
  {
    name: 'send',
    input: { topic: 'send', audienceId: 'aud1' },
    routes: { '/lists/aud1': AUDIENCE, '/lists/aud1/growth-history': { history: [] } },
  },
  {
    name: 'post-send-review (sent)',
    input: { topic: 'post-send-review', campaignId: 'cmp1' },
    routes: { '/reports/cmp1': SENT_REPORT },
  },
  {
    name: 'deliverability (recent reports)',
    input: { topic: 'deliverability' },
    routes: { '/reports': { reports: [SENT_REPORT], total_items: 1 } },
  },
  {
    name: 'post-send-review (unsent)',
    input: { topic: 'post-send-review', campaignId: 'cmp2' },
    routes: { '/reports/cmp2': { id: 'cmp2', campaign_title: 'Draft issue', emails_sent: 0 } },
  },
  {
    name: 'deliverability (no reports)',
    input: { topic: 'deliverability' },
    routes: { '/reports': { reports: [], total_items: 0 } },
  },
  {
    name: 'deliverability (latest audience deleted)',
    input: { topic: 'deliverability' },
    routes: {
      '/reports': {
        reports: [{ ...SENT_REPORT, id: 'cmp3', list_id: 'aud7', list_is_active: false }],
        total_items: 1,
      },
    },
  },
  {
    name: 'deliverability (sparse latest report)',
    input: { topic: 'deliverability' },
    routes: { '/reports': { reports: [{ id: 'cmp4' }], total_items: 1 } },
  },
  {
    name: 'list-hygiene',
    input: { topic: 'list-hygiene', audienceId: 'aud1' },
    routes: { '/lists/aud1': AUDIENCE },
  },
  {
    name: 'subscriber-triage (match)',
    input: { topic: 'subscriber-triage', email: 'ada@example.com' },
    routes: {
      '/search-members': {
        exact_matches: {
          members: [
            { id: 'h1', email_address: 'ada@example.com', list_id: 'aud1', status: 'subscribed' },
          ],
          total_items: 1,
        },
        full_search: { members: [], total_items: 0 },
      },
    },
  },
  {
    name: 'subscriber-triage (no match, caller audience)',
    input: { topic: 'subscriber-triage', email: 'nobody@example.com', audienceId: 'aud9' },
    routes: {
      '/search-members': {
        exact_matches: { members: [], total_items: 0 },
        full_search: { members: [], total_items: 0 },
      },
    },
  },
  {
    name: 'subscriber-triage (no match, no audience)',
    input: { topic: 'subscriber-triage', email: 'nobody@example.com' },
    routes: {
      '/search-members': {
        exact_matches: { members: [], total_items: 0 },
        full_search: { members: [], total_items: 0 },
      },
    },
  },
  {
    name: 'design-campaign',
    input: { topic: 'design-campaign', audienceId: 'aud1' },
    routes: { '/lists/aud1': AUDIENCE, '/lists/aud1/growth-history': { history: [] } },
  },
];

async function runPlaybook(scenario: Scenario): Promise<Record<string, unknown>> {
  stubFetch(scenario.routes);
  const result = await runToolContract(mailchimpPlaybookTool, scenario.input);
  expect(result.isError).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

describe('mailchimp_playbook suggestions — per-topic values', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  /** [target tool, reason, pre-filled arguments] for every entry, in order. */
  const EXPECTED: Record<string, Array<[string, string, Record<string, unknown>]>> = {
    // The `mailchimp_audience_overview` entry is gone: it needs an audienceId onboarding never has.
    onboarding: [['mailchimp_audiences', 'See what audiences exist', { operation: 'list' }]],
    send: [
      [
        'mailchimp_templates',
        'See saved templates before drafting',
        { operation: 'list', type: 'user' },
      ],
      [
        'mailchimp_send_campaign',
        'Draft the campaign and run the send-checklist',
        { audienceId: 'aud1', mode: 'draft' },
      ],
    ],
    'post-send-review (sent)': [
      [
        'mailchimp_campaign_report',
        'Full digest with top links, locations, recent unsubs, benchmarks',
        { campaignId: 'cmp1' },
      ],
      [
        'mailchimp_reports',
        'Drill into advice from Mailchimp',
        { operation: 'slice', campaignId: 'cmp1', dimension: 'advice' },
      ],
    ],
    'deliverability (recent reports)': [
      [
        'mailchimp_reports',
        'Get Mailchimp-generated advice for the most recent campaign',
        { operation: 'slice', campaignId: 'cmp1', dimension: 'advice' },
      ],
      // `list-hygiene` requires an audience: the latest report's list_id.
      [
        'mailchimp_playbook',
        'If bounce rate is high, plan list hygiene',
        { topic: 'list-hygiene', audienceId: 'aud1' },
      ],
    ],
    // An unsent campaign has no report, so the report calls would fail with `campaign_not_sent`.
    'post-send-review (unsent)': [
      [
        'mailchimp_campaigns',
        'This campaign has not been sent, so it has no report; inspect the draft',
        { operation: 'get', campaignId: 'cmp2' },
      ],
    ],
    // No report names an audience, so the `list-hygiene` entry is dropped.
    'deliverability (no reports)': [
      [
        'mailchimp_reports',
        'Get Mailchimp-generated advice for the most recent campaign',
        { operation: 'list' },
      ],
    ],
    'deliverability (latest audience deleted)': [
      [
        'mailchimp_reports',
        'Get Mailchimp-generated advice for the most recent campaign',
        { operation: 'slice', campaignId: 'cmp3', dimension: 'advice' },
      ],
    ],
    'deliverability (sparse latest report)': [
      [
        'mailchimp_reports',
        'Get Mailchimp-generated advice for the most recent campaign',
        { operation: 'slice', campaignId: 'cmp4', dimension: 'advice' },
      ],
    ],
    'list-hygiene': [
      [
        'mailchimp_subscribers',
        'Pull cleaned subscribers for review',
        { operation: 'list', audienceId: 'aud1', status: 'cleaned', count: 50 },
      ],
      [
        'mailchimp_audiences',
        'Check long-term growth trend for patterns',
        { operation: 'list-growth', audienceId: 'aud1', count: 12 },
      ],
    ],
    'subscriber-triage (match)': [
      [
        'mailchimp_find_subscriber',
        'Full record with tags, merge fields, stats',
        { email: 'ada@example.com' },
      ],
      [
        'mailchimp_subscribers',
        'Recent activity (opens, clicks)',
        { operation: 'list-activity', audienceId: 'aud1', email: 'ada@example.com', count: 20 },
      ],
    ],
    'subscriber-triage (no match, caller audience)': [
      [
        'mailchimp_upsert_subscriber',
        'Create the subscriber if they should be here',
        { email: 'nobody@example.com', audienceId: 'aud9', status: 'pending' },
      ],
    ],
    // The upsert requires an audienceId; neither the caller nor the search supplied one.
    'subscriber-triage (no match, no audience)': [],
    'design-campaign': [
      [
        'mailchimp_audience_overview',
        'Refresh audience state (growth, clients, merge-field schema)',
        { audienceId: 'aud1' },
      ],
      [
        'mailchimp_templates',
        'Browse saved templates before drafting from scratch',
        { operation: 'list', type: 'user' },
      ],
      [
        'mailchimp_send_campaign',
        'Start the draft once design is settled',
        { audienceId: 'aud1', mode: 'draft' },
      ],
    ],
  };

  it.each(SCENARIOS)('$name keeps its target tools, reasons, and argument values', async (s) => {
    const out = await runPlaybook(s);
    expect(suggestionCalls(out).map((c) => [c.toolName, c.reason, c.args])).toEqual(
      EXPECTED[s.name],
    );
  });
});

/** The `nextToolSuggestions` entries, each checked to carry exactly `toolName`, `reason`, `args`. */
function suggestionCalls(
  out: Record<string, unknown>,
): Array<{ toolName: string; reason: string; args: Record<string, unknown> }> {
  const entries = out.nextToolSuggestions as Array<{
    toolName: string;
    reason: string;
    args: Record<string, unknown>;
  }>;
  for (const e of entries) expect(Object.keys(e).sort()).toEqual(['args', 'reason', 'toolName']);
  return entries;
}

const TOOLS_BY_NAME = new Map(allToolDefinitions.map((d) => [d.name, d]));
/** Registered only when their env var is set (see the definitions barrel). */
const CONDITIONAL_TOOLS = new Set(['mailchimp_assets', 'mailchimp_local_templates']);
/**
 * Fields only the agent can compose (campaign copy and content). Suggestions are
 * pre-fills and never carry these; they are filled with placeholders so the
 * check below exercises everything else the target requires.
 */
const CALLER_COMPOSED: Record<string, Record<string, unknown>> = {
  mailchimp_send_campaign: {
    subject: 'Placeholder subject',
    fromName: 'Placeholder sender',
    replyTo: 'sender@example.com',
    content: { html: '<p>placeholder</p>' },
  },
};

describe('mailchimp_playbook suggestions — every entry is a callable invocation', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  /**
   * Runs each suggested call through the target tool's real contract with an
   * upstream that 404s everything. A call that carries every field its target
   * requires — schema- or handler-level — gets past argument checks and reaches
   * the upstream; one that omits a required field is rejected before any fetch.
   */
  it.each(SCENARIOS)('$name suggests only calls that reach the upstream', async (s) => {
    const out = await runPlaybook(s);
    for (const call of suggestionCalls(out)) {
      expect(CONDITIONAL_TOOLS.has(call.toolName), call.toolName).toBe(false);
      const target = TOOLS_BY_NAME.get(call.toolName) as AnyToolDefinition | undefined;
      expect(target, `${call.toolName} is not a registered tool`).toBeDefined();
      if (!target) continue;

      const upstream = stubFetch({});
      const result = await runToolContract(target, {
        ...CALLER_COMPOSED[call.toolName],
        ...call.args,
      } as never);
      const error = (result.structuredContent as { error?: { code: number; message: string } })
        ?.error;
      const label = `${call.toolName} ${JSON.stringify(call.args)} → ${error?.message ?? 'ok'}`;
      expect(
        [JsonRpcErrorCode.InvalidParams, JsonRpcErrorCode.ValidationError],
        label,
      ).not.toContain(error?.code);
      expect(upstream.mock.calls.length, label).toBeGreaterThan(0);
    }
  });
});

describe('mailchimp_playbook resourceSuggestions', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  /** [uri, reason] per entry; IDs are the ones each scenario's upstream returned. */
  const EXPECTED: Record<string, Array<[string, string]>> = {
    onboarding: [],
    send: [
      [
        'mailchimp://audiences/aud1',
        'Audience snapshot for the send target: stats, contact, campaign defaults',
      ],
    ],
    'post-send-review (sent)': [
      ['mailchimp://campaigns/cmp1/report', 'Headline report metrics for this campaign'],
    ],
    // The report resource rejects a campaign with no send_time.
    'post-send-review (unsent)': [],
    'deliverability (recent reports)': [
      ['mailchimp://campaigns/cmp1/report', 'Headline report metrics for the most recent campaign'],
    ],
    'deliverability (no reports)': [],
    'deliverability (latest audience deleted)': [
      ['mailchimp://campaigns/cmp3/report', 'Headline report metrics for the most recent campaign'],
    ],
    'deliverability (sparse latest report)': [],
    'list-hygiene': [
      [
        'mailchimp://audiences/aud1',
        'Audience snapshot: member, cleaned, and unsubscribe counts, double-opt-in status',
      ],
    ],
    'subscriber-triage (match)': [
      ['mailchimp://audiences/aud1', "Snapshot of the top match's audience"],
    ],
    // `aud9` came only from the caller's input, never from a fetch.
    'subscriber-triage (no match, caller audience)': [],
    'subscriber-triage (no match, no audience)': [],
    'design-campaign': [
      [
        'mailchimp://audiences/aud1',
        'Audience snapshot: contact details and campaign defaults (from-name, from-email)',
      ],
    ],
  };

  const TEMPLATES = allResourceDefinitions.map(
    (d) => new RegExp(`^${d.uriTemplate.replace(/\{[^}]+\}/g, '[^/{}]+')}$`),
  );

  it('covers every scenario', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  it.each(SCENARIOS)('$name suggests resources from fetched IDs only', async (s) => {
    const out = await runPlaybook(s);
    const entries = out.resourceSuggestions as Array<{ uri: string; reason: string }>;
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(['reason', 'uri']);
      expect(
        TEMPLATES.some((t) => t.test(e.uri)),
        `${e.uri} matches no resource`,
      ).toBe(true);
    }
    expect(entries.map((e) => [e.uri, e.reason])).toEqual(EXPECTED[s.name]);
  });
});

describe('mailchimp_playbook output schema', () => {
  it('requires args on every nextToolSuggestions entry and resourceSuggestions on the result', () => {
    const base = {
      topic: 'onboarding',
      instructions: '# x',
      liveState: {},
      nextToolSuggestions: [{ toolName: 'mailchimp_audiences', reason: 'r', args: {} }],
      resourceSuggestions: [],
    };
    expect(mailchimpPlaybookTool.output.safeParse(base).success).toBe(true);
    expect(
      mailchimpPlaybookTool.output.safeParse({
        ...base,
        nextToolSuggestions: [{ toolName: 'mailchimp_audiences', reason: 'r' }],
      }).success,
    ).toBe(false);
    const { resourceSuggestions: _omitted, ...withoutResources } = base;
    expect(mailchimpPlaybookTool.output.safeParse(withoutResources).success).toBe(false);
  });
});

describe('mailchimp_playbook content[] rendering', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  async function contentText(name: string): Promise<string> {
    const scenario = SCENARIOS.find((s) => s.name === name);
    if (!scenario) throw new Error(`no scenario ${name}`);
    stubFetch(scenario.routes);
    const result = await runToolContract(mailchimpPlaybookTool, scenario.input);
    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);
    return (result.content[0] as { text: string }).text;
  }

  const tail = (text: string, heading: string): string => text.slice(text.indexOf(heading));

  it('renders every suggestion and resource with its toolName, reason, args, and uri', async () => {
    const text = await contentText('post-send-review (sent)');
    expect(tail(text, '## Suggested next calls')).toBe(
      [
        '## Suggested next calls',
        '',
        '- **`mailchimp_campaign_report`** — Full digest with top links, locations, recent unsubs, benchmarks',
        '  args:',
        '  ```json',
        '  {"campaignId":"cmp1"}',
        '  ```',
        '- **`mailchimp_reports`** — Drill into advice from Mailchimp',
        '  args:',
        '  ```json',
        '  {"operation":"slice","campaignId":"cmp1","dimension":"advice"}',
        '  ```',
        '',
        '## Suggested resources',
        '',
        '- `mailchimp://campaigns/cmp1/report` — Headline report metrics for this campaign',
      ].join('\n'),
    );
  });

  it('renders the deliverability audience pre-fill and omits the resources section when empty', async () => {
    const text = await contentText('deliverability (no reports)');
    expect(tail(text, '## Suggested next calls')).toBe(
      [
        '## Suggested next calls',
        '',
        '- **`mailchimp_reports`** — Get Mailchimp-generated advice for the most recent campaign',
        '  args:',
        '  ```json',
        '  {"operation":"list"}',
        '  ```',
      ].join('\n'),
    );
    const withAudience = await contentText('deliverability (recent reports)');
    expect(withAudience).toContain(
      [
        '- **`mailchimp_playbook`** — If bounce rate is high, plan list hygiene',
        '  args:',
        '  ```json',
        '  {"topic":"list-hygiene","audienceId":"aud1"}',
        '  ```',
      ].join('\n'),
    );
  });

  it('renders neither section when a topic has nothing to suggest', async () => {
    const text = await contentText('subscriber-triage (no match, no audience)');
    expect(text).not.toContain('## Suggested next calls');
    expect(text).not.toContain('## Suggested resources');
    expect(text.endsWith('```')).toBe(true);
  });

  it('renders an entry with empty args as its name and reason alone', () => {
    const blocks = mailchimpPlaybookTool.format!({
      topic: 'onboarding',
      instructions: '# x',
      liveState: {},
      nextToolSuggestions: [{ toolName: 'mailchimp_account', reason: 'Check the plan', args: {} }],
      resourceSuggestions: [],
    });
    expect((blocks[0] as { text: string }).text).toBe(
      [
        'Topic: onboarding',
        '',
        '# x',
        '',
        '',
        '## Suggested next calls',
        '',
        '- **`mailchimp_account`** — Check the plan',
      ].join('\n'),
    );
  });
});
