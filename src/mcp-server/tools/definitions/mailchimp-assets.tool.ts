/**
 * @fileoverview `mailchimp_assets` — local-assets surface (L1). Conditionally
 * registered when `MAILCHIMP_ASSETS_DIR` is set. Discovers files in the assets
 * directory, reports cache status, and pre-warms the upload cache to Mailchimp
 * File Manager. Most users won't call this directly — auto-upload happens
 * implicitly when `@assets/<path>` references appear in campaign HTML. Use this
 * tool to inspect what's available, force-sync a batch ahead of a send, or
 * clear the cache after asset changes.
 * @module mcp-server/tools/definitions/mailchimp-assets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getAssetService } from '@/services/assets/asset-service.js';

const OperationSchema = z
  .enum(['list', 'info', 'sync', 'clear-cache'])
  .describe(
    'Which local-assets operation to run. `list` walks the assets dir; `info` shows one file with its hash + cache status; `sync` uploads any uncached files to Mailchimp ahead of a send; `clear-cache` deletes the local cache (next send re-uploads everything).',
  );

const InputSchema = z.object({
  operation: OperationSchema,
  relPath: z
    .string()
    .optional()
    .describe(
      'Relative path under MAILCHIMP_ASSETS_DIR (forward-slash separated). Required for `info`. Path-traversal (`..`) is rejected.',
    ),
});

const AssetListEntrySchema = z
  .object({
    relPath: z.string().describe('Path relative to MAILCHIMP_ASSETS_DIR.'),
    size: z.number().describe('File size in bytes.'),
    ext: z.string().describe('Lowercase extension including leading dot.'),
    isImage: z.boolean().describe("Whether the extension is in Mailchimp's image allowlist."),
  })
  .describe('Listing-row asset entry.');

const AssetDetailSchema = z
  .object({
    relPath: z.string().describe('Path relative to MAILCHIMP_ASSETS_DIR.'),
    size: z.number().describe('File size in bytes.'),
    ext: z.string().describe('Lowercase extension including leading dot.'),
    isImage: z.boolean().describe("Whether the extension is in Mailchimp's image allowlist."),
    sha256: z.string().describe('SHA-256 hex of file contents.'),
    cached: z
      .object({
        fileId: z.number().describe('Mailchimp File Manager file ID.'),
        fullSizeUrl: z.string().describe('Public CDN URL — embed in HTML as `<img src=…>`.'),
        thumbnailUrl: z.string().optional().describe('Thumbnail URL (images only).'),
        uploadedAt: z.string().describe('ISO 8601 timestamp of the upload.'),
      })
      .optional()
      .describe('Cached upload metadata. Absent when the file has never been uploaded.'),
  })
  .describe('Detail asset entry returned by `info`.');

const SyncSkipSchema = z
  .object({
    relPath: z.string().describe('Path that failed to sync.'),
    reason: z.string().describe('Error message explaining why it was skipped.'),
  })
  .describe('A file that was skipped during a sync run.');

const OutputSchema = z.object({
  operation: OperationSchema,
  assetsDir: z.string().describe('Resolved absolute path of MAILCHIMP_ASSETS_DIR.'),
  asset: AssetDetailSchema.optional().describe('Populated for `info`.'),
  assets: z.array(AssetListEntrySchema).optional().describe('Populated for `list`.'),
  uploaded: z.number().optional().describe('Files uploaded during `sync`.'),
  cached: z.number().optional().describe('Files that were already cached during `sync`.'),
  skipped: z
    .array(SyncSkipSchema)
    .optional()
    .describe('Files skipped during `sync` (with reasons).'),
  cacheSize: z.number().optional().describe('Number of cached entries after the operation.'),
  cleared: z.boolean().optional().describe('True when `clear-cache` succeeded.'),
});

type Output = z.infer<typeof OutputSchema>;

function requireService(): NonNullable<ReturnType<typeof getAssetService>> {
  const svc = getAssetService();
  if (!svc) {
    throw new McpError(
      JsonRpcErrorCode.ConfigurationError,
      'Assets service is not initialized. Set MAILCHIMP_ASSETS_DIR and restart the server to enable local-assets workflows.',
    );
  }
  return svc;
}

export const mailchimpAssetsTool = tool('mailchimp_assets', {
  description:
    "Inspect and pre-warm the local-assets pipeline. Available only when `MAILCHIMP_ASSETS_DIR` is set on the server. Use `list` to see what's available, `info` to get a single file's hash + cache status, `sync` to upload everything ahead of a send (so the actual send is fast), and `clear-cache` to invalidate the local cache. Most workflows don't need this — auto-upload happens automatically when `@assets/<path>` references appear in campaign HTML via `mailchimp_send_campaign` or `mailchimp_campaigns set-content`.",
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = requireService();

    switch (input.operation) {
      case 'list': {
        const entries = await svc.list();
        return {
          operation: 'list',
          assetsDir: svc.directory,
          assets: entries.map((e) => ({
            relPath: e.relPath,
            size: e.size,
            ext: e.ext,
            isImage: e.isImage,
          })),
          cacheSize: svc.cacheSize(),
        };
      }
      case 'info': {
        if (!input.relPath)
          throw new McpError(JsonRpcErrorCode.ValidationError, "'relPath' is required for 'info'.");
        const info = await svc.info(input.relPath);
        return {
          operation: 'info',
          assetsDir: svc.directory,
          asset: {
            relPath: info.relPath,
            size: info.size,
            ext: info.ext,
            isImage: info.isImage,
            sha256: info.sha256,
            ...(info.cached
              ? {
                  cached: {
                    fileId: info.cached.fileId,
                    fullSizeUrl: info.cached.fullSizeUrl,
                    ...(info.cached.thumbnailUrl ? { thumbnailUrl: info.cached.thumbnailUrl } : {}),
                    uploadedAt: info.cached.uploadedAt,
                  },
                }
              : {}),
          },
          cacheSize: svc.cacheSize(),
        };
      }
      case 'sync': {
        const result = await svc.sync(ctx);
        return {
          operation: 'sync',
          assetsDir: svc.directory,
          uploaded: result.uploaded,
          cached: result.cached,
          skipped: result.skipped,
          cacheSize: svc.cacheSize(),
        };
      }
      case 'clear-cache': {
        await svc.clearCache();
        return {
          operation: 'clear-cache',
          assetsDir: svc.directory,
          cleared: true,
          cacheSize: svc.cacheSize(),
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [
      `_Operation: ${result.operation}_`,
      `_Assets dir: ${result.assetsDir}_`,
      '',
    ];

    if (result.assets) {
      lines.push(
        `# Local assets (${result.assets.length} file${result.assets.length === 1 ? '' : 's'}, cache: ${result.cacheSize ?? 0})`,
        '',
      );
      if (result.assets.length === 0) {
        lines.push('_Drop image or document files into the assets directory and rerun._');
      } else {
        for (const a of result.assets) {
          const sizeLabel =
            a.size < 1024
              ? `${a.size} B`
              : a.size < 1024 * 1024
                ? `${(a.size / 1024).toFixed(1)} KB (${a.size} B)`
                : `${(a.size / 1024 / 1024).toFixed(2)} MB (${a.size} B)`;
          lines.push(
            `- **${a.relPath}** — ${a.isImage ? 'image' : 'file'} · ${sizeLabel} · \`${a.ext}\``,
          );
        }
      }
    }

    if (result.asset) {
      const a = result.asset;
      lines.push(`# ${a.relPath}`, '');
      lines.push(`- type: ${a.isImage ? 'image' : 'file'}`);
      lines.push(`- size: ${a.size} bytes`);
      lines.push(`- ext: \`${a.ext}\``);
      if (a.sha256) lines.push(`- sha256: \`${a.sha256}\``);
      if (a.cached) {
        lines.push('', '## Cached upload', '');
        lines.push(`- fileId: \`${a.cached.fileId}\``);
        lines.push(`- fullSizeUrl: ${a.cached.fullSizeUrl}`);
        if (a.cached.thumbnailUrl) lines.push(`- thumbnailUrl: ${a.cached.thumbnailUrl}`);
        lines.push(`- uploadedAt: ${a.cached.uploadedAt}`);
      } else {
        lines.push('', '_Not yet uploaded. Will upload on next `sync` or campaign send._');
      }
    }

    if (
      typeof result.uploaded === 'number' ||
      typeof result.cached === 'number' ||
      result.skipped !== undefined
    ) {
      lines.push(
        `# Sync result`,
        '',
        `- uploaded: **${result.uploaded ?? 0}**`,
        `- already cached: ${result.cached ?? 0}`,
        `- skipped: ${result.skipped?.length ?? 0}`,
        `- cache size after: ${result.cacheSize ?? 0}`,
      );
      if (result.skipped && result.skipped.length > 0) {
        lines.push('', '## Skipped', '');
        for (const s of result.skipped) lines.push(`- **${s.relPath}** — ${s.reason}`);
      }
    }

    if (typeof result.cleared === 'boolean') {
      lines.push(
        `# Cache cleared`,
        '',
        `_Cleared: ${result.cleared}_`,
        `_Cache size after: ${result.cacheSize ?? 0}_`,
      );
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
