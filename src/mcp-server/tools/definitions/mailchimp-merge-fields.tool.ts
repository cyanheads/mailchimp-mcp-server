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
  mergeId: z.coerce
    .number()
    .int()
    .optional()
    .describe('Merge-field ID. Required for `get` and `update`.'),
  name: z.string().optional().describe('Display name. Required for `create`.'),
  tag: z
    .string()
    .optional()
    .describe(
      'Merge tag (e.g. `FNAME`). Required for `create`. Limited to 10 characters upstream.',
    ),
  type: MergeFieldTypeSchema.optional().describe('Field type. Required for `create`.'),
  required: z
    .boolean()
    .optional()
    .describe('Whether this field is required on signup forms. Default `false`.'),
  defaultValue: z
    .string()
    .optional()
    .describe('Default value applied when a subscriber record has no explicit value.'),
  isPublic: z
    .boolean()
    .optional()
    .describe('Whether the field appears on public signup forms and subscriber-facing updates.'),
  helpText: z
    .string()
    .optional()
    .describe('Help text shown next to the field on signup/profile forms.'),
  displayOrder: z.coerce
    .number()
    .int()
    .optional()
    .describe('Order in which this field is displayed on signup forms (lower is earlier).'),
  options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Merge-field options (e.g. choices for dropdown, date format for date).'),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(80)
    .describe('Page size for `list`. Max 1000.'),
  offset: z.coerce.number().int().min(0).default(0).describe('Offset for `list` pagination.'),
});

const MergeFieldSummarySchema = z
  .object({
    mergeId: z.number().describe('Merge-field ID.'),
    tag: z.string().describe('Merge tag (e.g. `FNAME`, `EMAIL`).'),
    name: z.string().describe('Human-readable name.'),
    type: z.string().describe('Field type (`text`, `number`, `date`, `address`, …).'),
    required: z.boolean().optional().describe('Whether the field is required at signup.'),
    public: z.boolean().optional().describe('Whether the field is shown on public signup forms.'),
    defaultValue: z.string().optional().describe('Default value when the subscriber has none.'),
    displayOrder: z
      .number()
      .optional()
      .describe('Display order on signup forms (lower is earlier).'),
    helpText: z.string().optional().describe('Help text displayed next to the field.'),
  })
  .describe('Summary view of one merge-field definition.');

const OutputSchema = z.object({
  operation: OperationSchema,
  mergeField: MergeFieldSummarySchema.optional().describe(
    'Populated for `get`, `create`, `update`.',
  ),
  mergeFields: z.array(MergeFieldSummarySchema).optional().describe('Populated for `list`.'),
  totalItems: z
    .number()
    .optional()
    .describe('Total merge fields defined on the audience (for `list`).'),
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
    const lines: string[] = [`_Operation: ${result.operation}_`, ''];
    if (result.mergeFields) {
      lines.push(
        `# Merge fields (${result.mergeFields.length} of ${result.totalItems ?? '?'})`,
        '',
      );
      for (const m of result.mergeFields) {
        const req = m.required ? ' (required)' : '';
        const pub = typeof m.public === 'boolean' ? ` public: ${m.public}` : '';
        const def = m.defaultValue ? ` default: "${m.defaultValue}"` : '';
        const ord = typeof m.displayOrder === 'number' ? ` order: ${m.displayOrder}` : '';
        lines.push(`- [${m.mergeId}] \`${m.tag}\` — ${m.name} [${m.type}]${req}${pub}${def}${ord}`);
        if (m.helpText) lines.push(`  _${m.helpText}_`);
      }
    }
    if (result.mergeField) {
      const m = result.mergeField;
      if (result.mergeFields) lines.push('');
      lines.push(
        `# \`${m.tag}\` — ${m.name}`,
        '',
        `**ID:** ${m.mergeId}  `,
        `**Type:** ${m.type}  `,
      );
      if (typeof m.required === 'boolean')
        lines.push(`**Required:** ${m.required ? 'yes' : 'no'}  `);
      if (typeof m.public === 'boolean') lines.push(`**Public:** ${m.public}  `);
      if (m.defaultValue) lines.push(`**Default value:** ${m.defaultValue}  `);
      if (typeof m.displayOrder === 'number') lines.push(`**Display order:** ${m.displayOrder}  `);
      if (m.helpText) lines.push(`**Help text:** ${m.helpText}  `);
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
