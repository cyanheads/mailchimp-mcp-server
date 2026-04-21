/**
 * @fileoverview `mailchimp_templates` — template CRUD. Free plan has access
 * to basic templates only (the `gallery` drag-and-drop builder is paid).
 * Delete IS exposed here (unlike merge-fields/campaigns/audiences) because
 * templates are non-destructive — deleting a template doesn't affect any
 * campaign that was already built from it.
 * @module mcp-server/tools/definitions/mailchimp-templates.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import type { Template } from '@/services/mailchimp/types.js';

const OperationSchema = z
  .enum(['list', 'get', 'create', 'update', 'delete', 'get-default-content'])
  .describe('Template operation.');

const InputSchema = z.object({
  operation: OperationSchema,
  templateId: z
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
  category: z.string().optional().describe('Category filter for `list`.'),
  count: z.number().int().min(1).max(1000).default(20).describe('Page size for `list`. Max 1000.'),
  offset: z.number().int().min(0).default(0).describe('Offset for `list` pagination.'),
});

const TemplateSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
  category: z.string().optional(),
  createdBy: z.string().optional(),
  dateCreated: z.string().optional(),
  dateEdited: z.string().optional(),
  active: z.boolean().optional(),
  dragAndDrop: z.boolean().optional(),
  responsive: z.boolean().optional(),
  thumbnail: z.string().optional(),
  shareUrl: z.string().optional(),
});

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
    "Create, read, update, delete email templates. Free plan supports `base` (starter layouts) and `user` (your saved templates); `gallery` (paid drag-and-drop) will return a `Forbidden` error with `requiresPlan: 'standard'`. Deleting a template doesn't affect campaigns already built from it, so delete is safe to expose.",
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

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
          throw validationError('At least one of name/html/folderId must be provided for update.');
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
      lines.push('', '# Default content sections', '', '```json');
      lines.push(JSON.stringify(result.defaultContent.sections ?? {}, null, 2));
      lines.push('```');
    }

    if (typeof result.deleted === 'boolean') lines.push('', `_Deleted: ${result.deleted}_`);

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
