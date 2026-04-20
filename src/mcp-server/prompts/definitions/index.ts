/**
 * @fileoverview Prompt definitions barrel — exposes `allPromptDefinitions` for `createApp()`.
 * @module mcp-server/prompts/definitions/index
 */

import type { AnyPromptDefinition } from '@cyanheads/mcp-ts-core/prompts';

import { newsletterFromSourcePrompt } from './newsletter-from-source.prompt.js';

export const allPromptDefinitions: AnyPromptDefinition[] = [newsletterFromSourcePrompt];
