/** Exercise existing campaign actions through the tool contract and Mailchimp HTTP service. */
import {
  createMockContext,
  expectInputRequired,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailchimpCampaignsTool as tool } from '@/mcp-server/tools/definitions/mailchimp-campaigns.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';

const campaignId = 'draft-1';
const campaign = {
  id: campaignId,
  type: 'regular',
  status: 'save',
  settings: { subject_line: 'Reviewed draft' },
  recipients: {
    list_id: 'audience-1',
    list_name: 'Readers',
    recipient_count: 5,
    segment_opts: { saved_segment_id: 12 },
  },
};
const content = { html: '<p>Reviewed</p>' };

function upstream() {
  const state = {
    campaign: structuredClone(campaign),
    content: structuredClone(content),
    checklist: {
      is_ready: true,
      items: [] as { type: string; heading: string; details: string }[],
    },
    mutationStatus: 204,
    mutations: [] as { method: string; path: string; body?: unknown }[],
  };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      state.mutations.push({
        method,
        path,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      return new Response(null, { status: state.mutationStatus });
    }
    if (path === '/3.0/campaigns/draft-1/content') return Response.json(state.content);
    if (path === '/3.0/campaigns/draft-1/send-checklist') return Response.json(state.checklist);
    if (path === '/3.0/campaigns/draft-1') return Response.json(state.campaign);
    return Response.json({ detail: 'Unknown fixture path' }, { status: 404 });
  });
  return state;
}

