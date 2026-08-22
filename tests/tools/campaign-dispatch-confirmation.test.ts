/**
 * @fileoverview Re-entrant confirmation tests for campaign send workflows.
 * @module tests/tools/campaign-dispatch-confirmation.test
 */

import { createMockContext, expectInputRequired } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpReplicateCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-replicate-campaign.tool.js';
import { mailchimpSendCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-send-campaign.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';
import type { Audience, Campaign } from '@/services/mailchimp/types.js';

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
  vi.spyOn(service.campaigns, 'get').mockResolvedValue(SENT_CAMPAIGN);
}

describe('campaign dispatch confirmation', () => {
  let service: MailchimpService;

  beforeEach(() => {
    service = new MailchimpService(BASE_CONFIG);
    setMailchimpServiceForTesting(service);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setMailchimpServiceForTesting(undefined);
  });

  describe('mailchimp_send_campaign', () => {
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
      const audienceGet = vi.spyOn(service.audiences, 'get');
      prepareSendWorkflow(service);
      const ctx = createMockContext({
        errors: mailchimpSendCampaignTool.errors,
        inputResponses: acceptedConfirmation(),
      });

      const result = await mailchimpSendCampaignTool.handler(sendInput, ctx);

      expect(result).toMatchObject({ campaignId: DRAFT_CAMPAIGN.id, mode: 'send', status: 'sent' });
      expect(audienceGet).not.toHaveBeenCalled();
      expect(service.campaigns.create).toHaveBeenCalledOnce();
      expect(service.campaigns.send).toHaveBeenCalledWith(ctx, DRAFT_CAMPAIGN.id);
    });

    it('downgrades a declined re-entry to a draft without dispatching', async () => {
      prepareSendWorkflow(service);
      const ctx = createMockContext({
        errors: mailchimpSendCampaignTool.errors,
        inputResponses: declinedConfirmation(),
      });

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
      const ctx = createMockContext({
        errors: mailchimpSendCampaignTool.errors,
        inputResponses: malformedAcceptedConfirmation(),
      });

      await expect(mailchimpSendCampaignTool.handler(sendInput, ctx)).rejects.toThrow(
        'Campaign dispatch confirmation response was invalid.',
      );
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('mailchimp_replicate_campaign', () => {
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
      prepareReplicateWorkflow(service);
      const ctx = createMockContext({
        errors: mailchimpReplicateCampaignTool.errors,
        inputResponses: acceptedConfirmation(),
      });

      const result = await mailchimpReplicateCampaignTool.handler(replicateInput, ctx);

      expect(result).toMatchObject({ campaignId: DRAFT_CAMPAIGN.id, mode: 'send', status: 'sent' });
      expect(service.campaigns.get).toHaveBeenCalledOnce();
      expect(service.campaigns.replicate).toHaveBeenCalledOnce();
      expect(service.campaigns.send).toHaveBeenCalledWith(ctx, DRAFT_CAMPAIGN.id);
    });

    it('downgrades a declined re-entry to a draft without dispatching', async () => {
      prepareReplicateWorkflow(service);
      const ctx = createMockContext({
        errors: mailchimpReplicateCampaignTool.errors,
        inputResponses: declinedConfirmation(),
      });

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
      const ctx = createMockContext({
        errors: mailchimpReplicateCampaignTool.errors,
        inputResponses: malformedAcceptedConfirmation(),
      });

      await expect(mailchimpReplicateCampaignTool.handler(replicateInput, ctx)).rejects.toThrow(
        'Campaign dispatch confirmation response was invalid.',
      );
      expect(replicate).not.toHaveBeenCalled();
    });
  });
});
