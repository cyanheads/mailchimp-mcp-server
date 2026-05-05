/**
 * @fileoverview `mailchimp_templates` — Mailchimp-hosted template surface.
 * **For authoring new templates, prefer `mailchimp_local_templates` (L2)** — it
 * works on every plan tier (including free, where this tool's writes are
 * forbidden) and templates live as `.eta` files under
 * `MAILCHIMP_TEMPLATES_DIR`. This tool is for reading existing Mailchimp
 * templates and (paid only) syncing changes upstream. Reads (`list`, `get`,
 * `get-default-content`) work for `base` and `user` types on free; all writes
 * (`create`, `update`, `delete`) require a paid plan regardless of `type`.
 * `gallery` (paid drag-and-drop) is read-gated too.
 * @module mcp-server/tools/definitions/mailchimp-templates.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import type { Template } from '@/services/mailchimp/types.js';

const OperationSchema = z
  .enum(['list', 'get', 'create', 'update', 'delete', 'get-default-content'])
  .describe(
    'Template operation. `list`/`get` are reads (work on free for `base`/`user` types). `create`/`update`/`delete` are paid-tier writes. `get-default-content` returns the per-section default content map (populated for drag-and-drop templates).',
  );

const InputSchema = z.object({
  operation: OperationSchema,
  templateId: z.coerce
    .number()
    .int()
    .optional()
    .describe('Template ID. Required for `get`/`update`/`delete`/`get-default-content`.'),
  name: z.string().optional().describe('Template name. Required for `create`.'),
  html: z
    .string()
    .optional()
    .describe('Template HTML. Required for `create`; optional for `update`.'),
  folderId: z.string().optional().describe('Folder ID to place the template in.'),
  type: z
    .enum(['user', 'base', 'gallery'])
    .optional()
    .describe(
      'Filter by type for `list`. `user` = your saved templates; `base` = Mailchimp starter layouts; `gallery` = paid drag-and-drop designs.',
    ),
  category: z
    .string()
    .optional()
    .describe('Category filter for `list` (e.g. `Newsletter`, `Notification`, `E-commerce`).'),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(20)
    .describe('Page size for `list`. Max 1000.'),
  offset: z.coerce.number().int().min(0).default(0).describe('Offset for `list` pagination.'),
});

const TemplateSummarySchema = z
  .object({
    id: z.number().describe('Template ID.'),
    name: z.string().describe('Template display name.'),
    type: z.string().optional().describe('`user`, `base`, or `gallery`.'),
    category: z
      .string()
      .optional()
      .describe('Mailchimp category (e.g. `Newsletter`, `Notification`).'),
    createdBy: z.string().optional().describe('Username of the template creator.'),
    dateCreated: z.string().optional().describe('ISO 8601 creation timestamp.'),
    dateEdited: z.string().optional().describe('ISO 8601 last-edited timestamp.'),
    active: z.boolean().optional().describe('Whether the template is active (undeleted).'),
    dragAndDrop: z.boolean().optional().describe('True for Mailchimp drag-and-drop templates.'),
    responsive: z.boolean().optional().describe('Whether the template renders responsively.'),
    thumbnail: z.string().optional().describe('URL of the template thumbnail image.'),
    shareUrl: z.string().optional().describe('Public share URL for the template.'),
  })
  .describe('Summary view of one template.');

const OutputSchema = z.object({
  operation: OperationSchema,
  template: TemplateSummarySchema.optional().describe('Populated for `get`, `create`, `update`.'),
  templates: z.array(TemplateSummarySchema).optional().describe('Populated for `list`.'),
  totalItems: z.number().optional().describe('Total items from Mailchimp (for `list`).'),
  defaultContent: z
    .object({
      sections: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Section name → default content mapping.'),
    })
    .optional()
    .describe('Populated for `get-default-content`.'),
  deleted: z.boolean().optional().describe('True when the template was deleted (for `delete`).'),
});

type Output = z.infer<typeof OutputSchema>;

function summarize(t: Template): z.infer<typeof TemplateSummarySchema> {
  const out: z.infer<typeof TemplateSummarySchema> = { id: t.id, name: t.name };
  if (t.type) out.type = t.type;
  if (t.category) out.category = t.category;
  if (t.created_by) out.createdBy = t.created_by;
  if (t.date_created) out.dateCreated = t.date_created;
  if (t.date_edited) out.dateEdited = t.date_edited;
  if (typeof t.active === 'boolean') out.active = t.active;
  if (typeof t.drag_and_drop === 'boolean') out.dragAndDrop = t.drag_and_drop;
  if (typeof t.responsive === 'boolean') out.responsive = t.responsive;
  if (t.thumbnail) out.thumbnail = t.thumbnail;
  if (t.share_url) out.shareUrl = t.share_url;
  return out;
}

function requireTemplateId(input: z.infer<typeof InputSchema>): number {
  if (input.templateId === undefined)
    throw validationError(`'templateId' is required for operation '${input.operation}'.`);
  return input.templateId;
}

export const mailchimpTemplatesTool = tool('mailchimp_templates', {
  description:
    "Mailchimp-hosted template surface. **For authoring new templates, prefer `mailchimp_local_templates` — that tool works on every plan tier (including free, where the writes here are forbidden) and templates live as `.eta` files under `MAILCHIMP_TEMPLATES_DIR`, git-versionable and composable via partials.** Use this tool for reading existing Mailchimp templates (`list`, `get`, `get-default-content` — work on free for `base`/`user` types) or, on paid plans, syncing changes upstream via `create`/`update`/`delete`. **All writes require a paid plan regardless of `type`** and return `Forbidden` with `requiresPlan: 'standard'`. `gallery` (paid drag-and-drop) is read-gated too. Deleting a template doesn't affect campaigns already built from it, so delete is safe to expose. **Per-section editing is not supported here** — Mailchimp's templates PATCH endpoint only accepts `name`, `html`, and `folderId`; to change one block, GET the template, edit its HTML, then `update` with the full new HTML. Per-section overrides (by edit-region ID) live on campaigns built from a template, via `mailchimp_campaigns` (`set-content`) or `mailchimp_send_campaign` with `templateSections`. **To bootstrap a local template from a Mailchimp `base`/`user` starter, use `mailchimp_local_templates` with `operation: seed-from-mailchimp`.**",
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
      when: 'Mailchimp returned 403 — template writes (create/update/delete) and gallery reads are paid-only; data.requiresPlan typically reports `standard`.',
      recovery:
        'Use mailchimp_local_templates instead — it works on every plan tier (templates live as .eta files under MAILCHIMP_TEMPLATES_DIR). Use seed-from-mailchimp to bootstrap from a base/user template.',
    },
    {
      reason: 'mailchimp_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — template does not exist or has been deleted.',
      recovery: 'Run mailchimp_templates operation:list to discover valid templateId values.',
    },
    {
      reason: 'mailchimp_validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp returned 400 or 422 — usually a malformed HTML body, missing mc:edit regions, or invalid folderId.',
      recovery:
        'Inspect data.upstream.errors[]; ensure HTML includes mc:edit="…" attributes for editable regions.',
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
        const q: Parameters<typeof svc.templates.list>[1] = {
          count: input.count,
          offset: input.offset,
        };
        if (input.type) q.type = input.type;
        if (input.category) q.category = input.category;
        if (input.folderId) q.folderId = input.folderId;
        const { templates, total_items } = await svc.templates.list(ctx, q);
        return {
          operation: 'list',
          totalItems: total_items,
          templates: templates.map(summarize),
        };
      }
      case 'get': {
        const t = await svc.templates.get(ctx, requireTemplateId(input));
        return { operation: 'get', template: summarize(t) };
      }
      case 'create': {
        if (!input.name) throw validationError("'name' is required for 'create'.");
        if (!input.html) throw validationError("'html' is required for 'create'.");
        const body: Parameters<typeof svc.templates.create>[1] = {
          name: input.name,
          html: input.html,
          ...(input.folderId ? { folder_id: input.folderId } : {}),
        };
        const t = await svc.templates.create(ctx, body);
        ctx.log.info('template created', { templateId: t.id });
        return { operation: 'create', template: summarize(t) };
      }
      case 'update': {
        const id = requireTemplateId(input);
        const body: Parameters<typeof svc.templates.update>[2] = {};
        if (input.name) body.name = input.name;
        if (input.html) body.html = input.html;
        if (input.folderId) body.folder_id = input.folderId;
        if (Object.keys(body).length === 0)
          throw validationError(
            'Provide at least one of `name`, `html`, or `folderId`. To edit one block of the template, GET the template, modify its HTML, then call `update` with the full new HTML — Mailchimp does not support patching individual sections here. Per-section overrides live on campaigns built from a template, via `mailchimp_campaigns` (`set-content`) or `mailchimp_send_campaign` with `templateSections`.',
          );
        const t = await svc.templates.update(ctx, id, body);
        return { operation: 'update', template: summarize(t) };
      }
      case 'delete': {
        await svc.templates.delete(ctx, requireTemplateId(input));
        return { operation: 'delete', deleted: true };
      }
      case 'get-default-content': {
        const content = await svc.templates.defaultContent(ctx, requireTemplateId(input));
        return {
          operation: 'get-default-content',
          defaultContent: content.sections ? { sections: content.sections } : {},
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`_Operation: ${result.operation}_`, ''];

    const renderSummary = (t: z.infer<typeof TemplateSummarySchema>, bullet: boolean): void => {
      const prefix = bullet ? '- ' : '';
      const indent = bullet ? '  ' : '';
      lines.push(
        `${prefix}**${t.name}** (\`${t.id}\`) — ${t.type ?? 'unknown'}${t.category ? ` · ${t.category}` : ''}`,
      );
      const meta: string[] = [];
      if (t.createdBy) meta.push(`createdBy ${t.createdBy}`);
      if (t.dateCreated) meta.push(`dateCreated ${t.dateCreated}`);
      if (t.dateEdited) meta.push(`dateEdited ${t.dateEdited}`);
      if (meta.length > 0) lines.push(`${indent}${meta.join(' · ')}`);
      const flags: string[] = [];
      if (typeof t.active === 'boolean') flags.push(`active ${t.active}`);
      if (typeof t.dragAndDrop === 'boolean') flags.push(`dragAndDrop ${t.dragAndDrop}`);
      if (typeof t.responsive === 'boolean') flags.push(`responsive ${t.responsive}`);
      if (flags.length > 0) lines.push(`${indent}${flags.join(' · ')}`);
      if (t.thumbnail) lines.push(`${indent}thumbnail: ${t.thumbnail}`);
      if (t.shareUrl) lines.push(`${indent}shareUrl: ${t.shareUrl}`);
    };

    if (result.templates) {
      lines.push(`# Templates (${result.templates.length} of ${result.totalItems ?? '?'})`, '');
      for (const t of result.templates) renderSummary(t, true);
    }

    if (result.template) {
      if (result.templates) lines.push('');
      lines.push(`# ${result.template.name}`, '');
      renderSummary(result.template, false);
    }

    if (result.defaultContent) {
      const sections = result.defaultContent.sections ?? {};
      const count = Object.keys(sections).length;
      lines.push('', `# Default content sections (${count})`, '');
      if (count === 0) {
        lines.push(
          '_No default sections recorded. Mailchimp only populates this map for drag-and-drop templates; for user-uploaded HTML templates that use `mc:edit`, read the HTML directly (`operation: get`) and pull the region names from the `mc:edit="…"` attributes. Use those names as the keys in `templateSections` when building a campaign from this template._',
        );
      } else {
        lines.push('```json', JSON.stringify(sections, null, 2), '```');
      }
    }

    if (typeof result.deleted === 'boolean') lines.push('', `_Deleted: ${result.deleted}_`);

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
