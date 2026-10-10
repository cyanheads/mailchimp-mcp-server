/**
 * @fileoverview Read mutable campaign content dependencies before requesting consent; never upload.
 * @module mcp-server/tools/shared/campaign-content-snapshot
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { CampaignContentInput } from '@/mcp-server/tools/shared/resolve-local-template.js';
import { getAssetService } from '@/services/assets/asset-service.js';
import { scanAssetReferences } from '@/services/assets/rewrite.js';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

/** Capture referenced template data and asset hashes alongside already-resolved HTML. */
export async function campaignContentSnapshot(
  ctx: Pick<Context, 'signal' | 'log'>,
  content: CampaignContentInput,
) {
  const svc = getMailchimpService();
  const template =
    typeof content.templateId === 'number'
      ? await Promise.all([
          svc.templates.get(ctx, content.templateId),
          svc.templates.defaultContent(ctx, content.templateId),
        ])
      : undefined;
  const assets = getAssetService();
  const hashes: Record<string, string> = {};
  if (assets) {
    const html = [
      content.html,
      ...Object.values(content.templateSections ?? {}).filter(
        (value): value is string => typeof value === 'string',
      ),
    ];
    const refs = new Set(html.flatMap((value) => (value ? scanAssetReferences(value) : [])));
    for (const ref of refs) hashes[ref] = (await assets.info(ref)).sha256;
  }
  return { content, template, assets: hashes };
}
