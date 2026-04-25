/**
 * @fileoverview Regression tests for the shared `templateSections` describe
 * string used by `mailchimp_send_campaign`, `mailchimp_campaigns`, and
 * `mailchimp_replicate_campaign`. Before this was shared, one of the three
 * tools had no `.describe()` at all and the other two had thin descriptions
 * that didn't explain the key/value contract — the likely root cause of the
 * "gets null set" failure users reported. These tests pin:
 *   1. The shared doc exists and covers every element the LLM needs to call
 *      the tool correctly (keys, values, discovery, example, caveat).
 *   2. All three tools actually surface that doc on the right field.
 * @module tests/tools/template-sections-doc.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { mailchimpCampaignsTool } from '@/mcp-server/tools/definitions/mailchimp-campaigns.tool.js';
import { mailchimpReplicateCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-replicate-campaign.tool.js';
import { mailchimpSendCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-send-campaign.tool.js';
import { TEMPLATE_SECTIONS_DOC } from '@/mcp-server/tools/shared/template-sections-doc.js';

describe('TEMPLATE_SECTIONS_DOC', () => {
  it('mentions the edit-region key source (`mc:edit` and get-default-content)', () => {
    expect(TEMPLATE_SECTIONS_DOC).toContain('mc:edit');
    expect(TEMPLATE_SECTIONS_DOC).toContain('get-default-content');
  });

  it('states the value type (HTML strings) and when it applies', () => {
    expect(TEMPLATE_SECTIONS_DOC).toContain('HTML');
    expect(TEMPLATE_SECTIONS_DOC).toContain('templateId');
  });

  it('includes a concrete example', () => {
    expect(TEMPLATE_SECTIONS_DOC).toContain('header');
    expect(TEMPLATE_SECTIONS_DOC).toContain('<h1>');
  });

  it('warns about empty sections on non-drag-and-drop templates', () => {
    expect(TEMPLATE_SECTIONS_DOC).toMatch(/drag-and-drop|classic|user-uploaded/i);
  });
});

/**
 * Read a nested `description` out of a JSON Schema document produced by
 * `z.toJSONSchema`. Walks through `properties` at each path segment, and
 * unwraps `allOf` / `$defs` / `anyOf` wrappers Zod uses to represent
 * `.optional()` on object properties. Returns the first description found
 * at the target path.
 */
function jsonSchemaDescription(schema: unknown, path: readonly string[]): string | undefined {
  const resolve = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.allOf) && n.allOf.length > 0) {
      return { ...n, ...resolve(n.allOf[0]) };
    }
    if (Array.isArray(n.anyOf) && n.anyOf.length > 0) {
      return { ...n, ...resolve(n.anyOf[0]) };
    }
    return n;
  };
  let node: Record<string, unknown> | undefined = resolve(schema) as
    | Record<string, unknown>
    | undefined;
  for (const segment of path) {
    if (!node) return;
    const props = node.properties;
    if (!props || typeof props !== 'object') return;
    const next = (props as Record<string, unknown>)[segment];
    node = resolve(next) as Record<string, unknown> | undefined;
  }
  const desc = node?.description;
  return typeof desc === 'string' ? desc : undefined;
}

describe('templateSections field surfaces TEMPLATE_SECTIONS_DOC', () => {
  it('mailchimp_send_campaign: content.templateSections', () => {
    const schema = z.toJSONSchema(mailchimpSendCampaignTool.input);
    expect(jsonSchemaDescription(schema, ['content', 'templateSections'])).toBe(
      TEMPLATE_SECTIONS_DOC,
    );
  });

  it('mailchimp_campaigns: content.templateSections', () => {
    const schema = z.toJSONSchema(mailchimpCampaignsTool.input);
    expect(jsonSchemaDescription(schema, ['content', 'templateSections'])).toBe(
      TEMPLATE_SECTIONS_DOC,
    );
  });

  it('mailchimp_replicate_campaign: contentOverride.templateSections', () => {
    const schema = z.toJSONSchema(mailchimpReplicateCampaignTool.input);
    expect(jsonSchemaDescription(schema, ['contentOverride', 'templateSections'])).toBe(
      TEMPLATE_SECTIONS_DOC,
    );
  });
});
