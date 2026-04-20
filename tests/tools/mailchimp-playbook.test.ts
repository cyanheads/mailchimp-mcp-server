/**
 * @fileoverview Tests for the `mailchimp_playbook` tool — exercises the
 * `design-campaign` topic (newest branch) end-to-end through a real
 * `MailchimpService` with a stubbed `fetch`, and verifies the `format()`
 * projection and validation-error path.
 * @module tests/tools/mailchimp-playbook.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
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

function fakeResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Build a per-URL fetch stub so we can return different payloads per call. */
function routeStub(
  routes: Record<string, { status: number; body: unknown }>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [pattern, response] of Object.entries(routes)) {
      if (url.includes(pattern)) return fakeResponse(response.status, response.body);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
}

describe('mailchimpPlaybookTool — design-campaign topic', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('throws a ValidationError when audienceId is missing', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const ctx = createMockContext();
    const input = mailchimpPlaybookTool.input.parse({ topic: 'design-campaign' });
    await expect(mailchimpPlaybookTool.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining("'audienceId' is required"),
    });
  });

  it('adds the small-list tone adjustment and strong-open-rate note', async () => {
    vi.stubGlobal(
      'fetch',
      routeStub({
        '/lists/abc/growth-history': {
          status: 200,
          body: { history: [], total_items: 0 },
        },
        '/lists/abc': {
          status: 200,
          body: {
            id: 'abc',
            name: 'Small Test Audience',
            stats: { member_count: 12, open_rate: 0.32, click_rate: 0.05 },
          },
        },
      }),
    );
    const ctx = createMockContext();
    const input = mailchimpPlaybookTool.input.parse({
      topic: 'design-campaign',
      audienceId: 'abc',
    });
    const result = await mailchimpPlaybookTool.handler(input, ctx);

    expect(result.topic).toBe('design-campaign');
    expect(result.instructions).toContain('# Design playbook — "Small Test Audience"');
    expect(result.instructions).toContain('**Small list.**');
    expect(result.instructions).toContain('Strong open rate (32.00%)');
    expect(result.instructions).not.toContain('**Large list.**');
    expect(result.instructions).not.toContain('Low open rate');

    expect(result.liveState).toMatchObject({
      audienceId: 'abc',
      audienceName: 'Small Test Audience',
      memberCount: 12,
      openRate: 0.32,
      toneAdjustmentCount: 2,
    });
    expect(result.nextToolSuggestions).toHaveLength(3);
    expect(result.nextToolSuggestions[0]?.tool).toBe('mailchimp_audience_overview');
  });

  it('adds the large-list + low-open-rate tone adjustments and nets growth from history', async () => {
    vi.stubGlobal(
      'fetch',
      routeStub({
        '/lists/xyz/growth-history': {
          status: 200,
          body: {
            history: [
              { subscribed: 30, unsubscribed: 10 },
              { subscribed: 5, unsubscribed: 3 },
            ],
            total_items: 2,
          },
        },
        '/lists/xyz': {
          status: 200,
          body: {
            id: 'xyz',
            name: 'Big List',
            stats: { member_count: 2000, open_rate: 0.1, click_rate: 0.01 },
          },
        },
      }),
    );
    const ctx = createMockContext();
    const input = mailchimpPlaybookTool.input.parse({
      topic: 'design-campaign',
      audienceId: 'xyz',
    });
    const result = await mailchimpPlaybookTool.handler(input, ctx);

    expect(result.instructions).toContain('**Large list.**');
    expect(result.instructions).toContain('Low open rate (10.00%)');
    // net = (30-10) + (5-3) = 22 → positive growth note
    expect(result.instructions).toContain('Net growth (+22)');
    expect(result.liveState).toMatchObject({ recentNetGrowth: 22 });
  });

  it('survives a missing growth-history endpoint by falling back to empty history', async () => {
    vi.stubGlobal(
      'fetch',
      routeStub({
        '/lists/q1/growth-history': { status: 404, body: { title: 'not found' } },
        '/lists/q1': {
          status: 200,
          body: {
            id: 'q1',
            name: 'Sparse Audience',
            stats: {},
          },
        },
      }),
    );
    const ctx = createMockContext();
    const input = mailchimpPlaybookTool.input.parse({
      topic: 'design-campaign',
      audienceId: 'q1',
    });
    const result = await mailchimpPlaybookTool.handler(input, ctx);
    expect(result.liveState).toMatchObject({
      audienceName: 'Sparse Audience',
      memberCount: 0,
      recentNetGrowth: 0,
      toneAdjustmentCount: 0,
    });
    // With no signals at all, the tailored section should be absent.
    expect(result.instructions).not.toContain('## 8. Tailored for this audience');
  });
});

describe('mailchimpPlaybookTool.format', () => {
  it('renders instructions and appends suggested calls', () => {
    const output = {
      topic: 'onboarding' as const,
      instructions: '# Onboarding playbook\n\nStep 1: …',
      liveState: { planType: 'free' },
      nextToolSuggestions: [
        {
          tool: 'mailchimp_account',
          reason: 'Confirm plan and data center',
          suggestedInput: { operation: 'info' },
        },
      ],
    };
    const blocks = mailchimpPlaybookTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('# Onboarding playbook');
    expect(text).toContain('## Suggested next calls');
    expect(text).toContain('mailchimp_account');
    expect(text).toContain('Confirm plan and data center');
  });
});
