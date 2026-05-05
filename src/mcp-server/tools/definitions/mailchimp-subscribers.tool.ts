/**
 * @fileoverview `mailchimp_subscribers` tool — CRUD-except-permanent-delete for
 * list members, plus tags/notes/activity. `archive` is the strongest
 * removal (preserves the record so the email can re-subscribe). No
 * `delete-permanent` — GDPR-forget is irreversible. Upsert lives in the
 * `mailchimp_upsert_subscriber` workflow tool.
 * @module mcp-server/tools/definitions/mailchimp-subscribers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  getMailchimpService,
  mailchimpMemberHash,
} from '@/services/mailchimp/mailchimp-service.js';
import { normalizeMailchimp } from '@/services/mailchimp/normalize.js';
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
    'Which subscriber operation to run. `list`/`get` reads. `update` changes status/merge fields/language (NOT for create — use `mailchimp_upsert_subscriber`). `archive` removes the subscriber from the active audience while preserving the record so they can resubscribe. `list-tags` reads tags; `set-tags` declaratively syncs to a desired set — note that Mailchimp stores static-segment membership as a tag, so `set-tags` will remove segment membership unless you include those names or pass `preserveTags`. `list-notes`/`add-note`/`update-note`/`delete-note` manage CRM-style notes. `list-activity`/`list-events`/`list-goals` are engagement reads.',
  );

const InputSchema = z.object({
  operation: OperationSchema,
  audienceId: z.string().describe('Audience (list) ID.'),
  email: z
    .string()
    .optional()
    .describe(
      'Subscriber email address (case-insensitive). Required for every operation except `list`.',
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
      'Desired tag set for `set-tags`. This is *declarative* — the provided list becomes the full active tag set; tags not in the list are removed. **Warning:** Mailchimp stores static-segment membership as a tag with the same name, so removing a tag that matches a static-segment name also removes the subscriber from that segment. Include those names in `tags` or list them in `preserveTags` to keep them.',
    ),
  preserveTags: z
    .array(z.string())
    .optional()
    .describe(
      "Tag names that should NOT be removed by `set-tags` even if absent from `tags`. Use this to protect static-segment memberships (Mailchimp stores them as tags) or any other 'sticky' tag you don't want the declarative sync to strip.",
    ),
  note: z.string().optional().describe('Note body. Required for `add-note`/`update-note`.'),
  noteId: z.coerce
    .number()
    .int()
    .optional()
    .describe('Note ID. Required for `update-note`/`delete-note`.'),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(20)
    .describe('Page size for list-style reads.'),
  offset: z.coerce.number().int().min(0).default(0).describe('Offset for list-style reads.'),
});

const SubscriberSummarySchema = z
  .object({
    id: z.string().describe('Opaque Mailchimp subscriber ID — pass back to other tools verbatim.'),
    email: z.string().describe('Subscriber email address.'),
    status: z
      .string()
      .describe(
        'Current status: `subscribed`, `unsubscribed`, `cleaned`, `pending`, or `transactional`.',
      ),
    fullName: z.string().optional().describe('Full name from merge fields, if available.'),
    vip: z.boolean().optional().describe('Whether the subscriber is flagged as VIP.'),
    language: z.string().optional().describe('ISO 639-1 language code.'),
    memberRating: z.number().optional().describe('Mailchimp engagement rating 0–5.'),
    lastChanged: z.string().optional().describe('ISO 8601 timestamp of the last profile change.'),
    source: z.string().optional().describe('How the subscriber was added (e.g. `API`, `Import`).'),
    tagsCount: z.number().optional().describe('Number of tags currently on the subscriber.'),
    timestampSignup: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp when the subscriber signed up.'),
    timestampOpt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp when the subscriber opted in.'),
    mergeFields: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Merge-field values keyed by tag (e.g. `FNAME`, `LNAME`).'),
    tags: z
      .array(
        z
          .object({
            id: z.number().describe('Mailchimp tag ID.'),
            name: z.string().describe('Tag name.'),
          })
          .describe('One tag currently attached to the subscriber.'),
      )
      .optional()
      .describe('Tags currently on the subscriber.'),
    stats: z
      .object({
        avgOpenRate: z.number().optional().describe('Subscriber mean open rate (0–1).'),
        avgClickRate: z.number().optional().describe('Subscriber mean click rate (0–1).'),
      })
      .optional()
      .describe('Per-subscriber engagement averages.'),
  })
  .describe('Summary view of one subscriber.');

const OutputSchema = z.object({
  operation: OperationSchema,
  subscriber: SubscriberSummarySchema.optional().describe('Populated for `get`, `update`.'),
  subscribers: z.array(SubscriberSummarySchema).optional().describe('Populated for `list`.'),
  totalItems: z.number().optional().describe('Total items from Mailchimp (for list-style reads).'),
  tagsActive: z
    .array(
      z
        .object({
          /** Mailchimp tag ID. Omitted when the upstream response doesn't provide one (e.g. the `set-tags` sync endpoint returns names only). */
          id: z.number().optional().describe('Mailchimp tag ID (omitted on `set-tags` responses).'),
          name: z.string().describe('Tag name.'),
          dateAdded: z.string().optional().describe('ISO 8601 timestamp the tag was added.'),
        })
        .describe('One active tag on the subscriber.'),
    )
    .optional()
    .describe(
      'Currently active tags on this subscriber. The `id` field is present on `list-tags` reads; `set-tags` returns names only.',
    ),
  tagsAdded: z.array(z.string()).optional().describe('Tag names added by `set-tags`.'),
  tagsRemoved: z.array(z.string()).optional().describe('Tag names removed by `set-tags`.'),
  notes: z
    .array(
      z
        .object({
          id: z.number().describe('Note ID.'),
          note: z.string().describe('Note body.'),
          createdAt: z.string().optional().describe('ISO 8601 creation timestamp.'),
          updatedAt: z.string().optional().describe('ISO 8601 last-updated timestamp.'),
          createdBy: z.string().optional().describe('User who created the note.'),
        })
        .describe('One CRM-style note attached to the subscriber.'),
    )
    .optional()
    .describe('Populated for `list-notes`.'),
  note: z
    .object({
      id: z.number().describe('Note ID.'),
      note: z.string().describe('Note body.'),
      createdAt: z.string().optional().describe('ISO 8601 creation timestamp.'),
    })
    .optional()
    .describe('Populated for `add-note`, `update-note`.'),
  activity: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Subscriber activity events (opens, clicks, bounces). Populated for `list-activity`. Each row: `{ action, timestamp, type, campaign_id?, title?, parent_campaign? }`.',
    ),
  events: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Custom events attached to the subscriber. Populated for `list-events`. Each row: `{ name, properties, occurred_at, is_syncing }`.',
    ),
  goals: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Goal completions attributed to the subscriber. Populated for `list-goals`. Each row: `{ goal_id, event, last_visited_at, data }`.',
    ),
  archived: z
    .boolean()
    .optional()
    .describe(
      'Populated for `archive`. True when the subscriber was successfully moved to the archived pool. Archive preserves the record so the email can resubscribe.',
    ),
  deleted: z.boolean().optional().describe('Populated for `delete-note`.'),
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
        'Inspect data.requiresPlan when present; otherwise the API key lacks scope for subscriber writes.',
    },
    {
      reason: 'mailchimp_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — audience, subscriber, or note does not exist (subscriber must exist on the audience for non-list reads).',
      recovery:
        'Run mailchimp_audiences operation:list to confirm audienceId; mailchimp_find_subscriber with email to confirm membership and discover noteId via list-notes.',
    },
    {
      reason: 'mailchimp_validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp returned 400 or 422 — usually an unknown merge field, invalid status transition, or malformed tag payload.',
      recovery:
        'Inspect data.upstream.errors[] for field-level reasons; verify merge fields exist via mailchimp_merge_fields list.',
    },
    {
      reason: 'mailchimp_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Mailchimp returned 429 — too many concurrent requests.',
      recovery:
        'Retry after a brief delay; reduce MAILCHIMP_CONCURRENCY_LIMIT for bulk operations or use mailchimp_import_subscribers for batches.',
      retryable: true,
    },
  ] as const,

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
        const hash = mailchimpMemberHash(requireEmail(input.email, 'get'));
        const sub = await svc.subscribers.get(ctx, audienceId, hash);
        return { operation: 'get', subscriber: summarize(sub) };
      }

      case 'update': {
        const hash = mailchimpMemberHash(requireEmail(input.email, 'update'));
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
        // Mailchimp revalidates existing merge fields on every PATCH. Skip
        // that validation only when the caller isn't touching merge fields.
        const sub = await svc.subscribers.update(ctx, audienceId, hash, body, {
          skipMergeValidation: !input.mergeFields,
        });
        return { operation: 'update', subscriber: summarize(sub) };
      }

      case 'archive': {
        const hash = mailchimpMemberHash(requireEmail(input.email, 'archive'));
        await svc.subscribers.archive(ctx, audienceId, hash);
        ctx.log.info('subscriber archived', { email: input.email });
        return { operation: 'archive', archived: true };
      }

      case 'list-tags': {
        const hash = mailchimpMemberHash(requireEmail(input.email, 'list-tags'));
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
        const hash = mailchimpMemberHash(requireEmail(input.email, 'set-tags'));
        const { tags: currentTags } = await svc.subscribers.listTags(ctx, audienceId, hash, {
          count: 1000,
        });
        const current = new Set(currentTags.map((t) => t.name));
        const desired = new Set(input.tags);
        const preserve = new Set(input.preserveTags ?? []);
        const toAdd = input.tags.filter((t) => !current.has(t));
        const toRemove = [...current].filter((t) => !desired.has(t) && !preserve.has(t));
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
          preserved: [...current].filter((t) => preserve.has(t)).length,
        });
        const finalSet = new Set<string>(input.tags);
        for (const t of current) if (preserve.has(t)) finalSet.add(t);
        return {
          operation: 'set-tags',
          tagsAdded: toAdd,
          tagsRemoved: toRemove,
          // `id` intentionally omitted — Mailchimp's bulk sync endpoint returns names only.
          tagsActive: [...finalSet].map((t) => ({ name: t })),
        };
      }

      case 'list-notes': {
        const hash = mailchimpMemberHash(requireEmail(input.email, 'list-notes'));
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
        const hash = mailchimpMemberHash(requireEmail(input.email, 'add-note'));
        const note = await svc.subscribers.addNote(ctx, audienceId, hash, input.note);
        const out: NonNullable<Output['note']> = { id: note.id, note: note.note };
        if (note.created_at) out.createdAt = note.created_at;
        return { operation: 'add-note', note: out };
      }

      case 'update-note': {
        if (!input.note) throw validationError("'note' is required for 'update-note'.");
        if (input.noteId === undefined)
          throw validationError("'noteId' is required for 'update-note'.");
        const hash = mailchimpMemberHash(requireEmail(input.email, 'update-note'));
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
        const hash = mailchimpMemberHash(requireEmail(input.email, 'delete-note'));
        await svc.subscribers.deleteNote(ctx, audienceId, hash, input.noteId);
        return { operation: 'delete-note', deleted: true };
      }

      case 'list-activity': {
        const hash = mailchimpMemberHash(requireEmail(input.email, 'list-activity'));
        const { activity, total_items } = await svc.subscribers.listActivity(
          ctx,
          audienceId,
          hash,
          { count: input.count, offset: input.offset },
        );
        return {
          operation: 'list-activity',
          totalItems: total_items,
          activity: normalizeMailchimp<Array<Record<string, unknown>>>(activity ?? []),
        };
      }

      case 'list-events': {
        const hash = mailchimpMemberHash(requireEmail(input.email, 'list-events'));
        const { events, total_items } = await svc.subscribers.listEvents(ctx, audienceId, hash, {
          count: input.count,
          offset: input.offset,
        });
        return {
          operation: 'list-events',
          totalItems: total_items,
          events: normalizeMailchimp<Array<Record<string, unknown>>>(events ?? []),
        };
      }

      case 'list-goals': {
        const hash = mailchimpMemberHash(requireEmail(input.email, 'list-goals'));
        const { goals, total_items } = await svc.subscribers.listGoals(ctx, audienceId, hash);
        return {
          operation: 'list-goals',
          totalItems: total_items,
          goals: normalizeMailchimp<Array<Record<string, unknown>>>(goals ?? []),
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`_Operation: ${result.operation}_`, ''];

    const renderSummary = (s: z.infer<typeof SubscriberSummarySchema>, bullet: boolean): void => {
      const prefix = bullet ? '- ' : '';
      const indent = bullet ? '  ' : '';
      lines.push(
        `${prefix}**${s.email}** [${s.id}] — ${s.status}${s.fullName ? ` (${s.fullName})` : ''}`,
      );
      const meta: string[] = [];
      if (typeof s.memberRating === 'number') meta.push(`rating ${s.memberRating}/5`);
      if (s.language) meta.push(`lang ${s.language}`);
      if (typeof s.vip === 'boolean') meta.push(`vip ${s.vip}`);
      if (s.source) meta.push(`source ${s.source}`);
      if (typeof s.tagsCount === 'number') meta.push(`tagsCount ${s.tagsCount}`);
      if (meta.length > 0) lines.push(`${indent}${meta.join(' · ')}`);
      const stamps: string[] = [];
      if (s.timestampSignup) stamps.push(`signed up ${s.timestampSignup}`);
      if (s.timestampOpt) stamps.push(`opted in ${s.timestampOpt}`);
      if (s.lastChanged) stamps.push(`last changed ${s.lastChanged}`);
      if (stamps.length > 0) lines.push(`${indent}${stamps.join(' · ')}`);
      if (s.stats) {
        const st: string[] = [];
        if (typeof s.stats.avgOpenRate === 'number')
          st.push(`avgOpenRate ${(s.stats.avgOpenRate * 100).toFixed(2)}%`);
        if (typeof s.stats.avgClickRate === 'number')
          st.push(`avgClickRate ${(s.stats.avgClickRate * 100).toFixed(2)}%`);
        if (st.length > 0) lines.push(`${indent}Stats: ${st.join(', ')}`);
      }
      if (s.tags && s.tags.length > 0) {
        lines.push(`${indent}Tags: ${s.tags.map((t) => `${t.name} [id:${t.id}]`).join(', ')}`);
      }
      if (s.mergeFields) {
        const entries = Object.entries(s.mergeFields)
          .filter(([, v]) => v !== '' && v !== null && v !== undefined)
          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
        lines.push(
          `${indent}Merge fields: ${entries.length > 0 ? entries.join(', ') : '(none populated)'}`,
        );
      }
    };

    if (result.subscribers) {
      lines.push(`# Subscribers (${result.subscribers.length} of ${result.totalItems ?? '?'})`, '');
      for (const s of result.subscribers) renderSummary(s, true);
    }

    if (result.subscriber) {
      if (result.subscribers) lines.push('');
      lines.push(`# ${result.subscriber.email}`, '');
      renderSummary(result.subscriber, false);
    }

    if (result.tagsActive) {
      lines.push('', `# Tags active (${result.tagsActive.length})`, '');
      for (const t of result.tagsActive) {
        const idPart = typeof t.id === 'number' ? ` [id:${t.id}]` : '';
        lines.push(`- ${t.name}${idPart}${t.dateAdded ? ` (since ${t.dateAdded})` : ''}`);
      }
    }

    if (result.tagsAdded !== undefined || result.tagsRemoved !== undefined) {
      lines.push('', 'Tags sync:');
      if (result.tagsAdded) {
        lines.push(
          `**tagsAdded:** ${result.tagsAdded.length > 0 ? result.tagsAdded.join(', ') : '(none)'}`,
        );
      }
      if (result.tagsRemoved) {
        lines.push(
          `**tagsRemoved:** ${result.tagsRemoved.length > 0 ? result.tagsRemoved.join(', ') : '(none)'}`,
        );
      }
    }

    if (result.notes) {
      lines.push('', `# Notes (${result.notes.length})`, '');
      for (const n of result.notes) {
        const meta: string[] = [];
        if (n.createdAt) meta.push(`createdAt ${n.createdAt}`);
        if (n.updatedAt) meta.push(`updatedAt ${n.updatedAt}`);
        if (n.createdBy) meta.push(`createdBy ${n.createdBy}`);
        lines.push(`**#${n.id}** ${meta.join(' · ')}`);
        lines.push(`> ${n.note}`, '');
      }
    }

    if (result.note) {
      lines.push('', `Note #${result.note.id} saved.`);
      if (result.note.createdAt) lines.push(`_createdAt: ${result.note.createdAt}_`);
      lines.push('', `> ${result.note.note}`);
    }

    if (result.activity) {
      lines.push('', `# Activity (${result.activity.length} events)`, '');
      for (const a of result.activity) lines.push(`- ${JSON.stringify(a)}`);
    }

    if (result.events) {
      lines.push('', `# Events (${result.events.length})`, '');
      for (const e of result.events) lines.push(`- ${JSON.stringify(e)}`);
    }

    if (result.goals) {
      lines.push('', `# Goals (${result.goals.length})`, '');
      for (const g of result.goals) lines.push(`- ${JSON.stringify(g)}`);
    }

    if (typeof result.archived === 'boolean') lines.push('', `_Archived: ${result.archived}_`);
    if (typeof result.deleted === 'boolean') lines.push(`_Deleted: ${result.deleted}_`);

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
