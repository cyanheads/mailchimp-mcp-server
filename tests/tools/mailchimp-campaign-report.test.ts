/**
 * @fileoverview Tests for the `mailchimp_campaign_report` tool. Focus is on
 * the draft-state guard that refuses to render a report for campaigns whose
 * Mailchimp record has no `send_time` (i.e. unsent drafts).
 * @module tests/tools/mailchimp-campaign-report.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpCampaignReportTool } from '@/mcp-server/tools/definitions/mailchimp-campaign-report.tool.js';
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
    const ctx = createMockContext();
    const input = mailchimpCampaignReportTool.input.parse({ campaignId: 'draftx' });
    await expect(mailchimpCampaignReportTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('has not been sent yet'),
      data: { campaignId: 'draftx' },
    });
  });

  it('short-circuits — does not fetch slice endpoints for drafts', async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/reports/draftx')) {
        return fakeResponse(200, { id: 'draftx', send_time: '' });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchStub);
    const ctx = createMockContext();
    const input = mailchimpCampaignReportTool.input.parse({ campaignId: 'draftx' });
    await expect(mailchimpCampaignReportTool.handler(input, ctx)).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('proceeds when send_time is present (sent campaign)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
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
    const ctx = createMockContext();
    const input = mailchimpCampaignReportTool.input.parse({ campaignId: 'sentx' });
    const result = await mailchimpCampaignReportTool.handler(input, ctx);
    expect(result.campaignId).toBe('sentx');
    expect(result.sendTime).toBe('2026-04-20T12:00:00+00:00');
    expect(result.engagement.opens.rate).toBe(0.4);
  });
});
