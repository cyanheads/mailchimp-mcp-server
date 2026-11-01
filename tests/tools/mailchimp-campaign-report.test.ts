/**
 * @fileoverview Tests for the `mailchimp_campaign_report` tool. Focus is on
 * the draft-state guard that refuses to render a report for campaigns whose
 * Mailchimp record has no `send_time` (i.e. unsent drafts).
 * @module tests/tools/mailchimp-campaign-report.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpCampaignReportTool } from '@/mcp-server/tools/definitions/mailchimp-campaign-report.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';
import { reportFixture, SENT, reportText as text, ZERO } from '../helpers/report-fixture.js';

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

describe('mailchimpCampaignReportTool — draft guard', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('throws ValidationError when the report has no send_time (draft campaign)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse(200, {
          id: 'draftx',
          campaign_title: 'Draft X',
          subject_line: 'Draft X',
          emails_sent: 0,
          send_time: '',
        }),
      ),
    );
    const ctx = createMockContext({ errors: mailchimpCampaignReportTool.errors });
    const input = mailchimpCampaignReportTool.input.parse({ campaignId: 'draftx' });
    await expect(mailchimpCampaignReportTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('has not been sent yet'),
      data: { campaignId: 'draftx' },
    });
  });

  it('short-circuits — does not fetch slice endpoints for drafts', async () => {
    const fetchStub = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/reports/draftx')) {
        return fakeResponse(200, { id: 'draftx', send_time: '' });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchStub);
    const ctx = createMockContext({ errors: mailchimpCampaignReportTool.errors });
    const input = mailchimpCampaignReportTool.input.parse({ campaignId: 'draftx' });
    await expect(mailchimpCampaignReportTool.handler(input, ctx)).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('proceeds when send_time is present (sent campaign)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith('/reports/sentx')) {
          return fakeResponse(200, {
            id: 'sentx',
            campaign_title: 'Sent X',
            subject_line: 'Sent X',
            send_time: '2026-04-20T12:00:00+00:00',
            emails_sent: 5,
            opens: { opens_total: 2, unique_opens: 2, open_rate: 0.4 },
            clicks: { clicks_total: 1, unique_clicks: 1, click_rate: 0.2 },
            bounces: { hard_bounces: 0, soft_bounces: 0, syntax_errors: 0 },
            unsubscribed: 0,
            abuse_reports: 0,
          });
        }
        if (url.includes('/click-details'))
          return fakeResponse(200, { urls_clicked: [], total_items: 0 });
        if (url.includes('/locations')) return fakeResponse(200, { locations: [], total_items: 0 });
        if (url.includes('/unsubscribed'))
          return fakeResponse(200, { unsubscribes: [], total_items: 0 });
        throw new Error(`Unexpected fetch URL: ${url}`);
      }),
    );
    const ctx = createMockContext({ errors: mailchimpCampaignReportTool.errors });
    const input = mailchimpCampaignReportTool.input.parse({ campaignId: 'sentx' });
    const result = await mailchimpCampaignReportTool.handler(input, ctx);
    expect(result.campaignId).toBe('sentx');
    expect(result.sendTime).toBe('2026-04-20T12:00:00+00:00');
    expect(result.engagement.opens.rate).toBe(0.4);
  });
});

describe('report reliability (#30, #31)', () => {
  const fixture = reportFixture();
  const digest = mailchimpCampaignReportTool;

  it('preserves measured zero metrics and genuinely empty slices', async () => {
    fixture.route((path) =>
      Response.json(
        path.endsWith('/c1')
          ? ZERO
          : { urls_clicked: [], locations: [], unsubscribes: [], total_items: 0 },
      ),
    );
    const result = await runToolContract(digest, { campaignId: 'c1', includeTopN: 100 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      delivery: { delivered: 100, abuseReports: 0, bounces: { hard: 0, soft: 0, syntax: 0 } },
      engagement: {
        opens: { total: 0, unique: 0, rate: 0 },
        clicks: { total: 0, unique: 0, rate: 0 },
        unsubscribes: 0,
      },
      topClickedLinks: [],
      topLocations: [],
      recentUnsubscribes: [],
    });
    expect(text(result)).toContain('| Opens | 0 | 0 | 0.00% |');
    expect(fixture.paths).toHaveLength(4);
  });

  it('omits sparse metrics and derived delivery on both surfaces', async () => {
    fixture.route((path) =>
      Response.json(
        path.endsWith('/c1')
          ? { ...SENT, emails_sent: 100 }
          : {
              urls_clicked: [],
              locations: [{ country_code: 'US' }],
              unsubscribes: [],
              total_items: 0,
            },
      ),
    );
    const result = await runToolContract(digest, { campaignId: 'c1' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      delivery: { bounces: {} },
      engagement: { opens: {}, clicks: {} },
      topLocations: [{ countryCode: 'US' }],
    });
    expect(result.structuredContent).not.toHaveProperty('delivery.delivered');
    expect(result.structuredContent).not.toHaveProperty('delivery.abuseReports');
    expect(result.structuredContent).not.toHaveProperty('engagement.unsubscribes');
    expect(result.structuredContent).not.toHaveProperty('topLocations.0.opens');
    expect(text(result)).not.toMatch(/undefined|NaN|0\.00%|\| 0 \||US: 0 opens/);
  });

  it('preserves mixed known metrics and derives delivery only with every operand', async () => {
    fixture.route((path) =>
      Response.json(
        path.endsWith('/c1')
          ? {
              ...SENT,
              emails_sent: 100,
              bounces: { hard_bounces: 2, soft_bounces: 0 },
              opens: { opens_total: 0, open_rate: 0.2 },
            }
          : { urls_clicked: [], locations: [], unsubscribes: [] },
      ),
    );
    const result = await runToolContract(digest, { campaignId: 'c1' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      delivery: { bounces: { hard: 2, soft: 0 } },
      engagement: { opens: { total: 0, rate: 0.2 }, clicks: {} },
    });
    expect(result.structuredContent).not.toHaveProperty('delivery.delivered');
    expect(result.structuredContent).not.toHaveProperty('delivery.bounces.syntax');
    expect(text(result)).toContain('20.00%');
    expect(text(result)).not.toMatch(/undefined|NaN/);
  });

  it('draft recovery targets the existing campaign and does not invent status', async () => {
    fixture.route(() => Response.json({ id: 'draft', type: 'regular', send_time: '' }));
    const result = await runToolContract(digest, { campaignId: 'draft' });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'campaign_not_sent' } },
    });
    expect(result.structuredContent).not.toHaveProperty('error.data.status');
    expect(text(result)).toContain('mailchimp_campaigns');
    expect(text(result)).not.toContain('mailchimp_send_campaign');
  });
  it.each([401, 403, 404, 429, 500, 503])(
    'digest reads propagate HTTP %s rather than successful emptiness',
    async (status) => {
      fixture.route((path) => {
        if (path.endsWith('/c1')) return Response.json(ZERO);
        return Response.json({ title: 'Upstream failure' }, { status });
      });
      const result = await runToolContract(digest, { campaignId: 'c1' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toHaveProperty('error');
      expect(text(result)).toContain(String(status));
      if (status === 429) {
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.RateLimited, data: { reason: 'mailchimp_rate_limited' } },
        });
        expect(text(result)).toContain('mailchimp_rate_limited');
      }
    },
  );
  it('caller cancellation escapes the digest handler itself', async () => {
    const controller = new AbortController();
    fixture.route((path, init) => {
      if (path.endsWith('/c1')) return Response.json(ZERO);
      controller.abort(new DOMException('Stop report enrichment', 'AbortError'));
      return Promise.reject(init?.signal?.reason);
    });
    const ctx = createMockContext({ signal: controller.signal, errors: digest.errors });
    const error = await Promise.resolve(
      digest.handler(digest.input.parse({ campaignId: 'c1' }), ctx),
    ).catch((error: unknown) => error);
    expect(error).toBe(controller.signal.reason);
    expect(error).toMatchObject({ name: 'AbortError', message: 'Stop report enrichment' });
    expect(controller.signal.aborted).toBe(true);
  });
});
