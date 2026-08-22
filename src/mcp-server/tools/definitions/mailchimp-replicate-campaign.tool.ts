/**
 * @fileoverview `mailchimp_replicate_campaign` — duplicate an existing campaign,
 * optionally override subject/content/recipients, then leave as draft, send a
 * test, send, or schedule. Uses the same re-entrant confirmation and cleanup
 * semantics as `send_campaign`.
 * @module mcp-server/tools/definitions/mailchimp-replicate-campaign.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { rewriteAssetsInContent } from '@/mcp-server/tools/shared/asset-rewrite.js';
import { confirmCampaignDispatch } from '@/mcp-server/tools/shared/campaign-dispatch-confirmation.js';
import { resolveLocalTemplate } from '@/mcp-server/tools/shared/resolve-local-template.js';
import { TEMPLATE_SECTIONS_DOC } from '@/mcp-server/tools/shared/template-sections-doc.js';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

const ModeSchema = z
  .enum(['draft', 'test', 'send', 'schedule'])
  .describe(
    'What to do after replicating. `draft` (default — safe) leaves the replica unsent. `test` sends a preview to `testEmails`. `send` dispatches immediately. `schedule` queues for `scheduleTime`. **Default to `draft` unless the user has explicitly authorized sending** — phrasing like "clone this campaign and update the audience" or "set up a v2" means `draft`, not `send`. `send` and `schedule` also require `confirmSend: true`.',
  );

const ContentOverrideSchema = z
  .object({
    html: z.string().optional().describe('Full HTML body replacement.'),
    plainText: z.string().optional().describe('Plaintext body replacement.'),
    templateId: z.coerce
      .number()
      .int()
      .optional()
      .describe('Saved-template ID to render the replica from instead of the original content.'),
    templateSections: z.record(z.string(), z.unknown()).optional().describe(TEMPLATE_SECTIONS_DOC),
    localTemplate: z
      .string()
      .optional()
      .describe(
        'Name of a local template to render (without the `.eta` extension). Requires `MAILCHIMP_TEMPLATES_DIR` on the server. Mutually exclusive with `html` and `templateId`.',
      ),
    localTemplateVars: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Variables passed to Eta when rendering `localTemplate`.'),
  })
  .describe("Content replacement. Omit to keep the source campaign's content.");

const InputSchema = z.object({
  sourceCampaignId: z.string().describe('Campaign ID to clone.'),
  subjectOverride: z
    .string()
    .optional()
    .describe('New subject line. Omit to keep the source subject.'),
  previewTextOverride: z
    .string()
    .optional()
    .describe(
      'New preview text (shown after subject in most clients). Omit to keep the source preview text.',
    ),
  fromNameOverride: z
    .string()
    .optional()
    .describe('New From-name. Omit to keep the source From-name.'),
  replyToOverride: z
    .string()
    .optional()
    .describe('New Reply-to email. Omit to keep the source Reply-to.'),
  titleOverride: z
    .string()
    .optional()
    .describe(
      'New internal campaign title (not seen by recipients). Omit to keep the source title.',
    ),
  audienceOverride: z
    .string()
    .optional()
    .describe('New audience ID. Omit to keep the source audience.'),
  segmentOverride: z.coerce
    .number()
    .int()
    .optional()
    .describe('New saved-segment ID. Omit to keep the source segment.'),
  contentOverride: ContentOverrideSchema.optional(),
  mode: ModeSchema.default('draft').describe(
    'What to do after replicating: `draft` (default), `test`, `send`, or `schedule`. **Default to `draft` unless the user has explicitly authorized sending.** `send`/`schedule` require `confirmSend: true`.',
  ),
  confirmSend: z
    .boolean()
    .default(false)
    .describe(
      "Required `true` to dispatch when `mode: 'send' | 'schedule'`. Structural confirmation that the user has explicitly authorized the send. The handler rejects `mode: 'send'`/`'schedule'` calls with `confirmSend: false`. Leave `false` for `draft`/`test`. Before flipping to `true`, surface a one-line summary of the replica (subject after overrides, audience name, recipient count, send time if scheduled) and get explicit user authorization.",
    ),
  scheduleTime: z
    .string()
    .optional()
    .describe('Required for mode=schedule. ISO 8601 timestamp at least 15 minutes in the future.'),
  testEmails: z
    .array(z.string())
    .max(50)
    .optional()
    .describe('Test-email recipients for `mode: test`. Max 50.'),
  testSendType: z.enum(['html', 'plaintext']).default('html').describe('Format for the test send.'),
  cleanupOnError: z
    .boolean()
    .default(true)
    .describe('Delete the replicated draft if the workflow fails mid-flight.'),
});

const ChecklistItemSchema = z
  .object({
    type: z.enum(['success', 'warning', 'error']).describe('Severity of the checklist entry.'),
    heading: z.string().describe('Short title of the checklist item.'),
    details: z.string().describe('Full description of the checklist finding.'),
  })
  .describe('One entry from the Mailchimp campaign send-checklist.');

const OutputSchema = z.object({
  sourceCampaignId: z.string().describe('Source campaign ID that was replicated.'),
  campaignId: z.string().describe('ID of the newly created replica.'),
  webId: z.number().optional().describe('Mailchimp web-id for constructing UI deep links.'),
  mode: ModeSchema.describe(
    'What actually happened; downgraded to `draft` if the user declined the confirmation prompt.',
  ),
  status: z
    .string()
    .describe(
      'Post-action Mailchimp campaign status (`save`, `schedule`, `sending`, `sent`, etc.).',
    ),
  subject: z.string().describe('Resolved subject line after applying overrides.'),
  recipientCount: z
    .number()
    .optional()
    .describe('Number of recipients the campaign is addressed to.'),
  sendTime: z.string().optional().describe('Scheduled send time (ISO 8601) when mode=schedule.'),
  testsSentTo: z
    .array(z.string())
    .optional()
    .describe('Test recipients echo, only when mode=test.'),
  checklistWarnings: z
    .array(ChecklistItemSchema)
    .describe(
      'Non-blocking checklist items. Blocking items throw `pre_send_checklist_failed` before this output is produced.',
    ),
  archiveUrl: z.string().optional().describe('Public archive URL, populated once sending begins.'),
  webUrl: z.string().optional().describe('Deep link to the campaign in the Mailchimp UI.'),
  cancelledByUser: z
    .boolean()
    .optional()
    .describe('True when the user declined the confirmation prompt; mode was downgraded to draft.'),
  cleanedUp: z
    .boolean()
    .optional()
    .describe('True if the replica draft was deleted due to a mid-flow failure.'),
  overridesApplied: z
    .array(z.string())
    .describe('Labels of the overrides that were actually applied (for audit).'),
});

type Output = z.infer<typeof OutputSchema>;

export const mailchimpReplicateCampaignTool = tool('mailchimp_replicate_campaign', {
  description:
    "Duplicate an existing campaign, optionally override subject/from/reply/audience/segment/content, then leave as draft (default), send a test, send, or schedule. **Send-capable — default to `mode: 'draft'`.** Only use `mode: 'send'` or `'schedule'` when the user has explicitly authorized dispatch; phrasing like 'clone this campaign and update the audience' or 'set up a v2' is NOT authorization to send — leave as `draft`, return the new `campaignId` and `webUrl`, and let the user run a follow-up send after reviewing. Send/schedule modes require `confirmSend: true`. Use for the common 'send v2 of last week's newsletter with an updated intro' pattern.",
  annotations: { destructiveHint: true, openWorldHint: true },
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
        'Inspect data.requiresPlan when present; otherwise the API key lacks scope for campaign sends.',
    },
    {
      reason: 'mailchimp_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — sourceCampaignId or override ID does not exist.',
      recovery:
        'Run mailchimp_campaigns operation:list to discover valid campaignIds; verify audienceOverride via mailchimp_audiences.',
    },
    {
      reason: 'mailchimp_validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp returned 400 or 422 — replicated draft body or override payload failed upstream validation.',
      recovery:
        'Inspect data.upstream.errors[] for field-level reasons; check that scheduleTime is ≥15 minutes in the future and content is non-empty.',
    },
    {
      reason: 'mailchimp_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Mailchimp returned 429 — too many concurrent requests.',
      recovery:
        'Retry after a brief delay; reduce MAILCHIMP_CONCURRENCY_LIMIT for bulk operations.',
      retryable: true,
    },
    {
      reason: 'pre_send_checklist_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp send-checklist returned blocking errors on the replica.',
      recovery:
        'Inspect data.errors for each blocking finding, apply contentOverride or other overrides to fix, then re-invoke.',
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    if (input.mode === 'schedule' && !input.scheduleTime) {
      throw validationError("'scheduleTime' is required when mode=schedule.");
    }
    if (input.mode === 'test' && (!input.testEmails || input.testEmails.length === 0)) {
      throw validationError("'testEmails' (≥1) is required when mode=test.");
    }
    if ((input.mode === 'send' || input.mode === 'schedule') && !input.confirmSend) {
      throw validationError(
        `'confirmSend: true' is required for mode=${input.mode}. Get explicit user authorization for this dispatch (surface subject + audience + recipient count first), then re-invoke with confirmSend: true. To proceed without sending, use mode='draft'.`,
      );
    }

    let cancelledByUser = false;
    if (input.mode === 'send' || input.mode === 'schedule') {
      const confirmed = await confirmCampaignDispatch(ctx, async () => {
        const source = await svc.campaigns.get(ctx, input.sourceCampaignId);
        const subject = input.subjectOverride ?? source.settings?.subject_line ?? '(no subject)';
        const audienceId = input.audienceOverride ?? source.recipients?.list_id;
        let audienceLabel = source.recipients?.list_name ?? audienceId ?? '?';
        let count = source.recipients?.recipient_count;

        if (input.audienceOverride) {
          const audience = await svc.audiences
            .get(ctx, input.audienceOverride, { fields: ['name', 'stats.member_count'] })
            .catch(() => null);
          audienceLabel = audience?.name ?? input.audienceOverride;
          count = audience?.stats?.member_count;
        }

        return input.mode === 'send'
          ? `Send replica "${subject}" to ${count ?? '?'} subscribers in "${audienceLabel}" now?`
          : `Schedule replica "${subject}" to "${audienceLabel}" (${count ?? '?'} subscribers) for ${input.scheduleTime}?`;
      });
      cancelledByUser = !confirmed;
    }

    const overridesApplied: string[] = [];
    let newCampaignId: string | undefined;

    try {
      // 1. Replicate after the confirmation round completes.
      const replica = await svc.campaigns.replicate(ctx, input.sourceCampaignId);
      newCampaignId = replica.id;
      ctx.log.info('campaign replicated', {
        sourceId: input.sourceCampaignId,
        newId: newCampaignId,
      });

      // 2. Apply settings/recipients overrides.
      const settingsBody: Record<string, unknown> = {};
      if (input.subjectOverride !== undefined) {
        settingsBody.subject_line = input.subjectOverride;
        overridesApplied.push('subject');
      }
      if (input.previewTextOverride !== undefined) {
        settingsBody.preview_text = input.previewTextOverride;
        overridesApplied.push('previewText');
      }
      if (input.fromNameOverride !== undefined) {
        settingsBody.from_name = input.fromNameOverride;
        overridesApplied.push('fromName');
      }
      if (input.replyToOverride !== undefined) {
        settingsBody.reply_to = input.replyToOverride;
        overridesApplied.push('replyTo');
      }
      if (input.titleOverride !== undefined) {
        settingsBody.title = input.titleOverride;
        overridesApplied.push('title');
      }

      const recipientsBody: Record<string, unknown> | null =
        input.audienceOverride || typeof input.segmentOverride === 'number'
          ? {
              ...(input.audienceOverride
                ? { list_id: input.audienceOverride }
                : { list_id: replica.recipients?.list_id }),
              ...(typeof input.segmentOverride === 'number'
                ? { segment_opts: { saved_segment_id: input.segmentOverride } }
                : {}),
            }
          : null;
      if (recipientsBody && input.audienceOverride) overridesApplied.push('audience');
      if (recipientsBody && typeof input.segmentOverride === 'number')
        overridesApplied.push('segment');

      if (Object.keys(settingsBody).length > 0 || recipientsBody) {
        const body: Record<string, unknown> = {};
        if (Object.keys(settingsBody).length > 0) body.settings = settingsBody;
        if (recipientsBody) body.recipients = recipientsBody;
        await svc.campaigns.update(ctx, newCampaignId, body);
      }

      // 3. Content override.
      if (input.contentOverride) {
        const override = await resolveLocalTemplate(ctx, input.contentOverride);
        const contentBody: Parameters<typeof svc.campaigns.setContent>[2] = {};
        if (override.html) contentBody.html = override.html;
        if (override.plainText) contentBody.plain_text = override.plainText;
        if (typeof override.templateId === 'number') {
          contentBody.template = {
            id: override.templateId,
            ...(override.templateSections ? { sections: override.templateSections } : {}),
          };
        }
        if (Object.keys(contentBody).length === 0) {
          throw validationError(
            'contentOverride must include at least one of html/plainText/templateId/localTemplate.',
          );
        }
        const rewritten = await rewriteAssetsInContent(ctx, contentBody);
        await svc.campaigns.setContent(ctx, newCampaignId, rewritten);
        overridesApplied.push('content');
      }

      // 4. Checklist.
      const checklist = await svc.campaigns.getChecklist(ctx, newCampaignId);
      const warnings = checklist.items.filter((i) => i.type !== 'success');
      const errors = checklist.items.filter((i) => i.type === 'error');
      if (
        (input.mode === 'send' || input.mode === 'schedule' || input.mode === 'test') &&
        errors.length > 0
      ) {
        throw ctx.fail(
          'pre_send_checklist_failed',
          `Campaign failed send-checklist with ${errors.length} error(s): ${errors
            .map((e) => e.heading)
            .join('; ')}`,
          {
            errors: errors.map((e) => ({ heading: e.heading, details: e.details })),
            ...ctx.recoveryFor('pre_send_checklist_failed'),
          },
        );
      }

      // 5. Dispatch.
      const effectiveMode: z.infer<typeof ModeSchema> = cancelledByUser ? 'draft' : input.mode;
      let testsSentTo: string[] | undefined;
      if (effectiveMode === 'test') {
        await svc.campaigns.sendTest(ctx, newCampaignId, {
          test_emails: input.testEmails ?? [],
          send_type: input.testSendType,
        });
        testsSentTo = input.testEmails ?? [];
      } else if (effectiveMode === 'send') {
        await svc.campaigns.send(ctx, newCampaignId);
      } else if (effectiveMode === 'schedule') {
        await svc.campaigns.schedule(ctx, newCampaignId, {
          schedule_time: input.scheduleTime as string,
        });
      }

      const post = await svc.campaigns.get(ctx, newCampaignId);

      const result: Output = {
        sourceCampaignId: input.sourceCampaignId,
        campaignId: newCampaignId,
        mode: effectiveMode,
        status: post.status,
        subject: post.settings?.subject_line ?? '',
        checklistWarnings: warnings.map((w) => ({
          type: w.type,
          heading: w.heading,
          details: w.details,
        })),
        overridesApplied,
      };
      if (typeof post.web_id === 'number') {
        result.webId = post.web_id;
        result.webUrl = `https://${svc.dataCenter}.admin.mailchimp.com/campaigns/edit?id=${post.web_id}`;
      }
      if (typeof post.recipients?.recipient_count === 'number')
        result.recipientCount = post.recipients.recipient_count;
      if (post.send_time) result.sendTime = post.send_time;
      if (post.archive_url) result.archiveUrl = post.archive_url;
      if (testsSentTo) result.testsSentTo = testsSentTo;
      if (cancelledByUser) result.cancelledByUser = true;

      ctx.log.info('replicate_campaign complete', {
        sourceId: input.sourceCampaignId,
        newId: newCampaignId,
        mode: effectiveMode,
      });
      return result;
    } catch (err) {
      if (newCampaignId && input.cleanupOnError) {
        try {
          await svc.campaigns.delete(ctx, newCampaignId);
          ctx.log.info('replica draft cleaned up after failure', { campaignId: newCampaignId });
        } catch (cleanupErr) {
          ctx.log.warning('cleanup failed; replica draft may remain', {
            campaignId: newCampaignId,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
      throw err;
    }
  },

  format: (result) => {
    const lines: string[] = [
      `# ${result.cancelledByUser ? 'Replica cancelled' : `Campaign replicated — ${result.mode}`}: ${result.subject}`,
      '',
      `**New campaign ID:** ${result.campaignId}  `,
      `**Source:** ${result.sourceCampaignId}  `,
      `**Status:** ${result.status}  `,
      `**Mode:** ${result.mode}${result.cancelledByUser ? ' (downgraded from send/schedule)' : ''}  `,
    ];
    if (result.overridesApplied.length > 0)
      lines.push(`**Overrides applied:** ${result.overridesApplied.join(', ')}  `);
    if (typeof result.recipientCount === 'number')
      lines.push(`**Recipients:** ${result.recipientCount}  `);
    if (result.sendTime) lines.push(`**Send time:** ${result.sendTime}  `);
    if (result.testsSentTo && result.testsSentTo.length > 0)
      lines.push(`**Test sent to:** ${result.testsSentTo.join(', ')}  `);
    if (result.archiveUrl) lines.push(`**Archive:** ${result.archiveUrl}  `);
    if (typeof result.webId === 'number') lines.push(`**Web ID:** ${result.webId}  `);
    if (result.webUrl) lines.push(`**Mailchimp UI:** ${result.webUrl}  `);
    if (result.checklistWarnings.length > 0) {
      lines.push('', `## Checklist warnings (${result.checklistWarnings.length})`, '');
      for (const w of result.checklistWarnings) {
        const icon = w.type === 'warning' ? '⚠' : w.type === 'error' ? '✗' : '·';
        lines.push(`- ${icon} [${w.type}] **${w.heading}** — ${w.details}`);
      }
    }
    if (result.cleanedUp) {
      lines.push(
        '',
        '> Replica draft was deleted after a mid-flow failure (`cleanupOnError: true`).',
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
