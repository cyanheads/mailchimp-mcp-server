/**
 * @fileoverview `mailchimp_files` — Mailchimp File Manager (Content Studio)
 * surface. Upload images and other assets to Mailchimp's CDN, list / get /
 * rename / delete existing files, and browse folders. The upload response
 * includes a `fullSizeUrl` — that's the public URL to embed in campaign HTML
 * (`<img src="…">`). Works on every plan tier including free. Mailchimp size
 * caps: 1 MB per image, 10 MB per non-image file. Folder CRUD is intentionally
 * not exposed — use the Mailchimp UI for that, or just upload to the root.
 * @module mcp-server/tools/definitions/mailchimp-files.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import type { FileFolder, File as MailchimpFile } from '@/services/mailchimp/types.js';

const OperationSchema = z
  .enum(['list', 'get', 'upload', 'update', 'delete', 'list-folders', 'get-folder'])
  .describe(
    'Which file-manager operation to run. `list`/`get`/`upload`/`update`/`delete` work on individual files; `list-folders`/`get-folder` are read-only views of folders. Folder CRUD is intentionally not exposed — use the Mailchimp UI for organizing, or just upload to the root folder.',
  );

const FileTypeSchema = z
  .enum(['image', 'file'])
  .describe(
    'File classification. `image` for PNG/JPG/GIF/SVG (Mailchimp auto-detects width/height); `file` for everything else.',
  );

const InputSchema = z.object({
  operation: OperationSchema,
  fileId: z.coerce
    .number()
    .int()
    .optional()
    .describe('File ID. Required for `get`/`update`/`delete`.'),
  folderId: z.coerce
    .number()
    .int()
    .optional()
    .describe(
      'Folder ID. Required for `get-folder`. Optional on `list` (filter to folder), `upload` (place in folder), and `update` (move file — pass `0` to move to root).',
    ),
  name: z
    .string()
    .optional()
    .describe(
      'File name including extension (e.g. `hero.png`). Required for `upload`. Optional for `update` (rename). Mailchimp uses the extension to set the MIME type. Note: for images, the public URL uses an internal hash and does NOT include this name; for non-image files, the URL preserves the filename so downloads land sensibly.',
    ),
  fileData: z
    .string()
    .optional()
    .describe(
      'Base64-encoded file bytes (no `data:` prefix, no line breaks). Required for `upload`. **Mailchimp caps images at 1 MB and other files at 10 MB** — bytes over the cap return a validation error. Allowed extensions per Mailchimp: images (`.jpg`/`.jpeg`/`.png`/`.gif`/`.svg`/`.bmp`/`.tif`/`.tiff`/`.psd`/`.ai`/`.eps`/`.indd`/`.jpe`), documents (`.pdf`/`.doc`/`.docx`/`.rtf`/`.odt`/`.ott`/`.pages`/`.pub`/`.mobi`/`.epub`), text (`.txt`/`.csv`/`.log`/`.css`/`.ics`), audio (`.mp3`/`.m4a`/`.m4v`/`.wma`/`.ogg`/`.flac`/`.wav`/`.aif`/`.aifc`/`.aiff`), video (`.mp4`/`.mov`/`.avi`/`.mkv`/`.mpeg`/`.mpg`/`.wmv`), archives (`.zip` (no unsupported inner types)/`.vcf`). **`.webp` and `.avif` are not in the allowlist — convert to `.png`/`.jpg` before upload.**',
    ),
  type: FileTypeSchema.optional().describe('Filter by type for `list`.'),
  beforeCreatedAt: z
    .string()
    .optional()
    .describe('Filter `list` to files created before this ISO 8601 timestamp.'),
  sinceCreatedAt: z
    .string()
    .optional()
    .describe('Filter `list` to files created on or after this ISO 8601 timestamp.'),
  createdBy: z
    .string()
    .optional()
    .describe('Filter `list-folders` by the username that created the folder.'),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(10)
    .describe('Page size for `list`/`list-folders`. Max 1000.'),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Offset for `list`/`list-folders` pagination.'),
});

const FileSummarySchema = z
  .object({
    id: z.number().describe('File ID.'),
    name: z.string().describe('File name.'),
    type: z.string().optional().describe('`image` or `file`.'),
    folderId: z.number().optional().describe('Containing folder ID. `0` (or omitted) means root.'),
    fullSizeUrl: z
      .string()
      .describe(
        'Public CDN URL for the file. **This is what you embed in campaign HTML** (`<img src="…">`).',
      ),
    thumbnailUrl: z.string().optional().describe('Thumbnail URL (images only).'),
    size: z.number().optional().describe('File size in bytes.'),
    width: z.number().optional().describe('Pixel width (images only).'),
    height: z.number().optional().describe('Pixel height (images only).'),
    createdAt: z.string().optional().describe('ISO 8601 upload timestamp.'),
    createdBy: z.string().optional().describe('Display name of the uploader.'),
  })
  .describe('Summary view of one file.');

const FolderSummarySchema = z
  .object({
    id: z.number().describe('Folder ID.'),
    name: z.string().describe('Folder name.'),
    fileCount: z.number().optional().describe('Number of files in this folder.'),
    createdAt: z.string().optional().describe('ISO 8601 creation timestamp.'),
    createdBy: z.string().optional().describe('Display name of the creator.'),
  })
  .describe('Summary view of one folder.');

const OutputSchema = z.object({
  operation: OperationSchema,
  file: FileSummarySchema.optional().describe('Populated for `get` and `upload`.'),
  files: z.array(FileSummarySchema).optional().describe('Populated for `list`.'),
  folder: FolderSummarySchema.optional().describe('Populated for `get-folder`.'),
  folders: z.array(FolderSummarySchema).optional().describe('Populated for `list-folders`.'),
  totalItems: z
    .number()
    .optional()
    .describe('Total items from Mailchimp (for `list`/`list-folders`).'),
  totalFileSize: z
    .number()
    .optional()
    .describe('Aggregate size of all files in bytes (for `list`).'),
  deleted: z.boolean().optional().describe('True when the file was deleted (for `delete`).'),
});

type Output = z.infer<typeof OutputSchema>;

function summarizeFile(f: MailchimpFile): z.infer<typeof FileSummarySchema> {
  const out: z.infer<typeof FileSummarySchema> = {
    id: f.id,
    name: f.name,
    fullSizeUrl: f.full_size_url,
  };
  if (f.type) out.type = f.type;
  if (typeof f.folder_id === 'number') out.folderId = f.folder_id;
  if (f.thumbnail_url) out.thumbnailUrl = f.thumbnail_url;
  if (typeof f.size === 'number') out.size = f.size;
  if (typeof f.width === 'number') out.width = f.width;
  if (typeof f.height === 'number') out.height = f.height;
  if (f.created_at) out.createdAt = f.created_at;
  if (f.created_by) out.createdBy = f.created_by;
  return out;
}

function summarizeFolder(f: FileFolder): z.infer<typeof FolderSummarySchema> {
  const out: z.infer<typeof FolderSummarySchema> = { id: f.id, name: f.name };
  if (typeof f.file_count === 'number') out.fileCount = f.file_count;
  if (f.created_at) out.createdAt = f.created_at;
  if (f.created_by) out.createdBy = f.created_by;
  return out;
}

function requireFileId(input: z.infer<typeof InputSchema>): number {
  if (input.fileId === undefined)
    throw validationError(`'fileId' is required for operation '${input.operation}'.`);
  return input.fileId;
}

function requireFolderId(input: z.infer<typeof InputSchema>): number {
  if (input.folderId === undefined)
    throw validationError(`'folderId' is required for operation '${input.operation}'.`);
  return input.folderId;
}

function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number') return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB (${n} B)`;
  return `${(n / 1024 / 1024).toFixed(2)} MB (${n} B)`;
}

export const mailchimpFilesTool = tool('mailchimp_files', {
  description:
    'Upload, list, fetch, rename, and delete files in Mailchimp\'s File Manager (Content Studio). Use `upload` to push an image into Mailchimp — the response\'s `fullSizeUrl` is the public CDN URL to embed in campaign HTML (`<img src="…">`). Use `update` to rename a file or move it between folders (pass `folderId: 0` to move to root). Works on every plan tier (including free). **Size caps: 1 MB per image, 10 MB per non-image file.** For `upload`, encode the file bytes as base64 and pass via `fileData` along with a `name` that includes the extension — see `fileData` field for the allowed-extension list (note: WebP/AVIF are not allowed; convert first). Folder CRUD is not exposed; use the Mailchimp UI to create folders, or just upload to the root.',
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,
  errors: [
    {
      reason: 'mailchimp_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'Mailchimp returned 401 — API key invalid, revoked, or missing.',
      recovery:
        'Verify MAILCHIMP_API_KEY in env; rotate via Mailchimp → Account → Extras → API keys.',
    },
    {
      reason: 'mailchimp_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Mailchimp returned 403 — paid-tier feature or insufficient permissions.',
      recovery:
        'Inspect data.requiresPlan when present; otherwise the API key lacks scope for File Manager.',
    },
    {
      reason: 'mailchimp_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — file or folder does not exist or has been deleted.',
      recovery: 'Run mailchimp_files operation:list (or list-folders) to discover valid IDs.',
    },
    {
      reason: 'mailchimp_validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp returned 400 or 422 — usually file size over 1 MB (image) / 10 MB (other), disallowed extension, or malformed base64.',
      recovery:
        'Inspect data.upstream.errors[]; convert .webp/.avif to .png/.jpg, compress oversized files, and confirm fileData is plain base64 with no `data:` prefix.',
    },
    {
      reason: 'mailchimp_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Mailchimp returned 429 — too many concurrent requests.',
      recovery:
        'Retry after a brief delay; reduce MAILCHIMP_CONCURRENCY_LIMIT for bulk operations.',
      retryable: true,
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    switch (input.operation) {
      case 'list': {
        const params: Parameters<typeof svc.files.list>[1] = {
          count: input.count,
          offset: input.offset,
        };
        if (input.type) params.type = input.type;
        if (input.folderId !== undefined) params.folderId = input.folderId;
        if (input.beforeCreatedAt) params.beforeCreatedAt = input.beforeCreatedAt;
        if (input.sinceCreatedAt) params.sinceCreatedAt = input.sinceCreatedAt;
        const { files, total_file_size, total_items } = await svc.files.list(ctx, params);
        return {
          operation: 'list',
          totalItems: total_items,
          totalFileSize: total_file_size,
          files: files.map(summarizeFile),
        };
      }
      case 'get': {
        const f = await svc.files.get(ctx, requireFileId(input));
        return { operation: 'get', file: summarizeFile(f) };
      }
      case 'upload': {
        if (!input.name) throw validationError("'name' is required for 'upload'.");
        if (!input.fileData) throw validationError("'fileData' is required for 'upload'.");
        const body: Parameters<typeof svc.files.upload>[1] = {
          name: input.name,
          fileDataBase64: input.fileData,
        };
        if (input.folderId !== undefined) body.folderId = input.folderId;
        const f = await svc.files.upload(ctx, body);
        ctx.log.info('file uploaded', { fileId: f.id, name: f.name, size: f.size });
        return { operation: 'upload', file: summarizeFile(f) };
      }
      case 'update': {
        const id = requireFileId(input);
        const body: Parameters<typeof svc.files.update>[2] = {};
        if (input.name !== undefined) body.name = input.name;
        if (input.folderId !== undefined) body.folderId = input.folderId;
        if (Object.keys(body).length === 0)
          throw validationError(
            "Provide at least one of `name` (rename) or `folderId` (move; use `0` for root) for 'update'.",
          );
        const f = await svc.files.update(ctx, id, body);
        return { operation: 'update', file: summarizeFile(f) };
      }
      case 'delete': {
        await svc.files.delete(ctx, requireFileId(input));
        return { operation: 'delete', deleted: true };
      }
      case 'list-folders': {
        const params: Parameters<typeof svc.files.listFolders>[1] = {
          count: input.count,
          offset: input.offset,
        };
        if (input.createdBy) params.createdBy = input.createdBy;
        const { folders, total_items } = await svc.files.listFolders(ctx, params);
        return {
          operation: 'list-folders',
          totalItems: total_items,
          folders: folders.map(summarizeFolder),
        };
      }
      case 'get-folder': {
        const f = await svc.files.getFolder(ctx, requireFolderId(input));
        return { operation: 'get-folder', folder: summarizeFolder(f) };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`_Operation: ${result.operation}_`, ''];

    const renderFile = (f: z.infer<typeof FileSummarySchema>, bullet: boolean): void => {
      const prefix = bullet ? '- ' : '';
      const indent = bullet ? '  ' : '';
      const dims =
        typeof f.width === 'number' && typeof f.height === 'number'
          ? ` · ${f.width}×${f.height}`
          : '';
      lines.push(
        `${prefix}**${f.name}** (\`${f.id}\`) — ${f.type ?? 'file'} · ${formatBytes(f.size)}${dims}`,
      );
      lines.push(`${indent}fullSizeUrl: ${f.fullSizeUrl}`);
      if (f.thumbnailUrl) lines.push(`${indent}thumbnailUrl: ${f.thumbnailUrl}`);
      const meta: string[] = [];
      if (typeof f.folderId === 'number' && f.folderId > 0) meta.push(`folderId ${f.folderId}`);
      if (f.createdBy) meta.push(`createdBy ${f.createdBy}`);
      if (f.createdAt) meta.push(`createdAt ${f.createdAt}`);
      if (meta.length > 0) lines.push(`${indent}${meta.join(' · ')}`);
    };

    const renderFolder = (f: z.infer<typeof FolderSummarySchema>, bullet: boolean): void => {
      const prefix = bullet ? '- ' : '';
      const indent = bullet ? '  ' : '';
      lines.push(
        `${prefix}**${f.name}** (\`${f.id}\`)${typeof f.fileCount === 'number' ? ` — ${f.fileCount} files` : ''}`,
      );
      const meta: string[] = [];
      if (f.createdBy) meta.push(`createdBy ${f.createdBy}`);
      if (f.createdAt) meta.push(`createdAt ${f.createdAt}`);
      if (meta.length > 0) lines.push(`${indent}${meta.join(' · ')}`);
    };

    if (result.files) {
      lines.push(
        `# Files (${result.files.length} of ${result.totalItems ?? '?'}, total ${formatBytes(result.totalFileSize)})`,
        '',
      );
      if (result.files.length === 0) {
        lines.push('_No files. Use `operation: upload` to add one._');
      } else {
        for (const f of result.files) renderFile(f, true);
      }
    }

    if (result.file) {
      if (result.files) lines.push('');
      lines.push(
        `# ${result.file.name}`,
        '',
        result.operation === 'upload'
          ? '_Uploaded. Embed `fullSizeUrl` below in your campaign HTML (`<img src="…">`)._'
          : '',
      );
      if (result.operation === 'upload') lines.push('');
      renderFile(result.file, false);
    }

    if (result.folders) {
      lines.push(`# Folders (${result.folders.length} of ${result.totalItems ?? '?'})`, '');
      if (result.folders.length === 0) {
        lines.push(
          '_No folders. Files default to the root folder when uploaded without `folderId`._',
        );
      } else {
        for (const f of result.folders) renderFolder(f, true);
      }
    }

    if (result.folder) {
      if (result.folders) lines.push('');
      lines.push(`# ${result.folder.name}`, '');
      renderFolder(result.folder, false);
    }

    if (typeof result.deleted === 'boolean') lines.push('', `_Deleted: ${result.deleted}_`);

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
