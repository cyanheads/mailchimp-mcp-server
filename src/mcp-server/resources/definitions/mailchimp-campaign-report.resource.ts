/**
 * @fileoverview `mailchimp://campaigns/{campaignId}/report` resource — campaign report snapshot.
 * @module mcp-server/resources/definitions/mailchimp-campaign-report.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import { normalizeMailchimp } from '@/services/mailchimp/normalize.js';

export const mailchimpCampaignReportResource = resource(
  'mailchimp://campaigns/{campaignId}/report',
  {
    name: 'mailchimp-campaign-report',
    description: 'Post-send report headline metrics for a campaign.',
    mimeType: 'application/json',
    params: z.object({
      campaignId: z.string().describe('Campaign ID.'),
    }),
    async handler(params, ctx) {
      const svc = getMailchimpService();
      const r = await svc.reports.get(ctx, params.campaignId);
      if (!r.send_time) {
        throw validationError(
          `Campaign '${params.campaignId}' has not been sent yet — no report data available. Send it with mailchimp_send_campaign first.`,
          { campaignId: params.campaignId },
        );
      }
      return {
        campaignId: r.id,
        campaignTitle: r.campaign_title,
        subjectLine: r.subject_line,
        sendTime: r.send_time,
        emailsSent: r.emails_sent,
        abuseReports: r.abuse_reports,
        unsubscribed: r.unsubscribed,
        bounces: r.bounces ? normalizeMailchimp(r.bounces) : undefined,
        opens: r.opens ? normalizeMailchimp(r.opens) : undefined,
        clicks: r.clicks ? normalizeMailchimp(r.clicks) : undefined,
        industryStats: r.industry_stats ? normalizeMailchimp(r.industry_stats) : undefined,
      };
    },
  },
);
