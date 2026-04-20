/**
 * @fileoverview `mailchimp://campaigns/{campaignId}` resource — campaign snapshot.
 * @module mcp-server/resources/definitions/mailchimp-campaign.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import { normalizeMailchimp } from '@/services/mailchimp/normalize.js';

export const mailchimpCampaignResource = resource('mailchimp://campaigns/{campaignId}', {
  name: 'mailchimp-campaign',
  description: 'Campaign snapshot — status, settings, recipients summary.',
  mimeType: 'application/json',
  params: z.object({
    campaignId: z.string().describe('Campaign ID.'),
  }),
  async handler(params, ctx) {
    const svc = getMailchimpService();
    const c = await svc.campaigns.get(ctx, params.campaignId);
    return {
      id: c.id,
      type: c.type,
      status: c.status,
      createTime: c.create_time,
      sendTime: c.send_time,
      emailsSent: c.emails_sent,
      archiveUrl: c.archive_url,
      settings: c.settings ? normalizeMailchimp(c.settings) : undefined,
      recipients: c.recipients ? normalizeMailchimp(c.recipients) : undefined,
      tracking: c.tracking ? normalizeMailchimp(c.tracking) : undefined,
      reportSummary: c.report_summary ? normalizeMailchimp(c.report_summary) : undefined,
    };
  },
});
