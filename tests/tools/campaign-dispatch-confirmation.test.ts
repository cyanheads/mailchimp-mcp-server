/**
 * @fileoverview Re-entrant confirmation tests for campaign send workflows.
 * @module tests/tools/campaign-dispatch-confirmation.test
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMockContext,
  expectInputRequired,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpReplicateCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-replicate-campaign.tool.js';
import { mailchimpSendCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-send-campaign.tool.js';
import { AssetCache } from '@/services/assets/asset-cache.js';
import { AssetService, setAssetServiceForTesting } from '@/services/assets/asset-service.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';
import type { Audience, Campaign } from '@/services/mailchimp/types.js';
import {
  setTemplateServiceForTesting,
  TemplateService,
} from '@/services/templates/template-service.js';

const CONFIRMATION_KEY = 'campaignDispatchConfirmation';

const BASE_CONFIG: ServerConfig = {
  apiKey: 'abcdef0123456789abcdef0123456789-us22',
  baseUrl: 'https://us22.api.mailchimp.com/3.0',
  timeoutMs: 1_000,
  maxRetries: 0,
  concurrencyLimit: 4,
  dataCenter: 'us22',
};

const AUDIENCE = {
  id: 'audience-1',
  name: 'Newsletter Readers',
  stats: { member_count: 42 },
} satisfies Audience;

const SOURCE_CAMPAIGN = {
  id: 'source-1',
  status: 'save',
  type: 'regular',
  settings: { subject_line: 'Source subject' },
  recipients: {
    list_id: AUDIENCE.id,
    list_name: AUDIENCE.name,
    recipient_count: 42,
  },
} satisfies Campaign;

const DRAFT_CAMPAIGN = {
  id: 'draft-1',
  status: 'save',
  type: 'regular',
  web_id: 7,
  settings: { subject_line: 'August newsletter' },
  recipients: {
    list_id: AUDIENCE.id,
    list_name: AUDIENCE.name,
    recipient_count: 42,
  },
} satisfies Campaign;

const SENT_CAMPAIGN = {
  ...DRAFT_CAMPAIGN,
  status: 'sent',
} satisfies Campaign;

const sendInput = mailchimpSendCampaignTool.input.parse({
  audienceId: AUDIENCE.id,
  subject: 'August newsletter',
  fromName: 'Example',
  replyTo: 'hello@example.com',
  content: { html: '<p>Hello</p>' },
  mode: 'send',
  confirmSend: true,
});

const replicateInput = mailchimpReplicateCampaignTool.input.parse({
  sourceCampaignId: SOURCE_CAMPAIGN.id,
  subjectOverride: 'August newsletter',
  mode: 'send',
  confirmSend: true,
});

function acceptedConfirmation(): Record<string, unknown> {
  return {
    [CONFIRMATION_KEY]: { action: 'accept', content: { confirmed: true } },
  };
}

function declinedConfirmation(): Record<string, unknown> {
  return { [CONFIRMATION_KEY]: { action: 'decline' } };
}

function malformedAcceptedConfirmation(): Record<string, unknown> {
  return {
    [CONFIRMATION_KEY]: { action: 'accept', content: { confirmed: 'yes' } },
  };
}

function prepareSendWorkflow(service: MailchimpService): void {
  vi.spyOn(service.campaigns, 'create').mockResolvedValue(DRAFT_CAMPAIGN);
  vi.spyOn(service.campaigns, 'setContent').mockResolvedValue({});
  vi.spyOn(service.campaigns, 'getChecklist').mockResolvedValue({ is_ready: true, items: [] });
  vi.spyOn(service.campaigns, 'send').mockResolvedValue();
  vi.spyOn(service.campaigns, 'get').mockResolvedValue(SENT_CAMPAIGN);
}

function prepareReplicateWorkflow(service: MailchimpService): void {
  vi.spyOn(service.campaigns, 'replicate').mockResolvedValue(DRAFT_CAMPAIGN);
  vi.spyOn(service.campaigns, 'update').mockResolvedValue(DRAFT_CAMPAIGN);
  vi.spyOn(service.campaigns, 'getChecklist').mockResolvedValue({ is_ready: true, items: [] });
  vi.spyOn(service.campaigns, 'send').mockResolvedValue();
  vi.spyOn(service.campaigns, 'get').mockImplementation(async (_ctx, id) =>
    id === SOURCE_CAMPAIGN.id ? SOURCE_CAMPAIGN : SENT_CAMPAIGN,
  );
}

async function consentContext(
  service: MailchimpService,
  tool: typeof mailchimpSendCampaignTool | typeof mailchimpReplicateCampaignTool,
  input: typeof sendInput | typeof replicateInput,
  responses: Record<string, unknown>,
) {
  vi.spyOn(service.audiences, 'get').mockResolvedValue(AUDIENCE);
  vi.spyOn(service.campaigns, 'get').mockResolvedValue(SOURCE_CAMPAIGN);
  vi.spyOn(service.campaigns, 'getContent').mockResolvedValue({ html: '<p>Source</p>' });
  const first = createMockContext({ errors: tool.errors });
  const asked = await expectInputRequired(() => tool.handler(input as never, first));
  const ctx = createMockContext({
    errors: tool.errors,
    inputResponses: responses,
    requestState: asked.requestState,
  });
  await ctx.state.set(
    `consent/${asked.requestState}`,
    await first.state.get(`consent/${asked.requestState}`),
    { ttl: 600 },
  );
  return ctx;
}

describe('campaign dispatch confirmation', () => {
  let service: MailchimpService;

  beforeEach(() => {
    service = new MailchimpService(BASE_CONFIG);
    setMailchimpServiceForTesting(service);
    vi.spyOn(service.campaigns, 'getContent').mockResolvedValue({ html: '<p>Source</p>' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setMailchimpServiceForTesting(undefined);
    setTemplateServiceForTesting(undefined);
    setAssetServiceForTesting(undefined);
    service.dispose();
  });

  describe('mailchimp_send_campaign', () => {
    it('never redeems stale storage data after spending consent', async () => {
      const ctx = await consentContext(
        service,
        mailchimpSendCampaignTool,
        sendInput,
        acceptedConfirmation(),
      );
      const record = await ctx.state.get(`consent/${ctx.inputs.state()}`);
      vi.spyOn(ctx.state, 'get').mockResolvedValue(record);
      prepareSendWorkflow(service);
      await mailchimpSendCampaignTool.handler(sendInput, ctx);
      await expectInputRequired(() => mailchimpSendCampaignTool.handler(sendInput, ctx));
      expect(service.campaigns.create).toHaveBeenCalledOnce();
    });
    it('keeps declared checklist recovery on both client surfaces without a forward', async () => {
      prepareSendWorkflow(service);
      vi.spyOn(service.campaigns, 'delete').mockResolvedValue();
      vi.mocked(service.campaigns.getChecklist).mockResolvedValue({
        is_ready: false,
        items: [{ type: 'error', heading: 'Missing content', details: 'Provide content.' }],
      });
      const result = await runToolContract(mailchimpSendCampaignTool, {
        ...sendInput,
        mode: 'test',
        testEmails: ['test@example.com'],
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: {
            reason: 'pre_send_checklist_failed',
            recovery: { hint: expect.stringContaining('Inspect data.errors') },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain('Inspect data.errors');
      expect(JSON.stringify(result.content)).toContain('Missing content');
      expect(service.campaigns.send).not.toHaveBeenCalled();
    });

    it('asks again when the ten-minute consent record expires', async () => {
      vi.useFakeTimers();
      try {
        const ctx = await consentContext(
          service,
          mailchimpSendCampaignTool,
          sendInput,
          acceptedConfirmation(),
        );
        vi.advanceTimersByTime(601_000);
        prepareSendWorkflow(service);
        await expectInputRequired(() => mailchimpSendCampaignTool.handler(sendInput, ctx));
        expect(service.campaigns.create).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
    it('asks again when a referenced asset changes without uploading on either prompt round', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mailchimp-consent-assets-'));
      await writeFile(join(dir, 'hero.png'), 'first');
      setAssetServiceForTesting(new AssetService(dir, new AssetCache(dir), 1));
      const upload = vi.spyOn(service.files, 'upload');
      const input = { ...sendInput, content: { html: '<img src="@assets/hero.png">' } };
      try {
        const ctx = await consentContext(
          service,
          mailchimpSendCampaignTool,
          input,
          acceptedConfirmation(),
        );
        await writeFile(join(dir, 'hero.png'), 'changed');
        prepareSendWorkflow(service);
        await expectInputRequired(() => mailchimpSendCampaignTool.handler(input, ctx));
        expect(service.campaigns.create).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
      } finally {
        setAssetServiceForTesting(undefined);
        await rm(dir, { recursive: true });
      }
    });

    it('asks again when upstream template content changes', async () => {
      vi.spyOn(service.templates, 'get').mockResolvedValue({ id: 7, name: 'Template' });
      const defaults = vi
        .spyOn(service.templates, 'defaultContent')
        .mockResolvedValue({ sections: { body: 'first' } });
      const input = { ...sendInput, content: { templateId: 7 } };
      const ctx = await consentContext(
        service,
        mailchimpSendCampaignTool,
        input,
        acceptedConfirmation(),
      );
      defaults.mockResolvedValue({ sections: { body: 'changed' } });
      prepareSendWorkflow(service);
      await expectInputRequired(() => mailchimpSendCampaignTool.handler(input, ctx));
      expect(service.campaigns.create).not.toHaveBeenCalled();
    });
    it('asks again when local template HTML changes between consent rounds', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mailchimp-consent-templates-'));
      await mkdir(join(dir, 'partials'));
      await writeFile(join(dir, 'newsletter.eta'), "<%~ include('partials/body', it) %>");
      await writeFile(join(dir, 'partials/body.eta'), '<p>First</p>');
      const templates = new TemplateService(dir);
      setTemplateServiceForTesting(templates);
      const input = { ...sendInput, content: { localTemplate: 'newsletter' } };
      const ctx = await consentContext(
        service,
        mailchimpSendCampaignTool,
        input,
        acceptedConfirmation(),
      );
      await writeFile(join(dir, 'partials/body.eta'), '<p>Changed</p>');
      prepareSendWorkflow(service);
      try {
        await expectInputRequired(() => mailchimpSendCampaignTool.handler(input, ctx));
        expect(service.campaigns.create).not.toHaveBeenCalled();
      } finally {
        setTemplateServiceForTesting(undefined);
        await rm(dir, { recursive: true });
      }
    });
    it.each(['target', 'content', 'operation', 'caller', 'instance'] as const)(
      'asks again for a %s mismatch',
      async (mismatch) => {
        const ctx = await consentContext(
          service,
          mailchimpSendCampaignTool,
          sendInput,
          acceptedConfirmation(),
        );
        const key = `consent/${ctx.inputs.state()}`;
        const record = await ctx.state.get<Record<string, unknown>>(key);
        const field = {
          target: 'target',
          content: 'contentHash',
          operation: 'operation',
          caller: 'clientId',
          instance: 'instanceId',
        }[mismatch];
        await ctx.state.set(key, { ...record, [field]: 'different' });
        prepareSendWorkflow(service);
        await expectInputRequired(() => mailchimpSendCampaignTool.handler(sendInput, ctx));
        expect(service.campaigns.create).not.toHaveBeenCalled();
      },
    );

    it('spends consent once across concurrent calls and sequential replay', async () => {
      const ctx = await consentContext(
        service,
        mailchimpSendCampaignTool,
        sendInput,
        acceptedConfirmation(),
      );
      prepareSendWorkflow(service);
      const outcomes = await Promise.allSettled([
        mailchimpSendCampaignTool.handler(sendInput, ctx),
        mailchimpSendCampaignTool.handler(sendInput, ctx),
      ]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(service.campaigns.create).toHaveBeenCalledOnce();
      await expectInputRequired(() => mailchimpSendCampaignTool.handler(sendInput, ctx));
      expect(service.campaigns.create).toHaveBeenCalledOnce();
    });
    it('asks again when an accepted response has no server consent record', async () => {
      vi.spyOn(service.audiences, 'get').mockResolvedValue(AUDIENCE);
      prepareSendWorkflow(service);
      const ctx = createMockContext({
        errors: mailchimpSendCampaignTool.errors,
        inputResponses: acceptedConfirmation(),
      });
      await expectInputRequired(() => mailchimpSendCampaignTool.handler(sendInput, ctx));
      expect(service.campaigns.create).not.toHaveBeenCalled();
    });
    it('requests input before creating the campaign', async () => {
      vi.spyOn(service.audiences, 'get').mockResolvedValue(AUDIENCE);
      const create = vi.spyOn(service.campaigns, 'create');
      const ctx = createMockContext({ errors: mailchimpSendCampaignTool.errors });

      const asked = await expectInputRequired(() =>
        mailchimpSendCampaignTool.handler(sendInput, ctx),
      );

      expect(asked.inputRequests?.[CONFIRMATION_KEY]?.method).toBe('elicitation/create');
      expect(create).not.toHaveBeenCalled();
    });

    it('sends on accepted re-entry without repeating the confirmation summary fetch', async () => {
      const ctx = await consentContext(
        service,
        mailchimpSendCampaignTool,
        sendInput,
        acceptedConfirmation(),
      );
      const audienceGet = vi.spyOn(service.audiences, 'get').mockClear();
      prepareSendWorkflow(service);

      const result = await mailchimpSendCampaignTool.handler(sendInput, ctx);

      expect(result).toMatchObject({ campaignId: DRAFT_CAMPAIGN.id, mode: 'send', status: 'sent' });
      expect(audienceGet).not.toHaveBeenCalled();
      expect(service.campaigns.create).toHaveBeenCalledOnce();
      expect(service.campaigns.send).toHaveBeenCalledWith(ctx, DRAFT_CAMPAIGN.id);
    });

    it('downgrades a declined re-entry to a draft without dispatching', async () => {
      const ctx = await consentContext(
        service,
        mailchimpSendCampaignTool,
        sendInput,
        declinedConfirmation(),
      );
      prepareSendWorkflow(service);

      const result = await mailchimpSendCampaignTool.handler(sendInput, ctx);

      expect(result).toMatchObject({
        campaignId: DRAFT_CAMPAIGN.id,
        mode: 'draft',
        cancelledByUser: true,
      });
      expect(service.campaigns.create).toHaveBeenCalledOnce();
      expect(service.campaigns.send).not.toHaveBeenCalled();
    });

    it('rejects malformed accepted confirmation before creating the campaign', async () => {
      const create = vi.spyOn(service.campaigns, 'create');
      const ctx = await consentContext(
        service,
        mailchimpSendCampaignTool,
        sendInput,
        malformedAcceptedConfirmation(),
      );

      await expect(mailchimpSendCampaignTool.handler(sendInput, ctx)).rejects.toThrow(
        'Campaign dispatch confirmation response was invalid.',
      );
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('mailchimp_replicate_campaign', () => {
    it('asks again when source campaign content changes between consent rounds', async () => {
      const ctx = await consentContext(
        service,
        mailchimpReplicateCampaignTool,
        replicateInput,
        acceptedConfirmation(),
      );
      prepareReplicateWorkflow(service);
      vi.mocked(service.campaigns.getContent).mockResolvedValue({ html: '<p>Changed source</p>' });
      await expectInputRequired(() => mailchimpReplicateCampaignTool.handler(replicateInput, ctx));
      expect(service.campaigns.replicate).not.toHaveBeenCalled();
    });
    it('requests input before replicating the campaign', async () => {
      vi.spyOn(service.campaigns, 'get').mockResolvedValue(SOURCE_CAMPAIGN);
      const replicate = vi.spyOn(service.campaigns, 'replicate');
      const ctx = createMockContext({ errors: mailchimpReplicateCampaignTool.errors });

      const asked = await expectInputRequired(() =>
        mailchimpReplicateCampaignTool.handler(replicateInput, ctx),
      );

      expect(asked.inputRequests?.[CONFIRMATION_KEY]?.method).toBe('elicitation/create');
      expect(replicate).not.toHaveBeenCalled();
    });

    it('sends on accepted re-entry without repeating the confirmation summary fetch', async () => {
      const ctx = await consentContext(
        service,
        mailchimpReplicateCampaignTool,
        replicateInput,
        acceptedConfirmation(),
      );
      prepareReplicateWorkflow(service);
      vi.mocked(service.campaigns.get).mockClear();

      const result = await mailchimpReplicateCampaignTool.handler(replicateInput, ctx);

      expect(result).toMatchObject({ campaignId: DRAFT_CAMPAIGN.id, mode: 'send', status: 'sent' });
      expect(service.campaigns.get).toHaveBeenCalledTimes(2);
      expect(service.campaigns.replicate).toHaveBeenCalledOnce();
      expect(service.campaigns.send).toHaveBeenCalledWith(ctx, DRAFT_CAMPAIGN.id);
    });

    it('downgrades a declined re-entry to a draft without dispatching', async () => {
      const ctx = await consentContext(
        service,
        mailchimpReplicateCampaignTool,
        replicateInput,
        declinedConfirmation(),
      );
      prepareReplicateWorkflow(service);

      const result = await mailchimpReplicateCampaignTool.handler(replicateInput, ctx);

      expect(result).toMatchObject({
        campaignId: DRAFT_CAMPAIGN.id,
        mode: 'draft',
        cancelledByUser: true,
      });
      expect(service.campaigns.replicate).toHaveBeenCalledOnce();
      expect(service.campaigns.send).not.toHaveBeenCalled();
    });

    it('rejects malformed accepted confirmation before replicating the campaign', async () => {
      const replicate = vi.spyOn(service.campaigns, 'replicate');
      const ctx = await consentContext(
        service,
        mailchimpReplicateCampaignTool,
        replicateInput,
        malformedAcceptedConfirmation(),
      );

      await expect(mailchimpReplicateCampaignTool.handler(replicateInput, ctx)).rejects.toThrow(
        'Campaign dispatch confirmation response was invalid.',
      );
      expect(replicate).not.toHaveBeenCalled();
    });
  });
});
