/**
 * @fileoverview `mailchimp_upsert_subscriber` — idempotent single-subscriber
 * add-or-update, syncs tags (declaratively) and optionally attaches a note.
 * Uses PUT /lists/{id}/members/{hash} to avoid the "already exists" race.
 * @module mcp-server/tools/definitions/mailchimp-upsert-subscriber.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  getMailchimpService,
  mailchimpMemberHash,
} from '@/services/mailchimp/mailchimp-service.js';

const StatusSchema = z
  .enum(['subscribed', 'unsubscribed', 'cleaned', 'pending', 'transactional'])
  .describe(
    "Subscriber status. `subscribed` = active opt-in. `pending` = triggers Mailchimp's double-opt-in flow (the user must click the confirmation email before they go active). `unsubscribed`/`cleaned`/`transactional` are applied as-is.",
  );

const InputSchema = z.object({
  audienceId: z.string().describe('Audience (list) ID.'),
  email: z
    .string()
    .describe('Subscriber email address (case-insensitive; normalized before hashing).'),
  status: StatusSchema,
  mergeFields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Merge-field values (e.g. `{ FNAME: "Ada", LNAME: "Lovelace" }`).'),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Desired tag set. Declarative — the provided list becomes the full active tag set. Omit to leave tags untouched; pass `[]` to remove all.',
    ),
  note: z.string().optional().describe('Optional note to attach to the subscriber record.'),
  vip: z.boolean().optional().describe('Mark this subscriber as VIP in the Mailchimp UI.'),
  language: z.string().optional().describe('ISO 639-1 language code.'),
  updateExistingStatus: z
    .boolean()
    .default(true)
    .describe(
      'If true, apply `status` to existing subscribers as well. If false, `status` is only used for NEW subscribers (via `status_if_new`) and existing ones keep their current status.',
    ),
});

const OutputSchema = z.object({
  subscriberId: z.string().describe('Mailchimp subscriber ID (the member hash).'),
  email: z.string().describe('Subscriber email echoed back.'),
  status: z.string().describe('Resulting subscriber status after the upsert.'),
  isNew: z.boolean().describe('True if the subscriber record was just created.'),
  tagsAdded: z.array(z.string()).describe('Tag names added during sync.'),
  tagsRemoved: z.array(z.string()).describe('Tag names removed during sync.'),
  tagsFinal: z.array(z.string()).describe('Final active tag set after the sync.'),
  noteAttached: z.boolean().describe('True when a note was successfully attached.'),
  mergeFieldsApplied: z.number().describe('Count of merge-field values applied.'),
  webUrl: z.string().optional().describe('Deep link to the subscriber record in the Mailchimp UI.'),
});

type Output = z.infer<typeof OutputSchema>;

export const mailchimpUpsertSubscriberTool = tool('mailchimp_upsert_subscriber', {
  description:
    "Add or update a subscriber in one idempotent call. Uses PUT /members/{hash} so it safely handles both new and existing records. Tags are synced declaratively — pass the desired active set and the tool computes the add/remove delta. Use `status: 'pending'` to trigger Mailchimp's double-opt-in email; `'subscribed'` for immediate opt-in (make sure you have consent).",
  annotations: { idempotentHint: true, openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const hash = await mailchimpMemberHash(input.email);

    const upsertBody: Parameters<typeof svc.subscribers.upsert>[3] = {
      email_address: input.email,
      status_if_new: input.status,
    };
    if (input.updateExistingStatus) upsertBody.status = input.status;
    if (input.mergeFields) upsertBody.merge_fields = input.mergeFields;
    if (typeof input.vip === 'boolean') upsertBody.vip = input.vip;
    if (input.language) upsertBody.language = input.language;

    const before = await svc.subscribers.get(ctx, input.audienceId, hash).catch(() => null);
    const subscriber = await svc.subscribers.upsert(ctx, input.audienceId, hash, upsertBody);
    const isNew = before === null;

    let tagsAdded: string[] = [];
    let tagsRemoved: string[] = [];
    let tagsFinal: string[] = [];
    if (input.tags !== undefined) {
      const currentTagsResp = isNew
        ? { tags: [], total_items: 0 }
        : await svc.subscribers.listTags(ctx, input.audienceId, hash, { count: 1000 });
      const current = new Set(currentTagsResp.tags.map((t) => t.name));
      const desired = new Set(input.tags);
      tagsAdded = input.tags.filter((t) => !current.has(t));
      tagsRemoved = [...current].filter((t) => !desired.has(t));
      const delta = [
        ...tagsAdded.map((name) => ({ name, status: 'active' as const })),
        ...tagsRemoved.map((name) => ({ name, status: 'inactive' as const })),
      ];
      if (delta.length > 0) {
        await svc.subscribers.updateTags(ctx, input.audienceId, hash, delta);
      }
      tagsFinal = [...input.tags];
    } else if (subscriber.tags) {
      tagsFinal = subscriber.tags.map((t) => t.name);
    }

    let noteAttached = false;
    if (input.note) {
      await svc.subscribers.addNote(ctx, input.audienceId, hash, input.note);
      noteAttached = true;
    }

    const mergeFieldsApplied = input.mergeFields ? Object.keys(input.mergeFields).length : 0;

    ctx.log.info('subscriber upserted', {
      email: input.email,
      isNew,
      status: subscriber.status,
      tagsAdded: tagsAdded.length,
      tagsRemoved: tagsRemoved.length,
    });

    const result: Output = {
      subscriberId: subscriber.id,
      email: subscriber.email_address,
      status: subscriber.status,
      isNew,
      tagsAdded,
      tagsRemoved,
      tagsFinal,
      noteAttached,
      mergeFieldsApplied,
    };
    if (typeof subscriber.web_id === 'number') {
      result.webUrl = `https://${svc.dataCenter}.admin.mailchimp.com/lists/members/view?id=${subscriber.web_id}`;
    }
    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `# Subscriber ${result.isNew ? 'created' : 'updated'}: ${result.email}`,
      '',
      `**Status:** ${result.status}  `,
      `**ID:** ${result.subscriberId}  `,
    ];
    if (result.mergeFieldsApplied > 0)
      lines.push(`**Merge fields applied:** ${result.mergeFieldsApplied}  `);
    if (result.tagsAdded.length > 0) lines.push(`**Tags added:** ${result.tagsAdded.join(', ')}  `);
    if (result.tagsRemoved.length > 0)
      lines.push(`**Tags removed:** ${result.tagsRemoved.join(', ')}  `);
    if (result.tagsFinal.length > 0) lines.push(`**Final tags:** ${result.tagsFinal.join(', ')}  `);
    if (result.noteAttached) lines.push('**Note attached:** yes  ');
    if (result.webUrl) lines.push('', `[Open in Mailchimp](${result.webUrl})`);
    if (result.status === 'pending')
      lines.push(
        '',
        '> Subscriber is `pending` — Mailchimp has sent a double-opt-in confirmation email. They will not go active until they click the link.',
      );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
