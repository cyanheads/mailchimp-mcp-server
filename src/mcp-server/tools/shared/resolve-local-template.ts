/**
 * @fileoverview Shared resolver for `content.localTemplate` on campaign tools.
 * If the input references a local template, render it via the TemplateService
 * and return content where `html` is populated (and `localTemplate` is cleared).
 * If the input does NOT reference a local template, returns the input
 * unchanged. Used by `mailchimp_send_campaign`, `mailchimp_campaigns
 * set-content`, and `mailchimp_replicate_campaign contentOverride` so the
 * three paths share identical resolution semantics.
 * @module mcp-server/tools/shared/resolve-local-template
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { configurationError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getTemplateService } from '@/services/templates/template-service.js';

export interface CampaignContentInput {
  html?: string | undefined;
  localTemplate?: string | undefined;
  localTemplateVars?: Record<string, unknown> | undefined;
  plainText?: string | undefined;
  templateId?: number | undefined;
  templateSections?: Record<string, unknown> | undefined;
}

/**
 * Resolve any `localTemplate` reference on the input by rendering it to HTML.
 * The returned object retains every other field, has `html` populated from
 * the render, and has `localTemplate` / `localTemplateVars` stripped (they
 * are now meaningless to downstream consumers).
 *
 * Mutual exclusion: `localTemplate` cannot coexist with `html` or `templateId`.
 * The local template IS the body — combining it with another body source is
 * ambiguous.
 */
export async function resolveLocalTemplate<T extends CampaignContentInput>(
  ctx: Pick<Context, 'signal' | 'log'>,
  input: T,
): Promise<T & CampaignContentInput> {
  if (!input.localTemplate) return input;
  if (input.html || typeof input.templateId === 'number') {
    throw validationError(
      "'localTemplate' is mutually exclusive with 'html' and 'templateId' — pick one body source.",
    );
  }
  const svc = getTemplateService();
  if (!svc) {
    throw configurationError(
      "'localTemplate' requires MAILCHIMP_TEMPLATES_DIR to be set on the server.",
      { reason: 'templates_not_configured' },
    );
  }
  const result = await svc.render(input.localTemplate, input.localTemplateVars ?? {});
  ctx.log.info('local template rendered', {
    name: input.localTemplate,
    bytes: Buffer.byteLength(result.html, 'utf8'),
  });
  return {
    ...input,
    html: result.html,
    localTemplate: undefined,
    localTemplateVars: undefined,
  };
}
