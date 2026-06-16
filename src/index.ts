#!/usr/bin/env node
/**
 * @fileoverview mailchimp-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { allPromptDefinitions } from '@/mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initAssetService } from '@/services/assets/asset-service.js';
import { initMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import { initTemplateService } from '@/services/templates/template-service.js';

await createApp({
  name: 'mailchimp-mcp-server',
  title: 'mailchimp-mcp-server',
  instructions:
    'Use the mailchimp_* tools to manage audiences, subscribers, and campaigns via the Mailchimp Marketing API. Auth is MAILCHIMP_API_KEY, whose required `-<dc>` suffix (e.g. `-us22`) sets the data center. Audiences are "lists" keyed by audience/list ID; subscriber tools take the plain email (the member hash is derived internally). For any multi-step task, call mailchimp_playbook first — it returns tailored guidance plus pre-filled next calls. Typical chain: mailchimp_audiences (list) → mailchimp_find_subscriber → mailchimp_send_campaign → mailchimp_campaign_report. Note: send/schedule elicit confirmation, and mailchimp_subscribers set-tags is declarative — it strips static-segment membership unless you pass preserveTags.',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  landing: {
    envExample: {
      MAILCHIMP_API_KEY: 'your-api-key-us21',
    },
  },
  async setup(core) {
    const serverConfig = getServerConfig();
    await initMailchimpService(serverConfig, core.logger);
    if (serverConfig.assetsDir) {
      await initAssetService(serverConfig.assetsDir, serverConfig.concurrencyLimit, core.logger);
    }
    if (serverConfig.templatesDir) {
      await initTemplateService(serverConfig.templatesDir, core.logger);
    }
  },
});
