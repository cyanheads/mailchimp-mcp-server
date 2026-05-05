/**
 * @fileoverview Tool definitions barrel — exposes `allToolDefinitions` for `createApp()`.
 * Conditional tools surface differently based on the runtime gate:
 *   - On Cloudflare Workers (no Node filesystem) `mailchimp_assets` and
 *     `mailchimp_local_templates` are entirely absent — the underlying services
 *     can't run.
 *   - On Node, the tools always appear in the manifest. When their env var is
 *     set they're fully active; when unset they're wrapped via `disabledTool()`
 *     so operators reading `/.well-known/mcp.json` and the landing page see why
 *     the tool is gated and how to enable it, while LLM clients still can't
 *     invoke them via `tools/list`.
 * @module mcp-server/tools/definitions/index
 */

import { disabledTool } from '@cyanheads/mcp-ts-core';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { mailchimpAccountTool } from './mailchimp-account.tool.js';
import { mailchimpAssetsTool } from './mailchimp-assets.tool.js';
import { mailchimpAudienceOverviewTool } from './mailchimp-audience-overview.tool.js';
import { mailchimpAudiencesTool } from './mailchimp-audiences.tool.js';
import { mailchimpCampaignReportTool } from './mailchimp-campaign-report.tool.js';
import { mailchimpCampaignsTool } from './mailchimp-campaigns.tool.js';
import { mailchimpFilesTool } from './mailchimp-files.tool.js';
import { mailchimpFindSubscriberTool } from './mailchimp-find-subscriber.tool.js';
import { mailchimpImportSubscribersTool } from './mailchimp-import-subscribers.tool.js';
import { mailchimpLocalTemplatesTool } from './mailchimp-local-templates.tool.js';
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

const alwaysOn: AnyToolDefinition[] = [
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
  mailchimpFilesTool,
  mailchimpSearchTool,
  mailchimpPlaybookTool,
];

function hasFilesystem(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

function hasAssetsDir(): boolean {
  const v = typeof process !== 'undefined' ? process.env.MAILCHIMP_ASSETS_DIR : undefined;
  return typeof v === 'string' && v.length > 0;
}

function hasTemplatesDir(): boolean {
  const v = typeof process !== 'undefined' ? process.env.MAILCHIMP_TEMPLATES_DIR : undefined;
  return typeof v === 'string' && v.length > 0;
}

const conditional: AnyToolDefinition[] = [];
if (hasFilesystem()) {
  conditional.push(
    hasAssetsDir()
      ? mailchimpAssetsTool
      : disabledTool(mailchimpAssetsTool, {
          reason: 'MAILCHIMP_ASSETS_DIR not set — local-assets surface inactive.',
          hint: 'Set MAILCHIMP_ASSETS_DIR=/path/to/assets to enable @assets/* uploads, hashing, and HTML rewriting.',
        }),
  );
  conditional.push(
    hasTemplatesDir()
      ? mailchimpLocalTemplatesTool
      : disabledTool(mailchimpLocalTemplatesTool, {
          reason: 'MAILCHIMP_TEMPLATES_DIR not set — local-templates surface inactive.',
          hint: 'Set MAILCHIMP_TEMPLATES_DIR=/path/to/templates to enable .eta template rendering (canonical write path on free-tier accounts).',
        }),
  );
}

export const allToolDefinitions: AnyToolDefinition[] = [...alwaysOn, ...conditional];
