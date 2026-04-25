/**
 * @fileoverview Shared helper that rewrites `@assets/<path>` references in a
 * campaign content body using the singleton asset service. Both
 * `mailchimp_send_campaign` and `mailchimp_campaigns set-content` call this
 * before passing content upstream. When the asset service is not configured,
 * this is a pass-through.
 * @module mcp-server/tools/shared/asset-rewrite
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { getAssetService } from '@/services/assets/asset-service.js';

/**
 * Body shape used by `svc.campaigns.setContent`. Mirrors the upstream API
 * payload — fields are independently optional, and any HTML-bearing field gets
 * rewritten when the asset service is configured.
 */
export interface CampaignContentBody {
  html?: string;
  plain_text?: string;
  template?: {
    id: number;
    sections?: Record<string, unknown>;
  };
}

/**
 * Rewrite `@assets/<path>` references in every HTML-bearing field of the body.
 * Returns a new object with rewritten content; leaves non-HTML fields alone.
 * If the asset service is not initialized (env not configured), returns the
 * input unchanged.
 */
export async function rewriteAssetsInContent<T extends CampaignContentBody>(
  ctx: Pick<Context, 'signal' | 'log'>,
  body: T,
): Promise<T> {
  const svc = getAssetService();
  if (!svc) return body;

  const next: T = { ...body };
  if (next.html) next.html = await svc.rewriteHtml(ctx, next.html);
  if (next.template?.sections) {
    const sections: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next.template.sections)) {
      sections[key] = typeof value === 'string' ? await svc.rewriteHtml(ctx, value) : value;
    }
    next.template = { ...next.template, sections };
  }
  return next;
}
