/**
 * @fileoverview `mailchimp_import_subscribers` — batch add/update via
 * POST /lists/{id}. Status defaults to `pending` (double-opt-in) to prevent
 * accidental mass-sends. Effective subscribed rows require one bound
 * confirmation before the entire batch writes.
 * @module mcp-server/tools/definitions/mailchimp-import-subscribers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import { hasSubscriberAddress } from '../shared/subscriber-address.js';
import { confirmSubscription, isSubscriptionReentry } from '../shared/subscription-confirmation.js';

const MAX_ROWS = 500;

const StatusSchema = z
  .enum(['subscribed', 'pending', 'unsubscribed', 'cleaned', 'transactional'])
  .describe(
    "Default row status, overridden by each row's status when supplied. `pending` uses Mailchimp's double-opt-in flow. Any valid effective `subscribed` row requires one confirmation of documented consent before the batch writes.",
  );

const SubscriberRowSchema = z
  .object({
    email: z.string().describe('Email address.'),
    status: StatusSchema.optional().describe(
      'Per-row override. Falls back to the top-level `status`.',
    ),
    mergeFields: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Merge-field values (e.g. `{ FNAME: "Ada" }`).'),
    tags: z.array(z.string()).optional().describe('Tags to apply when `syncTags: true` (default).'),
    language: z.string().optional().describe('ISO 639-1 language code for this subscriber.'),
    vip: z.boolean().optional().describe('Mark this subscriber as VIP.'),
  })
  .describe('One subscriber row to upsert.');

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
  audienceId: z.string().describe('Audience ID echoed back.'),
  totalCreated: z.number().describe('Rows added as new subscribers.'),
  totalUpdated: z.number().describe('Existing rows updated (0 unless `updateExisting: true`).'),
  errorCount: z.number().describe('Rows that failed (see `failed` for per-row reasons).'),
  statusApplied: z.string().describe('Top-level status applied to rows that did not override.'),
  succeeded: z
    .array(
      z
        .object({
          email: z.string().describe('Email address.'),
          subscriberId: z.string().describe('Mailchimp subscriber ID (member hash).'),
          status: z.string().describe('Resulting status after import.'),
          isNew: z.boolean().describe('True for newly-created rows; false when updating existing.'),
        })
        .describe('One successful upsert result.'),
    )
    .describe('Per-row result for successful upserts.'),
  failed: z
    .array(
      z
        .object({
          email: z.string().describe('Email that failed.'),
          error: z.string().describe('Human-readable local validation or Mailchimp error message.'),
          errorCode: z
            .string()
            .optional()
            .describe('Machine-readable local or Mailchimp error code.'),
        })
        .describe('One per-row failure.'),
    )
    .describe('Per-row failures with local validation or Mailchimp error code and message.'),
});

type Output = z.infer<typeof OutputSchema>;

export const mailchimpImportSubscribersTool = tool('mailchimp_import_subscribers', {
  description: `Batch add (and optionally update) subscribers in one call. Capped at ${MAX_ROWS} rows per request — chunk larger imports client-side. **Status defaults to \`pending\`** (Mailchimp's double-opt-in flow). Any valid row whose effective status is \`subscribed\`, including a per-row override, requires one confirmation of documented consent before any batch write; decline/cancel writes nothing. Incomplete addresses return in failed[] while valid rows proceed. Returns per-row succeeded/failed with error reasons.`,
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,
  errors: [
    {
      reason: 'subscription_cancelled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'The user declined or cancelled subscription confirmation.',
      recovery:
        'Invoke the request again and confirm documented consent to enable marketing delivery.',
    },
    {
      reason: 'mailchimp_unauthorized',
      thrownBy: 'service',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'Mailchimp returned 401 — API key invalid, revoked, or missing.',
      recovery:
        'Verify MAILCHIMP_API_KEY in env; rotate via Mailchimp → Account → Extras → API keys.',
    },
    {
      reason: 'mailchimp_forbidden',
      thrownBy: 'service',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Mailchimp returned 403 — paid-tier feature or insufficient permissions.',
      recovery:
        'Inspect data.requiresPlan when present; otherwise the API key lacks scope for batch import.',
    },
    {
      reason: 'mailchimp_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — audience does not exist or has been deleted.',
      recovery: 'Run mailchimp_audiences operation:list to discover valid audienceId values.',
    },
    {
      reason: 'mailchimp_validation_failed',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp returned 400 or 422 — usually a malformed row payload (missing email, unknown merge field, invalid status).',
      recovery:
        'Inspect data.upstream.errors[] and per-row data.failed[] for field-level reasons; fix the offending rows and retry.',
    },
    {
      reason: 'mailchimp_rate_limited',
      thrownBy: 'service',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Mailchimp returned 429 — too many concurrent requests.',
      recovery:
        'Retry after a brief delay; reduce MAILCHIMP_CONCURRENCY_LIMIT or batch size for bulk imports.',
      retryable: true,
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const invalid: Output['failed'] = input.subscribers
      .filter((row) => !hasSubscriberAddress(row.email))
      .map((row) => ({
        email: row.email,
        error: 'Email must contain @ with nonempty local and domain parts.',
        errorCode: 'invalid_email',
      }));
    const rows = input.subscribers
      .filter((row) => hasSubscriberAddress(row.email))
      .map((row) => ({
        email_address: row.email.trim(),
        status: row.status ?? input.status,
        ...(row.mergeFields ? { merge_fields: row.mergeFields } : {}),
        ...(row.tags ? { tags: row.tags } : {}),
        ...(row.language ? { language: row.language } : {}),
        ...(typeof row.vip === 'boolean' ? { vip: row.vip } : {}),
      }));

    const body = {
      members: rows,
      sync_tags: input.syncTags,
      update_existing: input.updateExisting,
      skip_merge_validation: input.skipMergeValidation,
      skip_duplicate_check: input.skipDuplicateCheck,
    };
    if (isSubscriptionReentry(ctx) || rows.some((row) => row.status === 'subscribed'))
      await confirmSubscription(ctx, 'subscriber-import', input.audienceId, { body, invalid });
    const resp =
      rows.length > 0
        ? await svc.subscribers.batch(ctx, input.audienceId, body)
        : {
            new_members: [],
            updated_members: [],
            errors: [],
            total_created: 0,
            total_updated: 0,
            error_count: 0,
          };

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

    const failed = [
      ...invalid,
      ...resp.errors.map((e) => {
        const entry: Output['failed'][number] = { email: e.email_address, error: e.error };
        if (e.error_code) entry.errorCode = e.error_code;
        return entry;
      }),
    ];

    return {
      audienceId: input.audienceId,
      totalCreated: resp.total_created,
      totalUpdated: resp.total_updated,
      errorCount: resp.error_count + invalid.length,
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
    if (result.succeeded.some((row) => row.status === 'pending')) {
      lines.push(
        '',
        '> Successful rows returned as `pending` require double-opt-in confirmation before becoming active. Failed rows and rows with other statuses are not pending subscriptions.',
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
        lines.push(
          `- \`${s.email}\` [${s.subscriberId}] — ${s.status}${s.isNew ? ' (new)' : ' (updated)'}`,
        );
      }
      if (result.succeeded.length > sample.length)
        lines.push(`- …and ${result.succeeded.length - sample.length} more.`);
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
