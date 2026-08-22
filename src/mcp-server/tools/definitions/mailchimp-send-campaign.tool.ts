/**
 * @fileoverview `mailchimp_send_campaign` — end-to-end campaign composer + dispatcher.
 * Creates the draft, sets content, runs the send-checklist, optionally sends a test,
 * and then sends/schedules. A re-entrant input round confirms `mode: 'send' |
 * 'schedule'` before any campaign mutation. Cleans up orphaned drafts on
 * mid-flow failure when `cleanupOnError: true` (default).
 * @module mcp-server/tools/definitions/mailchimp-send-campaign.tool
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
    'What to do with the campaign after content is set. `draft` (default — safe) leaves it unsent. `test` sends a preview to `testEmails`. `send` dispatches immediately to the audience. `schedule` queues delivery for `scheduleTime`. **Default to `draft` unless the user has explicitly authorized sending** — ambiguous requests like "set this up" or "configure the newsletter" mean `draft`. `send` and `schedule` also require `confirmSend: true`.',
  );

const ContentSchema = z
  .object({
    html: z.string().optional().describe('Full HTML body. Mailchimp renders as-is.'),
    plainText: z.string().optional().describe('Plaintext body. Required for `type: plaintext`.'),
    templateId: z.coerce.number().int().optional().describe('Template ID to use as the base.'),
    templateSections: z.record(z.string(), z.unknown()).optional().describe(TEMPLATE_SECTIONS_DOC),
    localTemplate: z
      .string()
      .optional()
      .describe(
        'Name of a local template to render (without the `.eta` extension). Requires `MAILCHIMP_TEMPLATES_DIR` on the server. Mutually exclusive with `html` and `templateId` — the rendered template IS the body. Combine with `localTemplateVars` to pass variables. **Recommended write path on free-tier Mailchimp**, where the upstream templates API is read-only.',
      ),
    localTemplateVars: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Variables passed to Eta when rendering `localTemplate`. Reference inside the template via `<%= it.varName %>`.',
      ),
  })
  .describe(
    'Campaign content. Provide at least one of html / plainText / templateId / localTemplate.',
  );

const InputSchema = z.object({
  audienceId: z.string().describe('Audience (list) ID to send to.'),
  subject: z.string().describe('Subject line.'),
  fromName: z.string().describe('From-name displayed in recipient inbox.'),
  replyTo: z.string().describe('Reply-to email address.'),
  previewText: z
    .string()
    .optional()
    .describe('Preview text (shown by most clients after subject).'),
  title: z.string().optional().describe('Internal campaign title (defaults to subject).'),
  type: z
    .enum(['regular', 'plaintext', 'rss'])
    .default('regular')
    .describe('Campaign type. Only `regular`/`plaintext`/`rss` are supported (A/B is paid).'),
  segmentId: z.coerce
    .number()
    .int()
    .optional()
    .describe('Saved-segment ID to target a subset of the audience.'),
  content: ContentSchema,
  mode: ModeSchema.default('draft'),
  confirmSend: z
    .boolean()
    .default(false)
    .describe(
      "Required `true` to dispatch when `mode: 'send' | 'schedule'`. Structural confirmation that the user has explicitly authorized the send. The handler rejects `mode: 'send'`/`'schedule'` calls with `confirmSend: false`. Leave `false` for `draft`/`test`. Before flipping to `true`, surface a one-line summary (subject, audience name, recipient count, send time if scheduled) and get explicit user authorization.",
    ),
  scheduleTime: z
    .string()
    .optional()
    .describe(
      'ISO 8601 send time for `mode: schedule`. Must be at least 15 minutes in the future per Mailchimp rules.',
    ),
  testEmails: z
    .array(z.string())
    .max(50)
    .optional()
    .describe('Test-email recipients for `mode: test`. Max 50.'),
  testSendType: z.enum(['html', 'plaintext']).default('html').describe('Format for the test send.'),
  cleanupOnError: z
    .boolean()
    .default(true)
    .describe(
      'Delete the draft campaign if the workflow throws mid-flight. Default `true` — prevents orphan drafts cluttering the account. Set `false` if you want to inspect the draft after a failure.',
    ),
});

const ChecklistItemSchema = z
  .object({
    type: z.enum(['success', 'warning', 'error']).describe('Severity of the checklist entry.'),
    heading: z.string().describe('Short title of the checklist item.'),
    details: z.string().describe('Full description of the checklist finding.'),
  })
  .describe('One entry from the Mailchimp campaign send-checklist.');

const OutputSchema = z.object({
  campaignId: z.string().describe('Mailchimp campaign ID — use for follow-up tool calls.'),
  webId: z.number().optional().describe('Mailchimp web-id (for UI deep links).'),
  mode: ModeSchema.describe(
    'What actually happened; downgraded to `draft` if the user declined the confirmation prompt.',
  ),
  status: z.string().describe('Post-action Mailchimp campaign status.'),
  subject: z.string().describe('Subject line used (echoed from input).'),
  recipientCount: z
    .number()
    .optional()
    .describe('Number of recipients the campaign was addressed to.'),
  sendTime: z.string().optional().describe('Scheduled send time (ISO 8601) when mode=schedule.'),
  testsSentTo: z.array(z.string()).optional().describe('Test recipients, only when mode=test.'),
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
    .describe('True if the draft was deleted due to a mid-flow failure.'),
});

type Output = z.infer<typeof OutputSchema>;

export const mailchimpSendCampaignTool = tool('mailchimp_send_campaign', {
  description:
    "Compose a Mailchimp campaign and optionally test/send/schedule it in one call. Creates the draft, sets content, runs the send-checklist, then either leaves it as a draft (default) or dispatches per `mode`. **Send-capable — default to `mode: 'draft'`.** Only use `mode: 'send'` or `'schedule'` when the user has explicitly authorized dispatch; ambiguous phrasing like 'set up next week's newsletter', 'compose a draft', or 'the usual' does NOT authorize a send — leave as `draft`, return the `campaignId` and `webUrl`, and let the user run a follow-up send after reviewing. Send/schedule modes require `confirmSend: true`. Failed drafts are auto-deleted when `cleanupOnError: true` (default); declined confirmation leaves a reviewable draft.",
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
        'Inspect data.requiresPlan when present; otherwise the API key lacks scope for sending campaigns.',
    },
    {
      reason: 'mailchimp_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — audienceId, segmentId, or templateId does not exist.',
      recovery:
        'Verify IDs via mailchimp_audiences / mailchimp_segments / mailchimp_templates list; cleaned-up draft is deleted automatically when cleanupOnError is true (default).',
    },
    {
      reason: 'mailchimp_validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp returned 400 or 422 — usually a malformed subject/from-name/reply-to, oversized content, or scheduleTime under 15 minutes in the future.',
      recovery:
        'Inspect data.upstream.errors[]; ensure scheduleTime is ≥15 minutes ahead and content fits Mailchimp size caps.',
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
      when: 'Mailchimp send-checklist returned blocking errors.',
      recovery:
        'Inspect data.errors for each blocking finding, fix the campaign (subject/content/list), then re-invoke.',
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    if (
      !input.content.html &&
      !input.content.plainText &&
      !input.content.templateId &&
      !input.content.localTemplate
    ) {
      throw validationError(
        "'content' must provide at least one of `html`, `plainText`, `templateId`, or `localTemplate`.",
      );
    }
    if (input.type === 'plaintext' && !input.content.plainText) {
      throw validationError("'type: plaintext' requires `content.plainText`.");
    }
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
        const audience = await svc.audiences
          .get(ctx, input.audienceId, { fields: ['name', 'stats.member_count'] })
          .catch(() => null);
        const audienceLabel = audience?.name ?? input.audienceId;
        const count = audience?.stats?.member_count;
        return input.mode === 'send'
          ? `Send "${input.subject}" to ${count ?? 'all'} subscribers in "${audienceLabel}" now?`
          : `Schedule "${input.subject}" to "${audienceLabel}" (${count ?? '?'} subscribers) for ${input.scheduleTime}?`;
      });
      cancelledByUser = !confirmed;
    }

    const content = await resolveLocalTemplate(ctx, input.content);

    let campaignId: string | undefined;
    let cleanedUp = false;

    try {
      // 1. Create draft after the confirmation round completes.
      const settings: Parameters<typeof svc.campaigns.create>[1]['settings'] = {
        subject_line: input.subject,
        from_name: input.fromName,
        reply_to: input.replyTo,
        title: input.title ?? input.subject,
      };
      if (input.previewText) settings.preview_text = input.previewText;

      const draft = await svc.campaigns.create(ctx, {
        type: input.type,
        recipients: {
          list_id: input.audienceId,
          ...(typeof input.segmentId === 'number'
            ? { segment_opts: { saved_segment_id: input.segmentId } }
            : {}),
        },
        settings,
      });
      campaignId = draft.id;
      ctx.log.info('draft created', { campaignId, subject: input.subject });

      // 2. Set content (with optional @assets/* rewrite).
      const contentBody: Parameters<typeof svc.campaigns.setContent>[2] = {};
      if (content.html) contentBody.html = content.html;
      if (content.plainText) contentBody.plain_text = content.plainText;
      if (typeof content.templateId === 'number') {
        contentBody.template = {
          id: content.templateId,
          ...(content.templateSections ? { sections: content.templateSections } : {}),
        };
      }
      const rewritten = await rewriteAssetsInContent(ctx, contentBody);
      await svc.campaigns.setContent(ctx, campaignId, rewritten);

      // 3. Checklist.
      const checklist = await svc.campaigns.getChecklist(ctx, campaignId);
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

      // 4. Dispatch.
      const effectiveMode: z.infer<typeof ModeSchema> = cancelledByUser ? 'draft' : input.mode;
      let testsSentTo: string[] | undefined;
      if (effectiveMode === 'test') {
        await svc.campaigns.sendTest(ctx, campaignId, {
          test_emails: input.testEmails ?? [],
          send_type: input.testSendType,
        });
        testsSentTo = input.testEmails ?? [];
      } else if (effectiveMode === 'send') {
        await svc.campaigns.send(ctx, campaignId);
      } else if (effectiveMode === 'schedule') {
        await svc.campaigns.schedule(ctx, campaignId, {
          schedule_time: input.scheduleTime as string,
        });
      }

      // 5. Fetch post-action state.
      const post = await svc.campaigns.get(ctx, campaignId);

      const result: Output = {
        campaignId,
        mode: effectiveMode,
        status: post.status,
        subject: post.settings?.subject_line ?? input.subject,
        checklistWarnings: warnings.map((w) => ({
          type: w.type,
          heading: w.heading,
          details: w.details,
        })),
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

      ctx.log.info('send_campaign complete', {
        campaignId,
        mode: effectiveMode,
        status: post.status,
      });
      return result;
    } catch (err) {
      if (campaignId && input.cleanupOnError) {
        try {
          await svc.campaigns.delete(ctx, campaignId);
          cleanedUp = true;
          ctx.log.info('orphan draft cleaned up after failure', { campaignId });
        } catch (cleanupErr) {
          ctx.log.warning('cleanup failed; draft may remain', {
            campaignId,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
      if (err instanceof Error) {
        const augmented = Object.assign(err, {
          data: { ...(('data' in err && err.data) || {}), cleanedUp },
        });
        throw augmented;
      }
      throw err;
    }
  },

  format: (result) => {
    const lines: string[] = [
      `# ${result.cancelledByUser ? 'Send cancelled' : `Campaign ${result.mode}`}: ${result.subject}`,
      '',
      `**ID:** ${result.campaignId}  `,
      `**Status:** ${result.status}  `,
      `**Mode:** ${result.mode}${result.cancelledByUser ? ' (downgraded from send/schedule)' : ''}  `,
    ];
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
      lines.push('', '> Draft was deleted after a mid-flow failure (`cleanupOnError: true`).');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
