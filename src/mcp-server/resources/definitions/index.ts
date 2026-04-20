/**
 * @fileoverview Resource definitions barrel — exposes `allResourceDefinitions` for `createApp()`.
 * @module mcp-server/resources/definitions/index
 */

import type { AnyResourceDefinition } from '@cyanheads/mcp-ts-core/resources';
import { mailchimpAccountResource } from './mailchimp-account.resource.js';
import { mailchimpAudienceResource } from './mailchimp-audience.resource.js';
import { mailchimpCampaignResource } from './mailchimp-campaign.resource.js';
import { mailchimpCampaignReportResource } from './mailchimp-campaign-report.resource.js';

export const allResourceDefinitions: AnyResourceDefinition[] = [
  mailchimpAccountResource,
  mailchimpAudienceResource,
  mailchimpCampaignResource,
  mailchimpCampaignReportResource,
];
