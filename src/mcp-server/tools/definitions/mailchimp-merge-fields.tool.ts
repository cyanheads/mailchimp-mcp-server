/**
 * @fileoverview `mailchimp_merge_fields` — read + create/update of custom
 * subscriber attributes. No delete: deleting a merge field drops a column
 * of data across every subscriber. Humans do that in the Mailchimp UI.
 * @module mcp-server/tools/definitions/mailchimp-merge-fields.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import type { MergeField } from '@/services/mailchimp/types.js';

const OperationSchema = z
  .enum(['list', 'get', 'create', 'update'])
  .describe(
    'Which merge-field operation to run. No delete — deleting a merge field removes that data column from every subscriber record. Humans should do it in the Mailchimp UI.',
  );

const MergeFieldTypeSchema = z
  .enum([
    'text',
    'number',
    'address',
    'phone',
    'date',
    'url',
    'imageurl',
    'radio',
    'dropdown',
    'birthday',
    'zip',
  ])
  .describe('Merge-field type.');

const InputSchema = z.object({
  operation: OperationSchema,
  audienceId: z.string().describe('Audience (list) ID.'),
  mergeId: z.number().int().optional().describe('Merge-field ID. Required for `get` and `update`.'),
  name: z.string().optional().describe('Display name. Required for `create`.'),
  tag: z
    .string()
    .optional()
    .describe(
      'Merge tag (e.g. `FNAME`). Required for `create`. Limited to 10 characters upstream.',
    ),
  type: MergeFieldTypeSchema.optional().describe('Field type. Required for `create`.'),
  required: z.boolean().optional(),
  defaultValue: z.string().optional(),
  isPublic: z
    .boolean()
    .optional()
    .describe('Whether the field appears on public signup forms and subscriber-facing updates.'),
  helpText: z.string().optional(),
  displayOrder: z.number().int().optional(),
  options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Merge-field options (e.g. choices for dropdown, date format for date).'),
  count: z.number().int().min(1).max(1000).default(80),
  offset: z.number().int().min(0).default(0),
});

const MergeFieldSummarySchema = z.object({
  mergeId: z.number(),
  tag: z.string(),
  name: z.string(),
  type: z.string(),
  required: z.boolean().optional(),
  public: z.boolean().optional(),
  defaultValue: z.string().optional(),
  displayOrder: z.number().optional(),
  helpText: z.string().optional(),
});

const OutputSchema = z.object({
  operation: OperationSchema,
  mergeField: MergeFieldSummarySchema.optional(),
  mergeFields: z.array(MergeFieldSummarySchema).optional(),
  totalItems: z.number().optional(),
});

type Output = z.infer<typeof OutputSchema>;

function summarize(m: MergeField): z.infer<typeof MergeFieldSummarySchema> {
  const out: z.infer<typeof MergeFieldSummarySchema> = {
    mergeId: m.merge_id,
    tag: m.tag,
    name: m.name,
    type: m.type,
  };
  if (typeof m.required === 'boolean') out.required = m.required;
  if (typeof m.public === 'boolean') out.public = m.public;
  if (m.default_value) out.defaultValue = m.default_value;
  if (typeof m.display_order === 'number') out.displayOrder = m.display_order;
  if (m.help_text) out.helpText = m.help_text;
  return out;
}

function buildBody(input: z.infer<typeof InputSchema>, isCreate: boolean): Partial<MergeField> {
  const body: Partial<MergeField> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.tag !== undefined) body.tag = input.tag;
  if (input.type !== undefined) body.type = input.type;
  if (typeof input.required === 'boolean') body.required = input.required;
  if (input.defaultValue !== undefined) body.default_value = input.defaultValue;
  if (typeof input.isPublic === 'boolean') body.public = input.isPublic;
  if (input.helpText !== undefined) body.help_text = input.helpText;
  if (typeof input.displayOrder === 'number') body.display_order = input.displayOrder;
  if (input.options) body.options = input.options;
  if (isCreate) {
    const missing: string[] = [];
    if (!body.name) missing.push('name');
    if (!body.tag) missing.push('tag');
    if (!body.type) missing.push('type');
    if (missing.length > 0)
      throw validationError(`Missing required fields for 'create': ${missing.join(', ')}.`);
  }
  return body;
}

export const mailchimpMergeFieldsTool = tool('mailchimp_merge_fields', {
  description:
    'Read + create/update custom subscriber attributes (merge fields). Tags like `FNAME`, `LNAME`, `EMAIL` are baked into the audience schema and used by campaigns for personalization. This tool intentionally has no delete — removing a merge field drops a data column across every subscriber, which should happen in the Mailchimp UI with its confirmation dialog.',
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const audienceId = input.audienceId;

    switch (input.operation) {
      case 'list': {
        const { merge_fields, total_items } = await svc.mergeFields.list(ctx, audienceId, {
          count: input.count,
          offset: input.offset,
        });
        return {
          operation: 'list',
          totalItems: total_items,
          mergeFields: merge_fields.map(summarize),
        };
      }
      case 'get': {
        if (input.mergeId === undefined)
          throw validationError("'mergeId' is required for operation 'get'.");
        const mf = await svc.mergeFields.get(ctx, audienceId, input.mergeId);
        return { operation: 'get', mergeField: summarize(mf) };
      }
      case 'create': {
        const mf = await svc.mergeFields.create(ctx, audienceId, buildBody(input, true));
        ctx.log.info('merge field created', { mergeId: mf.merge_id, tag: mf.tag });
        return { operation: 'create', mergeField: summarize(mf) };
      }
      case 'update': {
        if (input.mergeId === undefined)
          throw validationError("'mergeId' is required for operation 'update'.");
        const mf = await svc.mergeFields.update(
          ctx,
          audienceId,
          input.mergeId,
          buildBody(input, false),
        );
        return { operation: 'update', mergeField: summarize(mf) };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.operation === 'list' && result.mergeFields) {
      lines.push(
        `# Merge fields (${result.mergeFields.length} of ${result.totalItems ?? '?'})`,
        '',
      );
      for (const m of result.mergeFields) {
        const req = m.required ? ' (required)' : '';
        lines.push(`- \`${m.tag}\` — ${m.name} [${m.type}]${req}`);
        if (m.helpText) lines.push(`  _${m.helpText}_`);
      }
    } else if (result.mergeField) {
      const m = result.mergeField;
      lines.push(
        `# \`${m.tag}\` — ${m.name}`,
        '',
        `**ID:** ${m.mergeId}  `,
        `**Type:** ${m.type}  `,
      );
      if (typeof m.required === 'boolean')
        lines.push(`**Required:** ${m.required ? 'yes' : 'no'}  `);
      if (typeof m.public === 'boolean') lines.push(`**Public:** ${m.public ? 'yes' : 'no'}  `);
      if (m.defaultValue) lines.push(`**Default:** ${m.defaultValue}  `);
      if (m.helpText) lines.push('', `> ${m.helpText}`);
    } else {
      lines.push(`Operation \`${result.operation}\` completed.`);
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
