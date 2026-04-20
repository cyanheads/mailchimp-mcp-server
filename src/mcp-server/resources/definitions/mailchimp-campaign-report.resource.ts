/**
 * @fileoverview `mailchimp://campaigns/{campaignId}/report` resource — campaign report snapshot.
 * @module mcp-server/resources/definitions/mailchimp-campaign-report.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

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
      return {
        campaignId: r.id,
        campaignTitle: r.campaign_title,
        subjectLine: r.subject_line,
        sendTime: r.send_time,
        emailsSent: r.emails_sent,
        abuseReports: r.abuse_reports,
        unsubscribed: r.unsubscribed,
        bounces: r.bounces,
        opens: r.opens,
        clicks: r.clicks,
        industryStats: r.industry_stats,
      };
    },
  },
);
