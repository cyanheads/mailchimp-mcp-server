/**
 * @fileoverview `mailchimp_campaigns` — campaign records, content, and actions by ID.
 * @module mcp-server/tools/definitions/mailchimp-campaigns.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { rewriteAssetsInContent } from '@/mcp-server/tools/shared/asset-rewrite.js';
import { confirmCampaignDispatch } from '@/mcp-server/tools/shared/campaign-dispatch-confirmation.js';
import {
  listEnrichment,
  listEnrichmentTrailer,
  pageEndNotice,
} from '@/mcp-server/tools/shared/list-enrichment.js';
import {
  codeText,
  headingText,
  inlineText,
  webLink,
} from '@/mcp-server/tools/shared/markdown-values.js';
import { resolveLocalTemplate } from '@/mcp-server/tools/shared/resolve-local-template.js';
import { TEMPLATE_SECTIONS_DOC } from '@/mcp-server/tools/shared/template-sections-doc.js';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import type { Campaign } from '@/services/mailchimp/types.js';

const OperationSchema = z
  .enum([
    'list',
    'get',
    'create',
    'update',
    'replicate',
    'get-content',
    'set-content',
    'get-checklist',
    'send-test',
    'send',
    'schedule',
    'delete',
    'cancel-send',
    'create-resend',
    'pause-rss',
    'resume-rss',
  ])
  .describe(
    '`send-test`, `send`, `schedule`, and `delete` act on an existing draft. `get-content`/`set-content` manage its body and `get-checklist` checks readiness. `cancel-send` aborts an in-flight send, `create-resend` makes a resend-to-non-openers draft, and `pause-rss`/`resume-rss` control RSS-driven campaigns.',
  );

const CampaignTypeSchema = z
  .enum(['regular', 'plaintext', 'rss'])
  .describe('Campaign type. `absplit`/`variate` are paid-only and intentionally excluded.');

const RecipientsSchema = z.object({
  listId: z.string().describe('Audience (list) ID.'),
  savedSegmentId: z.coerce
    .number()
    .int()
    .optional()
    .describe('Optional saved-segment ID to target a subset of the audience.'),
});

const SettingsSchema = z.object({
  subjectLine: z.string().optional().describe('Email subject line as recipients see it.'),
  previewText: z.string().optional().describe('Inbox preview / preheader text.'),
  title: z.string().optional().describe('Internal campaign title (not seen by recipients).'),
  fromName: z.string().optional().describe('Display name for the "From" field.'),
  replyTo: z.string().optional().describe('Reply-To email address.'),
  toName: z.string().optional().describe('Personalization merge tag for the To field.'),
  authenticate: z.boolean().optional().describe('Enable SPF/DKIM authentication on send.'),
  autoFooter: z
    .boolean()
    .optional()
    .describe('Automatically append the Mailchimp CAN-SPAM footer.'),
  inlineCss: z.boolean().optional().describe('Inline CSS into HTML at render time.'),
  templateId: z.coerce
    .number()
    .int()
    .optional()
    .describe('Saved-template ID to base this campaign on.'),
});

const ContentSchema = z.object({
  html: z.string().optional().describe('Full campaign HTML body.'),
  plainText: z.string().optional().describe('Plaintext body for the campaign.'),
  templateId: z.coerce
    .number()
    .int()
    .optional()
    .describe('Saved-template ID to render this campaign from.'),
  templateSections: z.record(z.string(), z.unknown()).optional().describe(TEMPLATE_SECTIONS_DOC),
  archiveContent: z.string().optional().describe('Base64-encoded zip or HTML archive.'),
  archiveType: z
    .string()
    .optional()
    .describe('Archive format (one of `zip`, `tar`, `tar.gz`, `tar.bz2`).'),
  url: z.string().optional().describe('Fetch HTML from a URL.'),
  localTemplate: z
    .string()
    .optional()
    .describe(
      'Name of a local template to render (without the `.eta` extension). Requires `MAILCHIMP_TEMPLATES_DIR` on the server. Mutually exclusive with `html` and `templateId`. Combine with `localTemplateVars` to pass variables.',
    ),
  localTemplateVars: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Variables passed to Eta when rendering `localTemplate`.'),
});

const InputSchema = z.object({
  operation: OperationSchema,
  variant: z
    .enum(['html', 'plainText', 'archiveHtml', 'all'])
    .default('all')
    .describe(
      'Representation returned by `get-content`; `all` preserves every populated body. Ignored by other operations.',
    ),
  campaignId: z
    .string()
    .optional()
    .describe('Campaign ID. Required for every operation except `list` and `create`.'),
  type: CampaignTypeSchema.optional().describe('Required for `create`.'),
  recipients: RecipientsSchema.optional().describe('Required for `create`.'),
  settings: SettingsSchema.optional().describe('Required for `create`; partial for `update`.'),
  content: ContentSchema.optional().describe('Required for `set-content`.'),
  confirmSend: z
    .boolean()
    .optional()
    .describe(
      'Required for `send` and `schedule` after explicit user authorization. The client must also complete the confirmation round.',
    ),
  scheduleTime: z.iso
    .datetime()
    .optional()
    .describe(
      'Required for `schedule`. Future UTC time on a quarter-hour, including the Z suffix.',
    ),
  testEmails: z
    .array(z.email())
    .min(1)
    .max(50)
    .optional()
    .describe('Explicit preview addresses for `send-test` (1–50).'),
  testSendType: z
    .enum(['html', 'plaintext'])
    .optional()
    .describe('Required format for `send-test`.'),
  // filters for list
  status: z
    .string()
    .optional()
    .describe(
      'Filter by campaign status for `list` (`save`, `paused`, `schedule`, `sending`, `sent`).',
    ),
  listId: z.string().optional().describe('Filter campaigns by audience ID for `list`.'),
  sinceSendTime: z
    .string()
    .optional()
    .describe('Filter `list` to campaigns sent after this ISO 8601 timestamp.'),
  beforeSendTime: z
    .string()
    .optional()
    .describe('Filter `list` to campaigns sent before this ISO 8601 timestamp.'),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(10)
    .describe('Page size for `list`. Max 1000.'),
  offset: z.coerce.number().int().min(0).default(0).describe('Offset for `list` pagination.'),
});

const CampaignSummarySchema = z
  .object({
    id: z.string().describe('Campaign ID.'),
    webId: z.number().optional().describe('Mailchimp numeric web-id (for UI deep links).'),
    type: z.string().describe('Campaign type (`regular`, `plaintext`, `rss`).'),
    status: z
      .string()
      .describe('Mailchimp campaign status (`save`, `schedule`, `sending`, `sent`, …).'),
    title: z.string().optional().describe('Internal campaign title.'),
    subjectLine: z.string().optional().describe('Subject line as recipients see it.'),
    fromName: z.string().optional().describe('Display name for the "From" field.'),
    createTime: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp the campaign draft was created.'),
    sendTime: z.string().optional().describe('ISO 8601 send timestamp (past or scheduled).'),
    emailsSent: z.number().optional().describe('Emails actually delivered.'),
    archiveUrl: z.string().optional().describe('Public archive URL (populated after send).'),
    audienceId: z.string().optional().describe('Audience (list) ID the campaign targets.'),
    audienceName: z.string().optional().describe('Human-readable audience name.'),
    recipientCount: z.number().optional().describe('Number of recipients the send targeted.'),
    segmentText: z.string().optional().describe('Human-readable segment description.'),
    openRate: z.number().optional().describe('Mean open rate from the report summary (0–1).'),
    clickRate: z.number().optional().describe('Mean click rate from the report summary (0–1).'),
  })
  .describe('Summary view of one campaign: identity, settings, recipients, headline rates.');

const ChecklistItemSchema = z
  .object({
    type: z.enum(['success', 'warning', 'error']).describe('Severity of the checklist entry.'),
    heading: z.string().describe('Short title of the checklist item.'),
    details: z.string().describe('Full description of the checklist finding.'),
    id: z.number().optional().describe('Mailchimp checklist item ID when provided.'),
  })
  .describe('One entry in the campaign send-checklist.');

const OutputSchema = z.object({
  operation: OperationSchema,
  campaignId: z
    .string()
    .optional()
    .describe('Existing ID acted on by `send-test`, `send`, `schedule`, or `delete`.'),
  campaign: CampaignSummarySchema.optional().describe(
    'Populated for `get`, `create`, `update`, `replicate`, `create-resend`.',
  ),
  campaigns: z.array(CampaignSummarySchema).optional().describe('Populated for `list`.'),
  totalItems: z.number().optional().describe('Total items from Mailchimp (for `list`).'),
  content: z
    .object({
      html: z.string().optional().describe('Rendered HTML body of the campaign.'),
      plainText: z.string().optional().describe('Plaintext body of the campaign.'),
      archiveHtml: z.string().optional().describe('Archive-ready HTML (older Mailchimp field).'),
    })
    .optional()
    .describe('Populated for `get-content` and `set-content`.'),
  checklist: z
    .object({
      isReady: z.boolean().describe('True when Mailchimp considers the campaign ready to send.'),
      items: z
        .array(ChecklistItemSchema)
        .describe('Individual checklist entries with severity and guidance.'),
    })
    .optional()
    .describe('Populated for `get-checklist`.'),
});

type Output = z.infer<typeof OutputSchema>;

function summarize(c: Campaign): z.infer<typeof CampaignSummarySchema> {
  const out: z.infer<typeof CampaignSummarySchema> = {
    id: c.id,
    type: c.type,
    status: c.status,
  };
  if (typeof c.web_id === 'number') out.webId = c.web_id;
  if (c.settings?.title) out.title = c.settings.title;
  if (c.settings?.subject_line) out.subjectLine = c.settings.subject_line;
  if (c.settings?.from_name) out.fromName = c.settings.from_name;
  if (c.create_time) out.createTime = c.create_time;
  if (c.send_time) out.sendTime = c.send_time;
  if (typeof c.emails_sent === 'number') out.emailsSent = c.emails_sent;
  if (c.archive_url) out.archiveUrl = c.archive_url;
  if (c.recipients?.list_id) out.audienceId = c.recipients.list_id;
  if (c.recipients?.list_name) out.audienceName = c.recipients.list_name;
  if (typeof c.recipients?.recipient_count === 'number')
    out.recipientCount = c.recipients.recipient_count;
  if (c.recipients?.segment_text) out.segmentText = c.recipients.segment_text;
  if (typeof c.report_summary?.open_rate === 'number') out.openRate = c.report_summary.open_rate;
  if (typeof c.report_summary?.click_rate === 'number') out.clickRate = c.report_summary.click_rate;
  return out;
}

function requireCampaignId(input: z.infer<typeof InputSchema>): string {
  if (!input.campaignId)
    throw validationError(`'campaignId' is required for operation '${input.operation}'.`);
  return input.campaignId;
}

function buildSettings(settings: z.infer<typeof SettingsSchema> | undefined) {
  if (!settings) return;
  const out: Partial<NonNullable<Campaign['settings']>> = {};
  if (settings.subjectLine !== undefined) out.subject_line = settings.subjectLine;
  if (settings.previewText !== undefined) out.preview_text = settings.previewText;
  if (settings.title !== undefined) out.title = settings.title;
  if (settings.fromName !== undefined) out.from_name = settings.fromName;
  if (settings.replyTo !== undefined) out.reply_to = settings.replyTo;
  if (settings.toName !== undefined) out.to_name = settings.toName;
  if (typeof settings.authenticate === 'boolean') out.authenticate = settings.authenticate;
  if (typeof settings.autoFooter === 'boolean') out.auto_footer = settings.autoFooter;
  if (typeof settings.inlineCss === 'boolean') out.inline_css = settings.inlineCss;
  if (typeof settings.templateId === 'number') out.template_id = settings.templateId;
  return out;
}

export const mailchimpCampaignsTool = tool('mailchimp_campaigns', {
  description:
    'Manage campaigns and revise, test, send, schedule, or delete an existing draft by ID. Use `get-checklist` to check readiness. Send and schedule require explicit user authorization, `confirmSend: true`, and a confirmation round. Deleting a draft requires confirmation. Use `mailchimp_send_campaign` or `mailchimp_replicate_campaign` when you need a new campaign.',
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,
  enrichment: listEnrichment,
  enrichmentTrailer: listEnrichmentTrailer,
  errors: [
    {
      reason: 'campaign_not_draft',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'The requested draft action targets a campaign outside the save state.',
      recovery: 'List campaigns with status save and choose a draft campaign ID.',
    },
    {
      reason: 'campaign_action_cancelled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'The user declined or cancelled an existing draft action.',
      recovery: 'Leave the existing draft as is or begin a new confirmation.',
    },
    {
      reason: 'pre_send_checklist_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp marked the campaign as unready or reported send-checklist errors.',
      recovery: 'Review the checklist and fix the existing draft before dispatch.',
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
        'Inspect data.requiresPlan when present; otherwise the API key lacks scope for this campaign operation.',
    },
    {
      reason: 'mailchimp_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — campaign does not exist or has been deleted.',
      recovery: 'Run mailchimp_campaigns operation:list to discover valid campaignId values.',
    },
    {
      reason: 'mailchimp_validation_failed',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp returned 400 or 422 — request body failed upstream validation.',
      recovery: 'Inspect data.upstream.errors[] for field-level reasons, fix the input, and retry.',
    },
    {
      reason: 'mailchimp_rate_limited',
      thrownBy: 'service',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Mailchimp returned 429 — too many concurrent requests.',
      recovery:
        'Retry after a brief delay; reduce MAILCHIMP_CONCURRENCY_LIMIT for bulk operations.',
      retryable: true,
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    switch (input.operation) {
      case 'list': {
        const query = {
          count: input.count,
          offset: input.offset,
          ...(input.status ? { status: input.status } : {}),
          ...(input.listId ? { listId: input.listId } : {}),
          ...(input.sinceSendTime ? { sinceSendTime: input.sinceSendTime } : {}),
          ...(input.beforeSendTime ? { beforeSendTime: input.beforeSendTime } : {}),
        };
        const { campaigns, total_items } = await svc.campaigns.list(ctx, query);
        ctx.enrich({ filters: query });
        if (campaigns.length === 0) {
          ctx.enrich.notice(
            pageEndNotice(
              'campaigns',
              input.offset,
              total_items,
              'No campaigns matched. Widen or drop `status`, `listId`, `sinceSendTime`, and `beforeSendTime`; with none set, the account has no campaigns yet — create a draft with `operation: create`.',
            ),
          );
        }
        return {
          operation: 'list',
          totalItems: total_items,
          campaigns: campaigns.map(summarize),
        };
      }

      case 'get': {
        const c = await svc.campaigns.get(ctx, requireCampaignId(input));
        return { operation: 'get', campaign: summarize(c) };
      }

      case 'create': {
        if (!input.type) throw validationError("'type' is required for 'create'.");
        if (!input.recipients) throw validationError("'recipients' is required for 'create'.");
        const settings = buildSettings(input.settings) ?? {};
        const body: Parameters<typeof svc.campaigns.create>[1] = {
          type: input.type,
          recipients: {
            list_id: input.recipients.listId,
            ...(typeof input.recipients.savedSegmentId === 'number'
              ? { segment_opts: { saved_segment_id: input.recipients.savedSegmentId } }
              : {}),
          },
          settings,
        };
        const c = await svc.campaigns.create(ctx, body);
        ctx.log.info('campaign draft created', { campaignId: c.id });
        return { operation: 'create', campaign: summarize(c) };
      }

      case 'update': {
        const id = requireCampaignId(input);
        const body: Partial<Campaign> = {};
        if (input.settings) {
          const s = buildSettings(input.settings);
          if (s) body.settings = s;
        }
        if (input.recipients) {
          body.recipients = {
            list_id: input.recipients.listId,
            ...(typeof input.recipients.savedSegmentId === 'number'
              ? { segment_opts: { saved_segment_id: input.recipients.savedSegmentId } }
              : {}),
          };
        }
        if (Object.keys(body).length === 0)
          throw validationError(
            "At least one of 'settings' or 'recipients' must be provided for 'update'.",
          );
        const c = await svc.campaigns.update(ctx, id, body);
        return { operation: 'update', campaign: summarize(c) };
      }

      case 'replicate': {
        const c = await svc.campaigns.replicate(ctx, requireCampaignId(input));
        return { operation: 'replicate', campaign: summarize(c) };
      }

      case 'get-content': {
        const content = await svc.campaigns.getContent(ctx, requireCampaignId(input));
        const out: NonNullable<Output['content']> = {};
        if (content.html && (input.variant === 'all' || input.variant === 'html'))
          out.html = content.html;
        if (content.plain_text && (input.variant === 'all' || input.variant === 'plainText'))
          out.plainText = content.plain_text;
        if (content.archive_html && (input.variant === 'all' || input.variant === 'archiveHtml'))
          out.archiveHtml = content.archive_html;
        return { operation: 'get-content', content: out };
      }

      case 'set-content': {
        if (!input.content) throw validationError("'content' is required for 'set-content'.");
        const id = requireCampaignId(input);
        const content = await resolveLocalTemplate(ctx, input.content);
        const body: Parameters<typeof svc.campaigns.setContent>[2] = {};
        if (content.html) body.html = content.html;
        if (content.plainText) body.plain_text = content.plainText;
        if (typeof content.templateId === 'number') {
          body.template = {
            id: content.templateId,
            ...(content.templateSections ? { sections: content.templateSections } : {}),
          };
        }
        if (content.archiveContent) {
          body.archive = {
            archive_content: content.archiveContent,
            ...(content.archiveType ? { archive_type: content.archiveType } : {}),
          };
        }
        if (content.url) body.url = content.url;
        if (Object.keys(body).length === 0)
          throw validationError(
            'Must provide at least one of: html, plainText, templateId, archiveContent, url, localTemplate.',
          );
        const rewritten = await rewriteAssetsInContent(ctx, body);
        const saved = await svc.campaigns.setContent(ctx, id, rewritten);
        const out: NonNullable<Output['content']> = {};
        if (saved.html) out.html = saved.html;
        if (saved.plain_text) out.plainText = saved.plain_text;
        return { operation: 'set-content', content: out };
      }

      case 'get-checklist': {
        const checklist = await svc.campaigns.getChecklist(ctx, requireCampaignId(input));
        return {
          operation: 'get-checklist',
          checklist: {
            isReady: checklist.is_ready,
            items: checklist.items.map((i) => {
              const out: z.infer<typeof ChecklistItemSchema> = {
                type: i.type,
                heading: i.heading,
                details: i.details,
              };
              if (typeof i.id === 'number') out.id = i.id;
              return out;
            }),
          },
        };
      }

      case 'send-test':
      case 'send':
      case 'schedule':
      case 'delete': {
        const campaignId = requireCampaignId(input);
        if (campaignId === '.' || campaignId === '..' || /[\s/\\%]/u.test(campaignId))
          throw validationError("'campaignId' must be a single Mailchimp campaign identifier.");
        const id = encodeURIComponent(campaignId);
        const { operation, scheduleTime, testEmails, testSendType } = input;
        if ((operation === 'send' || operation === 'schedule') && !input.confirmSend)
          throw validationError(
            "'confirmSend: true' is required after explicit user authorization.",
          );
        let performAction: () => Promise<void>;
        switch (operation) {
          case 'schedule':
            if (
              !scheduleTime ||
              Date.parse(scheduleTime) <= Date.now() ||
              !/T\d{2}:(?:00|15|30|45)(?::00(?:\.0+)?)?Z$/.test(scheduleTime)
            )
              throw validationError("'scheduleTime' must be a future UTC quarter-hour.");
            performAction = () => svc.campaigns.schedule(ctx, id, { schedule_time: scheduleTime });
            break;
          case 'send-test':
            if (!testEmails || !testSendType)
              throw validationError(
                "'testEmails' and 'testSendType' are required for 'send-test'.",
              );
            performAction = () =>
              svc.campaigns.sendTest(ctx, id, { test_emails: testEmails, send_type: testSendType });
            break;
          case 'send':
            performAction = () => svc.campaigns.send(ctx, id);
            break;
          case 'delete':
            performAction = () => svc.campaigns.delete(ctx, id);
            break;
        }

        const campaign = await svc.campaigns.get(ctx, id);
        if (campaign.status !== 'save')
          throw ctx.fail(
            'campaign_not_draft',
            `Campaign ${campaign.id} has status ${campaign.status}.`,
          );

        if (operation !== 'delete') {
          const checklist = await svc.campaigns.getChecklist(ctx, id);
          const errors = checklist.items.filter((item) => item.type === 'error');
          if (checklist.is_ready === false || errors.length)
            throw ctx.fail(
              'pre_send_checklist_failed',
              errors.length
                ? `Campaign checklist errors: ${errors.map((item) => item.heading).join('; ')}.`
                : 'Mailchimp marked the campaign as unready to send.',
              { errors },
            );
        }

        if (operation !== 'send-test') {
          const { _links, ...content } = await svc.campaigns.getContent(ctx, id);
          const {
            id: campaignId,
            status,
            type,
            settings,
            recipients,
            rss_opts,
            variate_settings,
            ab_split_opts,
            tracking,
            social_card,
          } = campaign;
          const confirmed = await confirmCampaignDispatch(
            ctx,
            {
              operation: `mailchimp_campaigns:${operation}`,
              target: id,
              content: () => ({
                status,
                type,
                settings,
                recipients,
                rss_opts,
                variate_settings,
                ab_split_opts,
                tracking,
                social_card,
                content,
                ...(operation === 'schedule' ? { scheduleTime } : {}),
              }),
            },
            () => {
              const label = settings?.subject_line ?? settings?.title ?? campaignId;
              const audience = recipients?.list_name ?? recipients?.list_id;
              const segment =
                recipients?.segment_text ??
                recipients?.segment_opts?.saved_segment_id ??
                recipients?.segment_opts?.prebuilt_segment_id ??
                (recipients?.segment_opts?.conditions?.length ? 'custom segment' : undefined);
              const details = [
                audience === undefined ? undefined : `audience "${audience}"`,
                segment === undefined ? undefined : `segment "${segment}"`,
                recipients?.recipient_count === undefined
                  ? undefined
                  : `${recipients.recipient_count} recipients`,
                operation === 'schedule' ? scheduleTime : undefined,
              ]
                .filter((detail) => detail !== undefined)
                .join(', ');
              return `${operation === 'delete' ? 'Delete draft' : operation === 'schedule' ? 'Schedule' : 'Send'} "${label}" (ID ${campaignId})${details ? ` — ${details}` : ''}?`;
            },
          );
          if (!confirmed)
            throw ctx.fail('campaign_action_cancelled', `Campaign ${campaignId} remains a draft.`);
        }

        await performAction();
        return { operation, campaignId: campaign.id };
      }

      case 'cancel-send': {
        await svc.campaigns.cancelSend(ctx, requireCampaignId(input));
        return { operation: 'cancel-send' };
      }

      case 'create-resend': {
        const c = await svc.campaigns.createResend(ctx, requireCampaignId(input));
        return { operation: 'create-resend', campaign: summarize(c) };
      }

      case 'pause-rss': {
        await svc.campaigns.pauseRss(ctx, requireCampaignId(input));
        return { operation: 'pause-rss' };
      }

      case 'resume-rss': {
        await svc.campaigns.resumeRss(ctx, requireCampaignId(input));
        return { operation: 'resume-rss' };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`Operation: ${result.operation}`, ''];
    if (result.campaignId) lines.push(`Campaign ID: ${codeText(result.campaignId)}`);

    const renderSummary = (c: z.infer<typeof CampaignSummarySchema>, bullet: boolean): void => {
      const prefix = bullet ? '- ' : '';
      const indent = bullet ? '  ' : '';
      const subj = c.subjectLine ? `"${c.subjectLine}"` : (c.title ?? '(untitled)');
      const titleAlt =
        c.subjectLine && c.title && c.title !== c.subjectLine
          ? ` [title: ${inlineText(c.title)}]`
          : '';
      const webIdPart = typeof c.webId === 'number' ? ` webId:${c.webId}` : '';
      lines.push(
        `${prefix}**${inlineText(subj)}**${titleAlt} (${codeText(c.id)})${webIdPart} — type:${inlineText(c.type)}, status:${inlineText(c.status)}`,
      );
      const meta: string[] = [];
      if (c.fromName) meta.push(`from ${inlineText(c.fromName)}`);
      if (c.audienceName)
        meta.push(
          `audience ${inlineText(c.audienceName)}${c.audienceId ? ` (${codeText(c.audienceId)})` : ''}`,
        );
      else if (c.audienceId) meta.push(`audienceId ${codeText(c.audienceId)}`);
      if (c.segmentText) meta.push(`segment: ${inlineText(c.segmentText)}`);
      if (typeof c.recipientCount === 'number') meta.push(`recipientCount ${c.recipientCount}`);
      if (meta.length > 0) lines.push(`${indent}${meta.join(' · ')}`);
      const times: string[] = [];
      if (c.createTime) times.push(`created ${inlineText(c.createTime)}`);
      if (c.sendTime) times.push(`sent ${inlineText(c.sendTime)}`);
      if (typeof c.emailsSent === 'number') times.push(`emailsSent ${c.emailsSent}`);
      if (times.length > 0) lines.push(`${indent}${times.join(' · ')}`);
      const rates: string[] = [];
      if (typeof c.openRate === 'number') rates.push(`openRate ${(c.openRate * 100).toFixed(2)}%`);
      if (typeof c.clickRate === 'number')
        rates.push(`clickRate ${(c.clickRate * 100).toFixed(2)}%`);
      if (rates.length > 0) lines.push(`${indent}${rates.join(' · ')}`);
      if (c.archiveUrl) lines.push(`${indent}archiveUrl: ${webLink(c.archiveUrl)}`);
    };

    if (result.campaigns) {
      lines.push(`# Campaigns (${result.campaigns.length} of ${result.totalItems ?? '?'})`, '');
      for (const c of result.campaigns) renderSummary(c, true);
    }

    if (result.campaign) {
      if (result.campaigns) lines.push('');
      const c = result.campaign;
      lines.push(
        headingText(c.subjectLine ? `"${c.subjectLine}"` : (c.title ?? 'Campaign'), 1, 'Campaign'),
        '',
      );
      renderSummary(c, false);
    }

    if (result.content) {
      lines.push(
        '',
        '# Campaign content',
        '',
        markdown()
          .codeBlock(JSON.stringify(result.content, null, 2), 'json')
          .build(),
      );
    }

    if (result.checklist) {
      lines.push(
        '',
        `# Send checklist — isReady: ${result.checklist.isReady ? '✅ ready' : '⚠️ not ready'}`,
        '',
      );
      for (const item of result.checklist.items) {
        const icon = item.type === 'success' ? '✓' : item.type === 'warning' ? '⚠' : '✗';
        const idPart = typeof item.id === 'number' ? ` [id:${item.id}]` : '';
        lines.push(
          `- ${icon} [${item.type}]${idPart} **${inlineText(item.heading)}** — ${inlineText(item.details)}`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
