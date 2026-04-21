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
import { initMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

await createApp({
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
  },
});