describe('existing campaign actions', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(
      new MailchimpService({
        apiKey: 'mailchimp-test-key',
        baseUrl: 'https://us22.api.mailchimp.com/3.0',
        timeoutMs: 1_000,
        maxRetries: 2,
        concurrencyLimit: 4,
        dataCenter: 'us22',
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('reads draft identity and edited content by ID without creating another campaign', async () => {
    const state = upstream();
    const record = await runToolContract(tool, { operation: 'get', campaignId });
    expect(record.structuredContent).toMatchObject({
      campaign: {
        id: campaignId,
        status: 'save',
        subjectLine: 'Reviewed draft',
        recipientCount: 5,
      },
    });
    state.content.html = '<p>Proofread revision</p>';
    const body = await runToolContract(tool, { operation: 'get-content', campaignId });
    expect(body.structuredContent).toEqual({
      operation: 'get-content',
      content: { html: '<p>Proofread revision</p>' },
    });
    expect(state.mutations).toEqual([]);
  });

  it('previews the existing draft at the given ID and leaves it reviewable', async () => {
    const state = upstream();
    const result = await runToolContract(tool, {
      operation: 'send-test',
      campaignId,
      testEmails: ['reader@example.com'],
      testSendType: 'plaintext',
    });
    expect(result.structuredContent).toEqual({ operation: 'send-test', campaignId });
    expect(result.content).toEqual([
      { type: 'text', text: 'Operation: send-test\n\nCampaign ID: `draft-1`' },
    ]);
    expect(state.mutations).toEqual([
      {
        method: 'POST',
        path: '/3.0/campaigns/draft-1/actions/test',
        body: { test_emails: ['reader@example.com'], send_type: 'plaintext' },
      },
    ]);
    const record = await runToolContract(tool, { operation: 'get', campaignId });
    expect(record.structuredContent).toMatchObject({
      campaign: { id: campaignId, status: 'save' },
    });
  });

  it.each([
    [{ operation: 'send' }, 'confirmSend'],
    [{ operation: 'send', confirmSend: false }, 'confirmSend'],
    [{ operation: 'schedule', confirmSend: true }, 'scheduleTime'],
    [{ operation: 'schedule', confirmSend: true, scheduleTime: '2099-01-01T00:01:00Z' }, 'quarter'],
    [{ operation: 'schedule', confirmSend: true, scheduleTime: '2099-01-01T00:15:30Z' }, 'quarter'],
    [{ operation: 'schedule', confirmSend: true, scheduleTime: '2020-01-01T00:15:00Z' }, 'future'],
    [{ operation: 'send-test', testEmails: [] }, 'testEmails'],
    [
      { operation: 'send-test', testEmails: Array<string>(51).fill('reader@example.com') },
      'testEmails',
    ],
    [{ operation: 'send-test', testEmails: ['reader@example.com'] }, 'testSendType'],
    [{ operation: 'delete', campaignId: '..' }, 'campaignId'],
    [{ operation: 'delete', campaignId: '%2e%2e' }, 'campaignId'],
    [{ operation: 'delete', campaignId: 'draft-1/../draft-2' }, 'campaignId'],
  ] satisfies Array<[Parameters<typeof runToolContract<typeof tool>>[1], string]>)(
    'rejects invalid action input %j before touching Mailchimp',
    async (input, field) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const result = await runToolContract(tool, { campaignId, ...input });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { message: expect.stringContaining(field) },
      });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(field) });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('accepts the existing preview recipient cap', async () => {
    const state = upstream();
    const testEmails = Array.from({ length: 50 }, (_, index) => `test-${index}@example.com`);
    const result = await runToolContract(tool, {
      operation: 'send-test',
      campaignId,
      testEmails,
      testSendType: 'html',
    });
    expect(result.isError).toBeFalsy();
    expect(state.mutations).toEqual([
      {
        method: 'POST',
        path: '/3.0/campaigns/draft-1/actions/test',
        body: { test_emails: testEmails, send_type: 'html' },
      },
    ]);
  });

  it.each(['paused', 'schedule', 'sending', 'sent'])(
    'preserves a %s campaign and its reports',
    async (status) => {
      const state = upstream();
      state.campaign.status = status;
      const result = await runToolContract(tool, { operation: 'delete', campaignId });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'campaign_not_draft',
            recovery: { hint: 'List campaigns with status save and choose a draft campaign ID.' },
          },
        },
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining('campaign_not_draft'),
      });
      expect(state.mutations).toEqual([]);
    },
  );

  it.each([
    { is_ready: false, items: [] },
    {
      is_ready: true,
      items: [{ type: 'error', heading: 'Broken link', details: 'Update the URL' }],
    },
  ])('blocks dispatch on checklist %j', async (checklist) => {
    const state = upstream();
    state.checklist = checklist;
    for (const action of [
      { operation: 'send', confirmSend: true },
      { operation: 'send-test', testEmails: ['reader@example.com'], testSendType: 'html' },
    ] satisfies Parameters<typeof runToolContract<typeof tool>>[1][]) {
      const result = await runToolContract(tool, { campaignId, ...action });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'pre_send_checklist_failed',
            recovery: { hint: 'Review the checklist and fix the existing draft before dispatch.' },
          },
        },
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining('pre_send_checklist_failed'),
      });
    }
    expect(state.mutations).toEqual([]);
  });

  it.each([
    [{ operation: 'send', confirmSend: true }, 'POST', '/actions/send'],
    [
      { operation: 'schedule', confirmSend: true, scheduleTime: '2099-01-01T00:15:00Z' },
      'POST',
      '/actions/schedule',
    ],
    [{ operation: 'delete' }, 'DELETE', ''],
  ] as const)(
    'does not repeat a failed %j mutation or delete the draft as cleanup',
    async (args, method, suffix) => {
      const state = upstream();
      const input = tool.input.parse({ campaignId, ...args });
      const first = createMockContext({ errors: tool.errors });
      const asked = await expectInputRequired(() => tool.handler(input, first));
      expect(state.mutations).toEqual([]);
      const second = createMockContext({
        errors: tool.errors,
        requestState: asked.requestState,
        inputResponses: {
          campaignDispatchConfirmation: { action: 'accept', content: { confirmed: true } },
        },
      });
      const key = `consent/${asked.requestState}`;
      await second.state.set(key, await first.state.get(key), { ttl: 600 });
      state.mutationStatus = 503;
      await expect(tool.handler(input, second)).rejects.toThrow();
      expect(state.mutations.map(({ method, path }) => ({ method, path }))).toEqual([
        { method, path: `/3.0/campaigns/draft-1${suffix}` },
      ]);
      expect(
        (await runToolContract(tool, { operation: 'get', campaignId })).structuredContent,
      ).toMatchObject({
        campaign: { id: campaignId, status: 'save' },
      });
    },
  );
});
