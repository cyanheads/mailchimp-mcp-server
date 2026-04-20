/**
 * @fileoverview `mailchimp_import_subscribers` — batch add/update via
 * POST /lists/{id}. Status defaults to `pending` (double-opt-in) to prevent
 * accidental mass-sends. Caller must explicitly pass `status: 'subscribed'`
 * for the "I already have consent" path.
 * @module mcp-server/tools/definitions/mailchimp-import-subscribers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

const MAX_ROWS = 500;

const StatusSchema = z
  .enum(['subscribed', 'pending', 'unsubscribed', 'cleaned', 'transactional'])
  .describe(
    "Status applied to every row. Defaults to `pending` — Mailchimp will email each recipient for double-opt-in confirmation. Pass `'subscribed'` ONLY when you have a clean record of consent.",
  );

const SubscriberRowSchema = z.object({
  email: z.string().describe('Email address.'),
  status: StatusSchema.optional().describe(
    'Per-row override. Falls back to the top-level `status`.',
  ),
  mergeFields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Merge-field values (e.g. `{ FNAME: "Ada" }`).'),
  tags: z.array(z.string()).optional().describe('Tags to apply when `syncTags: true` (default).'),
  language: z.string().optional(),
  vip: z.boolean().optional(),
});

const InputSchema = z.object({
  audienceId: z.string().describe('Audience (list) ID.'),
  subscribers: z
    .array(SubscriberRowSchema)
    .min(1)
    .max(MAX_ROWS)
    .describe(
      `Rows to import. Capped at ${MAX_ROWS} per call (Mailchimp hard limit). Chunk larger imports client-side.`,
    ),
  status: StatusSchema.default('pending'),
  updateExisting: z
    .boolean()
    .default(false)
    .describe(
      'Update existing subscribers in place. When false (default), existing records are skipped.',
    ),
  skipMergeValidation: z
    .boolean()
    .default(false)
    .describe(
      'Bypass merge-field validation (use when migrating dirty data you intend to clean up later).',
    ),
  skipDuplicateCheck: z
    .boolean()
    .default(false)
    .describe('Disable duplicate detection. Only set when you trust the input.'),
  syncTags: z
    .boolean()
    .default(true)
    .describe('Synchronize per-row `tags` to the resulting members.'),
});

const OutputSchema = z.object({
  audienceId: z.string(),
  totalCreated: z.number().describe('Rows added as new subscribers.'),
  totalUpdated: z.number().describe('Existing rows updated (0 unless `updateExisting: true`).'),
  errorCount: z.number(),
  statusApplied: z.string().describe('Top-level status applied to rows that did not override.'),
  succeeded: z
    .array(
      z.object({
        email: z.string(),
        subscriberId: z.string(),
        status: z.string(),
        isNew: z.boolean(),
      }),
    )
    .describe('Per-row result for successful upserts.'),
  failed: z
    .array(
      z.object({
        email: z.string(),
        error: z.string(),
        errorCode: z.string().optional(),
      }),
    )
    .describe('Per-row failures with Mailchimp error code + message.'),
});

type Output = z.infer<typeof OutputSchema>;

export const mailchimpImportSubscribersTool = tool('mailchimp_import_subscribers', {
  description: `Batch add (and optionally update) subscribers in one call. Capped at ${MAX_ROWS} rows per request — chunk larger imports client-side. **Status defaults to \`pending\`** (Mailchimp's double-opt-in flow) to prevent accidental mass-sends; set \`status: 'subscribed'\` explicitly only when you have documented consent. Returns per-row succeeded/failed with error reasons.`,
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const rows = input.subscribers.map((row) => ({
      email_address: row.email,
      status: row.status ?? input.status,
      ...(row.mergeFields ? { merge_fields: row.mergeFields } : {}),
      ...(row.tags ? { tags: row.tags } : {}),
      ...(row.language ? { language: row.language } : {}),
      ...(typeof row.vip === 'boolean' ? { vip: row.vip } : {}),
    }));

    const resp = await svc.subscribers.batch(ctx, input.audienceId, {
      members: rows,
      sync_tags: input.syncTags,
      update_existing: input.updateExisting,
      skip_merge_validation: input.skipMergeValidation,
      skip_duplicate_check: input.skipDuplicateCheck,
    });

    ctx.log.info('import_subscribers complete', {
      audienceId: input.audienceId,
      totalCreated: resp.total_created,
      totalUpdated: resp.total_updated,
      errorCount: resp.error_count,
    });

    const succeeded = [
      ...resp.new_members.map((m) => ({
        email: m.email_address,
        subscriberId: m.id,
        status: m.status,
        isNew: true,
      })),
      ...resp.updated_members.map((m) => ({
        email: m.email_address,
        subscriberId: m.id,
        status: m.status,
        isNew: false,
      })),
    ];

    const failed = resp.errors.map((e) => {
      const entry: Output['failed'][number] = { email: e.email_address, error: e.error };
      if (e.error_code) entry.errorCode = e.error_code;
      return entry;
    });

    return {
      audienceId: input.audienceId,
      totalCreated: resp.total_created,
      totalUpdated: resp.total_updated,
      errorCount: resp.error_count,
      statusApplied: input.status,
      succeeded,
      failed,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `# Import: ${result.succeeded.length}/${result.succeeded.length + result.failed.length} succeeded`,
      '',
      `**Audience:** \`${result.audienceId}\`  `,
      `**Status applied:** ${result.statusApplied}  `,
      `**Created:** ${result.totalCreated}  `,
      `**Updated:** ${result.totalUpdated}  `,
      `**Failed:** ${result.errorCount}  `,
    ];
    if (result.statusApplied === 'pending') {
      lines.push(
        '',
        "> Status is `pending` — every row will receive Mailchimp's double-opt-in email. None will be active until they confirm.",
      );
    }
    if (result.failed.length > 0) {
      lines.push('', `## Failures (${result.failed.length})`, '');
      const sample = result.failed.slice(0, 25);
      for (const f of sample) {
        lines.push(`- \`${f.email}\`${f.errorCode ? ` [${f.errorCode}]` : ''}: ${f.error}`);
      }
      if (result.failed.length > sample.length)
        lines.push(`- …and ${result.failed.length - sample.length} more.`);
    }
    if (result.succeeded.length > 0) {
      lines.push('', `## Succeeded (${result.succeeded.length})`, '');
      const sample = result.succeeded.slice(0, 25);
      for (const s of sample) {
        lines.push(`- \`${s.email}\` — ${s.status}${s.isNew ? ' (new)' : ' (updated)'}`);
      }
      if (result.succeeded.length > sample.length)
        lines.push(`- …and ${result.succeeded.length - sample.length} more.`);
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
