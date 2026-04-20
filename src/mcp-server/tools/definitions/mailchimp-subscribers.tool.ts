/**
 * @fileoverview `mailchimp_subscribers` tool — CRUD-except-permanent-delete for
 * list members, plus tags/notes/activity. `archive` is the strongest
 * removal (preserves the record so the email can re-subscribe). No
 * `delete-permanent` — GDPR-forget is irreversible. Upsert lives in the
 * `mailchimp_upsert_subscriber` workflow tool.
 * @module mcp-server/tools/definitions/mailchimp-subscribers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  getMailchimpService,
  mailchimpMemberHash,
} from '@/services/mailchimp/mailchimp-service.js';
import type { Subscriber } from '@/services/mailchimp/types.js';

const OperationSchema = z
  .enum([
    'list',
    'get',
    'update',
    'archive',
    'list-tags',
    'set-tags',
    'list-notes',
    'add-note',
    'update-note',
    'delete-note',
    'list-activity',
    'list-events',
    'list-goals',
  ])
  .describe(
    'Which subscriber operation to run. `list`/`get` reads. `update` changes status/merge fields/language (NOT for create — use `mailchimp_upsert_subscriber`). `archive` removes the subscriber from the active audience while preserving the record so they can resubscribe. `list-tags` and `set-tags` manage tags. `list-notes`/`add-note`/`update-note`/`delete-note` manage CRM-style notes. `list-activity`/`list-events`/`list-goals` are engagement reads.',
  );

const InputSchema = z.object({
  operation: OperationSchema,
  audienceId: z.string().describe('Audience (list) ID.'),
  email: z
    .string()
    .optional()
    .describe(
      'Subscriber email address. Required for every operation except `list`. Hashed internally to the Mailchimp `subscriber_hash` URL segment.',
    ),
  status: z
    .enum(['subscribed', 'unsubscribed', 'cleaned', 'pending', 'transactional'])
    .optional()
    .describe('Filter (for `list`) or new status (for `update`).'),
  mergeFields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Merge-field values (e.g. `{ FNAME: "Ada" }`). Used by `update`.'),
  language: z.string().optional().describe('ISO 639-1 language code. Used by `update`.'),
  vip: z.boolean().optional().describe('Flag subscriber as VIP. Used by `update`.'),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Desired tag set for `set-tags`. This is *declarative* — the provided list becomes the full active tag set; tags not in the list are removed.',
    ),
  note: z.string().optional().describe('Note body. Required for `add-note`/`update-note`.'),
  noteId: z
    .number()
    .int()
    .optional()
    .describe('Note ID. Required for `update-note`/`delete-note`.'),
  count: z.number().int().min(1).max(1000).default(20).describe('Page size for list-style reads.'),
  offset: z.number().int().min(0).default(0).describe('Offset for list-style reads.'),
});

const SubscriberSummarySchema = z.object({
  id: z.string().describe('Mailchimp subscriber ID (the member hash).'),
  email: z.string(),
  status: z.string(),
  fullName: z.string().optional(),
  vip: z.boolean().optional(),
  language: z.string().optional(),
  memberRating: z.number().optional(),
  lastChanged: z.string().optional(),
  source: z.string().optional(),
  tagsCount: z.number().optional(),
  timestampSignup: z.string().optional(),
  timestampOpt: z.string().optional(),
  mergeFields: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
  stats: z
    .object({
      avgOpenRate: z.number().optional(),
      avgClickRate: z.number().optional(),
    })
    .optional(),
});

const OutputSchema = z.object({
  operation: OperationSchema,
  subscriber: SubscriberSummarySchema.optional(),
  subscribers: z.array(SubscriberSummarySchema).optional(),
  totalItems: z.number().optional(),
  tagsActive: z
    .array(z.object({ id: z.number(), name: z.string(), dateAdded: z.string().optional() }))
    .optional()
    .describe('Currently active tags on this subscriber.'),
  tagsAdded: z.array(z.string()).optional().describe('Tag names added by `set-tags`.'),
  tagsRemoved: z.array(z.string()).optional().describe('Tag names removed by `set-tags`.'),
  notes: z
    .array(
      z.object({
        id: z.number(),
        note: z.string(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        createdBy: z.string().optional(),
      }),
    )
    .optional(),
  note: z
    .object({
      id: z.number(),
      note: z.string(),
      createdAt: z.string().optional(),
    })
    .optional(),
  activity: z.array(z.record(z.string(), z.unknown())).optional(),
  events: z.array(z.record(z.string(), z.unknown())).optional(),
  goals: z.array(z.record(z.string(), z.unknown())).optional(),
  deleted: z.boolean().optional().describe('Populated for `archive` and `delete-note`.'),
});

type Output = z.infer<typeof OutputSchema>;

function summarize(s: Subscriber): z.infer<typeof SubscriberSummarySchema> {
  const out: z.infer<typeof SubscriberSummarySchema> = {
    id: s.id,
    email: s.email_address,
    status: s.status,
  };
  if (s.full_name) out.fullName = s.full_name;
  if (typeof s.vip === 'boolean') out.vip = s.vip;
  if (s.language) out.language = s.language;
  if (typeof s.member_rating === 'number') out.memberRating = s.member_rating;
  if (s.last_changed) out.lastChanged = s.last_changed;
  if (s.source) out.source = s.source;
  if (typeof s.tags_count === 'number') out.tagsCount = s.tags_count;
  if (s.timestamp_signup) out.timestampSignup = s.timestamp_signup;
  if (s.timestamp_opt) out.timestampOpt = s.timestamp_opt;
  if (s.merge_fields && Object.keys(s.merge_fields).length > 0) out.mergeFields = s.merge_fields;
  if (s.tags && s.tags.length > 0) out.tags = s.tags.map((t) => ({ id: t.id, name: t.name }));
  if (s.stats) {
    const stats: NonNullable<z.infer<typeof SubscriberSummarySchema>['stats']> = {};
    if (typeof s.stats.avg_open_rate === 'number') stats.avgOpenRate = s.stats.avg_open_rate;
    if (typeof s.stats.avg_click_rate === 'number') stats.avgClickRate = s.stats.avg_click_rate;
    if (Object.keys(stats).length > 0) out.stats = stats;
  }
  return out;
}

function requireEmail(email: string | undefined, op: string): string {
  if (!email) throw validationError(`'email' is required for operation '${op}'.`);
  return email;
}

export const mailchimpSubscribersTool = tool('mailchimp_subscribers', {
  description:
    "Manage subscribers (Mailchimp 'list members') — CRUD except permanent-delete, plus tags/notes/activity. Use `mailchimp_upsert_subscriber` to add a new subscriber (that tool handles tags and notes in one idempotent call). `archive` is the strongest removal available; it takes the subscriber out of the active audience but preserves the record, so they can resubscribe. GDPR-forget (`delete-permanent`) is NOT exposed — do it in the Mailchimp UI.",
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const audienceId = input.audienceId;

    switch (input.operation) {
      case 'list': {
        const listOpts: Parameters<typeof svc.subscribers.list>[2] = {
          count: input.count,
          offset: input.offset,
        };
        if (input.status) listOpts.status = input.status;
        if (input.email) listOpts.email = input.email;
        const { members, total_items } = await svc.subscribers.list(ctx, audienceId, listOpts);
        return {
          operation: 'list',
          subscribers: members.map(summarize),
          totalItems: total_items,
        };
      }

      case 'get': {
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'get'));
        const sub = await svc.subscribers.get(ctx, audienceId, hash);
        return { operation: 'get', subscriber: summarize(sub) };
      }

      case 'update': {
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'update'));
        const body: Partial<Subscriber> = {};
        if (input.status) body.status = input.status;
        if (input.mergeFields) body.merge_fields = input.mergeFields;
        if (input.language) body.language = input.language;
        if (typeof input.vip === 'boolean') body.vip = input.vip;
        if (Object.keys(body).length === 0) {
          throw validationError(
            "At least one of `status`, `mergeFields`, `language`, or `vip` must be provided for 'update'.",
          );
        }
        const sub = await svc.subscribers.update(ctx, audienceId, hash, body);
        return { operation: 'update', subscriber: summarize(sub) };
      }

      case 'archive': {
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'archive'));
        await svc.subscribers.archive(ctx, audienceId, hash);
        ctx.log.info('subscriber archived', { email: input.email });
        return { operation: 'archive', deleted: true };
      }

      case 'list-tags': {
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'list-tags'));
        const { tags, total_items } = await svc.subscribers.listTags(ctx, audienceId, hash, {
          count: input.count,
          offset: input.offset,
        });
        return {
          operation: 'list-tags',
          totalItems: total_items,
          tagsActive: tags.map((t) => {
            const entry: NonNullable<Output['tagsActive']>[number] = { id: t.id, name: t.name };
            if (t.date_added) entry.dateAdded = t.date_added;
            return entry;
          }),
        };
      }

      case 'set-tags': {
        if (!input.tags) {
          throw validationError(
            "'tags' is required for 'set-tags' (pass an empty array to remove all).",
          );
        }
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'set-tags'));
        const { tags: currentTags } = await svc.subscribers.listTags(ctx, audienceId, hash, {
          count: 1000,
        });
        const current = new Set(currentTags.map((t) => t.name));
        const desired = new Set(input.tags);
        const toAdd = input.tags.filter((t) => !current.has(t));
        const toRemove = [...current].filter((t) => !desired.has(t));
        const delta = [
          ...toAdd.map((name) => ({ name, status: 'active' as const })),
          ...toRemove.map((name) => ({ name, status: 'inactive' as const })),
        ];
        if (delta.length > 0) {
          await svc.subscribers.updateTags(ctx, audienceId, hash, delta);
        }
        ctx.log.info('subscriber tags synced', {
          email: input.email,
          added: toAdd.length,
          removed: toRemove.length,
        });
        return {
          operation: 'set-tags',
          tagsAdded: toAdd,
          tagsRemoved: toRemove,
          tagsActive: input.tags.map((t) => ({ id: 0, name: t })),
        };
      }

      case 'list-notes': {
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'list-notes'));
        const { notes, total_items } = await svc.subscribers.listNotes(ctx, audienceId, hash, {
          count: input.count,
          offset: input.offset,
        });
        return {
          operation: 'list-notes',
          totalItems: total_items,
          notes: notes.map((n) => {
            const entry: NonNullable<Output['notes']>[number] = { id: n.id, note: n.note };
            if (n.created_at) entry.createdAt = n.created_at;
            if (n.updated_at) entry.updatedAt = n.updated_at;
            if (n.created_by) entry.createdBy = n.created_by;
            return entry;
          }),
        };
      }

      case 'add-note': {
        if (!input.note) throw validationError("'note' is required for 'add-note'.");
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'add-note'));
        const note = await svc.subscribers.addNote(ctx, audienceId, hash, input.note);
        const out: NonNullable<Output['note']> = { id: note.id, note: note.note };
        if (note.created_at) out.createdAt = note.created_at;
        return { operation: 'add-note', note: out };
      }

      case 'update-note': {
        if (!input.note) throw validationError("'note' is required for 'update-note'.");
        if (input.noteId === undefined)
          throw validationError("'noteId' is required for 'update-note'.");
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'update-note'));
        const note = await svc.subscribers.updateNote(
          ctx,
          audienceId,
          hash,
          input.noteId,
          input.note,
        );
        const out: NonNullable<Output['note']> = { id: note.id, note: note.note };
        if (note.created_at) out.createdAt = note.created_at;
        return { operation: 'update-note', note: out };
      }

      case 'delete-note': {
        if (input.noteId === undefined)
          throw validationError("'noteId' is required for 'delete-note'.");
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'delete-note'));
        await svc.subscribers.deleteNote(ctx, audienceId, hash, input.noteId);
        return { operation: 'delete-note', deleted: true };
      }

      case 'list-activity': {
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'list-activity'));
        const { activity, total_items } = await svc.subscribers.listActivity(
          ctx,
          audienceId,
          hash,
          { count: input.count, offset: input.offset },
        );
        return {
          operation: 'list-activity',
          totalItems: total_items,
          activity: activity.map((a) => a as unknown as Record<string, unknown>),
        };
      }

      case 'list-events': {
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'list-events'));
        const { events, total_items } = await svc.subscribers.listEvents(ctx, audienceId, hash, {
          count: input.count,
          offset: input.offset,
        });
        return {
          operation: 'list-events',
          totalItems: total_items,
          events: events.map((e) => e as unknown as Record<string, unknown>),
        };
      }

      case 'list-goals': {
        const hash = await mailchimpMemberHash(requireEmail(input.email, 'list-goals'));
        const { goals, total_items } = await svc.subscribers.listGoals(ctx, audienceId, hash);
        return {
          operation: 'list-goals',
          totalItems: total_items,
          goals: goals.map((g) => g as unknown as Record<string, unknown>),
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.operation === 'list' && result.subscribers) {
      lines.push(`# Subscribers (${result.subscribers.length} of ${result.totalItems ?? '?'})`, '');
      for (const s of result.subscribers) {
        lines.push(`- **${s.email}** — ${s.status}${s.fullName ? ` (${s.fullName})` : ''}`);
      }
    } else if (result.subscriber && ['get', 'update'].includes(result.operation)) {
      const s = result.subscriber;
      lines.push(`# ${s.email}`, '', `**Status:** ${s.status}  `);
      if (s.fullName) lines.push(`**Name:** ${s.fullName}  `);
      if (typeof s.memberRating === 'number') lines.push(`**Rating:** ${s.memberRating}/5  `);
      if (s.language) lines.push(`**Language:** ${s.language}  `);
      if (s.vip) lines.push(`**VIP:** yes  `);
      if (s.timestampSignup) lines.push(`**Signed up:** ${s.timestampSignup}  `);
      if (s.timestampOpt) lines.push(`**Opted in:** ${s.timestampOpt}  `);
      if (s.lastChanged) lines.push(`**Last changed:** ${s.lastChanged}  `);
      if (s.mergeFields && Object.keys(s.mergeFields).length > 0) {
        lines.push('', '**Merge fields**');
        for (const [k, v] of Object.entries(s.mergeFields)) {
          if (v === '' || v === null || v === undefined) continue;
          lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
        }
      }
      if (s.tags && s.tags.length > 0) {
        lines.push('', `**Tags:** ${s.tags.map((t) => t.name).join(', ')}`);
      }
      if (s.stats) {
        lines.push('', '**Engagement**');
        if (typeof s.stats.avgOpenRate === 'number')
          lines.push(`- Avg open rate: ${(s.stats.avgOpenRate * 100).toFixed(2)}%`);
        if (typeof s.stats.avgClickRate === 'number')
          lines.push(`- Avg click rate: ${(s.stats.avgClickRate * 100).toFixed(2)}%`);
      }
    } else if (result.operation === 'archive') {
      lines.push('Subscriber archived. The record is preserved; they can resubscribe later.');
    } else if (result.operation === 'list-tags' && result.tagsActive) {
      lines.push(`# Tags (${result.tagsActive.length})`, '');
      for (const t of result.tagsActive)
        lines.push(`- ${t.name}${t.dateAdded ? ` (since ${t.dateAdded})` : ''}`);
    } else if (result.operation === 'set-tags') {
      lines.push('Tags synced.');
      if (result.tagsAdded?.length) lines.push(`**Added:** ${result.tagsAdded.join(', ')}`);
      if (result.tagsRemoved?.length) lines.push(`**Removed:** ${result.tagsRemoved.join(', ')}`);
      if (!result.tagsAdded?.length && !result.tagsRemoved?.length)
        lines.push('_No changes — the provided tag set was already active._');
    } else if (result.operation === 'list-notes' && result.notes) {
      lines.push(`# Notes (${result.notes.length})`, '');
      for (const n of result.notes) {
        lines.push(`**#${n.id}** ${n.createdAt ?? ''}${n.createdBy ? ` — ${n.createdBy}` : ''}`);
        lines.push(`> ${n.note}`, '');
      }
    } else if (['add-note', 'update-note'].includes(result.operation) && result.note) {
      lines.push(`Note #${result.note.id} saved.`, '', `> ${result.note.note}`);
    } else if (result.operation === 'delete-note') {
      lines.push('Note deleted.');
    } else if (result.operation === 'list-activity' && result.activity) {
      lines.push(`# Activity (${result.activity.length} events)`, '');
      for (const a of result.activity) lines.push(`- ${JSON.stringify(a)}`);
    } else if (result.operation === 'list-events' && result.events) {
      lines.push(`# Events (${result.events.length})`, '');
      for (const e of result.events) lines.push(`- ${JSON.stringify(e)}`);
    } else if (result.operation === 'list-goals' && result.goals) {
      lines.push(`# Goals (${result.goals.length})`, '');
      for (const g of result.goals) lines.push(`- ${JSON.stringify(g)}`);
    } else {
      lines.push(`Operation \`${result.operation}\` completed.`);
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
