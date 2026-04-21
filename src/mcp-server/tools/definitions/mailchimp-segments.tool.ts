/**
 * @fileoverview `mailchimp_segments` — segment CRUD + member assignment.
 * Free tier supports static and basic saved segments; advanced dynamic
 * conditions require Premium.
 * @module mcp-server/tools/definitions/mailchimp-segments.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import type { Segment } from '@/services/mailchimp/types.js';

const OperationSchema = z
  .enum(['list', 'get', 'create', 'update', 'delete', 'list-members', 'batch-update-members'])
  .describe(
    'Segment operation. `batch-update-members` adds/removes many subscribers from a static segment in one call — use deliberately, it can mutate a large number of memberships.',
  );

const SegmentConditionSchema = z.object({
  condition_type: z.string().describe('Condition family (e.g. `TextMerge`, `StaticSegment`).'),
  field: z.string().describe('Field to match (e.g. `merge1`, `FNAME`).'),
  op: z.string().describe('Comparison operator (e.g. `is`, `contains`, `greater`).'),
  value: z.unknown().optional(),
  extra: z.string().optional(),
});

const SegmentOptionsSchema = z.object({
  match: z.enum(['any', 'all']).optional().describe('Match ANY or ALL conditions.'),
  conditions: z.array(SegmentConditionSchema).optional(),
});

const InputSchema = z.object({
  operation: OperationSchema,
  audienceId: z.string().describe('Audience (list) ID the segment belongs to.'),
  segmentId: z
    .number()
    .int()
    .optional()
    .describe('Segment ID. Required for every operation except `list` and `create`.'),
  name: z
    .string()
    .optional()
    .describe('Segment name. Required for `create`, optional for `update`.'),
  staticEmails: z
    .array(z.string())
    .optional()
    .describe(
      'Static-segment email list. Creates a static segment when used on `create`/`update`.',
    ),
  options: SegmentOptionsSchema.optional().describe(
    'Saved-segment conditions (for dynamic segments).',
  ),
  membersToAdd: z
    .array(z.string())
    .optional()
    .describe('Emails to add. Used by `batch-update-members`.'),
  membersToRemove: z
    .array(z.string())
    .optional()
    .describe('Emails to remove. Used by `batch-update-members`.'),
  type: z.enum(['saved', 'static', 'fuzzy']).optional().describe('Filter (for `list`).'),
  count: z.number().int().min(1).max(1000).default(20).describe('Page size for list-style reads.'),
  offset: z.number().int().min(0).default(0).describe('Offset for list-style reads.'),
});

const SegmentSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  memberCount: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  match: z.enum(['any', 'all']).optional(),
  conditionCount: z.number().optional(),
});

const OutputSchema = z.object({
  operation: OperationSchema,
  segment: SegmentSummarySchema.optional().describe('Populated for `get`, `create`, `update`.'),
  segments: z.array(SegmentSummarySchema).optional().describe('Populated for `list`.'),
  totalItems: z.number().optional().describe('Total items for `list` / `list-members`.'),
  members: z
    .array(z.object({ id: z.string(), email: z.string(), status: z.string() }))
    .optional()
    .describe('Subscribers in the segment. Populated for `list-members`.'),
  added: z.array(z.string()).optional().describe('Emails added by `batch-update-members`.'),
  removed: z.array(z.string()).optional().describe('Emails removed by `batch-update-members`.'),
  errors: z
    .array(z.object({ email: z.string(), error: z.string() }))
    .optional()
    .describe('Per-row errors from `batch-update-members`.'),
  deleted: z.boolean().optional().describe('True when the segment was deleted (for `delete`).'),
});

type Output = z.infer<typeof OutputSchema>;

function summarize(s: Segment): z.infer<typeof SegmentSummarySchema> {
  const out: z.infer<typeof SegmentSummarySchema> = {
    id: s.id,
    name: s.name,
    type: s.type,
  };
  if (typeof s.member_count === 'number') out.memberCount = s.member_count;
  if (s.created_at) out.createdAt = s.created_at;
  if (s.updated_at) out.updatedAt = s.updated_at;
  if (s.options?.match) out.match = s.options.match;
  if (s.options?.conditions) out.conditionCount = s.options.conditions.length;
  return out;
}

function requireSegmentId(input: z.infer<typeof InputSchema>): number {
  if (input.segmentId === undefined)
    throw validationError(`'segmentId' is required for operation '${input.operation}'.`);
  return input.segmentId;
}

export const mailchimpSegmentsTool = tool('mailchimp_segments', {
  description:
    'CRUD for audience segments (saved, static, fuzzy) plus member listing and batch member add/remove for static segments. Free plan supports static + basic saved segments; Premium is required for advanced dynamic filters. Use `batch-update-members` to add/remove many subscribers in a single call — the operation is NOT reversible in one shot.',
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const audienceId = input.audienceId;

    switch (input.operation) {
      case 'list': {
        const { segments, total_items } = await svc.segments.list(ctx, audienceId, {
          count: input.count,
          offset: input.offset,
          ...(input.type ? { type: input.type } : {}),
        });
        return {
          operation: 'list',
          totalItems: total_items,
          segments: segments.map(summarize),
        };
      }

      case 'get': {
        const seg = await svc.segments.get(ctx, audienceId, requireSegmentId(input));
        return { operation: 'get', segment: summarize(seg) };
      }

      case 'create': {
        if (!input.name) throw validationError("'name' is required for 'create'.");
        const body: Parameters<typeof svc.segments.create>[2] = { name: input.name };
        if (input.staticEmails) body.static_segment = input.staticEmails;
        if (input.options) body.options = input.options;
        const seg = await svc.segments.create(ctx, audienceId, body);
        ctx.log.info('segment created', { segmentId: seg.id, name: seg.name });
        return { operation: 'create', segment: summarize(seg) };
      }

      case 'update': {
        const body: Parameters<typeof svc.segments.update>[3] = {};
        if (input.name !== undefined) body.name = input.name;
        if (input.staticEmails) body.static_segment = input.staticEmails;
        if (input.options) body.options = input.options;
        if (Object.keys(body).length === 0)
          throw validationError('At least one updatable field is required.');
        const seg = await svc.segments.update(ctx, audienceId, requireSegmentId(input), body);
        return { operation: 'update', segment: summarize(seg) };
      }

      case 'delete': {
        await svc.segments.delete(ctx, audienceId, requireSegmentId(input));
        return { operation: 'delete', deleted: true };
      }

      case 'list-members': {
        const { members, total_items } = await svc.segments.listMembers(
          ctx,
          audienceId,
          requireSegmentId(input),
          { count: input.count, offset: input.offset },
        );
        return {
          operation: 'list-members',
          totalItems: total_items,
          members: members.map((m) => ({ id: m.id, email: m.email_address, status: m.status })),
        };
      }

      case 'batch-update-members': {
        if (!input.membersToAdd && !input.membersToRemove) {
          throw validationError(
            "At least one of 'membersToAdd' or 'membersToRemove' is required for 'batch-update-members'.",
          );
        }
        const body: Parameters<typeof svc.segments.batchUpdateMembers>[3] = {};
        if (input.membersToAdd) body.members_to_add = input.membersToAdd;
        if (input.membersToRemove) body.members_to_remove = input.membersToRemove;
        const resp = await svc.segments.batchUpdateMembers(
          ctx,
          audienceId,
          requireSegmentId(input),
          body,
        );
        ctx.log.info('segment batch-update', {
          segmentId: input.segmentId,
          added: resp.total_added,
          removed: resp.total_removed,
          errors: resp.error_count,
        });
        return {
          operation: 'batch-update-members',
          added: resp.members_added.map((m) => m.email_address),
          removed: resp.members_removed.map((m) => m.email_address),
          errors: resp.errors.map((e) => ({ email: e.email_address, error: e.error })),
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`_Operation: ${result.operation}_`, ''];

    const renderSummary = (s: z.infer<typeof SegmentSummarySchema>, bullet: boolean): void => {
      const prefix = bullet ? '- ' : '';
      const indent = bullet ? '  ' : '';
      lines.push(
        `${prefix}**${s.name}** (\`${s.id}\`) — type:${s.type}${typeof s.memberCount === 'number' ? `, memberCount ${s.memberCount}` : ''}`,
      );
      const meta: string[] = [];
      if (s.match) meta.push(`match ${s.match}`);
      if (typeof s.conditionCount === 'number') meta.push(`conditionCount ${s.conditionCount}`);
      if (s.createdAt) meta.push(`createdAt ${s.createdAt}`);
      if (s.updatedAt) meta.push(`updatedAt ${s.updatedAt}`);
      if (meta.length > 0) lines.push(`${indent}${meta.join(' · ')}`);
    };

    if (result.segments) {
      lines.push(`# Segments (${result.segments.length} of ${result.totalItems ?? '?'})`, '');
      for (const s of result.segments) renderSummary(s, true);
    }

    if (result.segment) {
      if (result.segments) lines.push('');
      lines.push(`# ${result.segment.name}`, '');
      renderSummary(result.segment, false);
    }

    if (result.members) {
      lines.push(
        '',
        `# Members in segment (${result.members.length} of ${result.totalItems ?? '?'})`,
        '',
      );
      for (const m of result.members) lines.push(`- [${m.id}] ${m.email} — status:${m.status}`);
    }

    if (result.added !== undefined || result.removed !== undefined) {
      lines.push('', '# Segment membership updated');
      lines.push(
        `- added: ${result.added?.length ?? 0}${result.added?.length ? ` (${result.added.join(', ')})` : ''}`,
      );
      lines.push(
        `- removed: ${result.removed?.length ?? 0}${result.removed?.length ? ` (${result.removed.join(', ')})` : ''}`,
      );
    }

    if (result.errors && result.errors.length > 0) {
      lines.push('', `## Errors (${result.errors.length})`, '');
      for (const e of result.errors) lines.push(`- \`${e.email}\`: ${e.error}`);
    }

    if (typeof result.deleted === 'boolean') lines.push('', `_Deleted: ${result.deleted}_`);

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
