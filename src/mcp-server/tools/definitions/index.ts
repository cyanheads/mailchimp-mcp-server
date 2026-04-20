/**
 * @fileoverview Tool definitions barrel — exposes `allToolDefinitions` for `createApp()`.
 * @module mcp-server/tools/definitions/index
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { mailchimpAccountTool } from './mailchimp-account.tool.js';
import { mailchimpAudienceOverviewTool } from './mailchimp-audience-overview.tool.js';
import { mailchimpAudiencesTool } from './mailchimp-audiences.tool.js';
import { mailchimpCampaignReportTool } from './mailchimp-campaign-report.tool.js';
import { mailchimpCampaignsTool } from './mailchimp-campaigns.tool.js';
import { mailchimpFindSubscriberTool } from './mailchimp-find-subscriber.tool.js';
import { mailchimpImportSubscribersTool } from './mailchimp-import-subscribers.tool.js';
import { mailchimpMergeFieldsTool } from './mailchimp-merge-fields.tool.js';
import { mailchimpPlaybookTool } from './mailchimp-playbook.tool.js';
import { mailchimpReplicateCampaignTool } from './mailchimp-replicate-campaign.tool.js';
import { mailchimpReportsTool } from './mailchimp-reports.tool.js';
import { mailchimpSearchTool } from './mailchimp-search.tool.js';
import { mailchimpSegmentsTool } from './mailchimp-segments.tool.js';
import { mailchimpSendCampaignTool } from './mailchimp-send-campaign.tool.js';
import { mailchimpSubscribersTool } from './mailchimp-subscribers.tool.js';
import { mailchimpTemplatesTool } from './mailchimp-templates.tool.js';
import { mailchimpUpsertSubscriberTool } from './mailchimp-upsert-subscriber.tool.js';

export const allToolDefinitions: AnyToolDefinition[] = [
  mailchimpAccountTool,
  mailchimpAudiencesTool,
  mailchimpAudienceOverviewTool,
  mailchimpSubscribersTool,
  mailchimpUpsertSubscriberTool,
  mailchimpFindSubscriberTool,
  mailchimpImportSubscribersTool,
  mailchimpSegmentsTool,
  mailchimpMergeFieldsTool,
  mailchimpCampaignsTool,
  mailchimpSendCampaignTool,
  mailchimpReplicateCampaignTool,
  mailchimpReportsTool,
  mailchimpCampaignReportTool,
  mailchimpTemplatesTool,
  mailchimpSearchTool,
  mailchimpPlaybookTool,
];
