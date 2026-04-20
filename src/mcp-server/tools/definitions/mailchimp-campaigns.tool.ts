/**
 * @fileoverview `mailchimp_campaigns` — campaign CRUD (no delete) and non-send
 * actions. Delete is intentionally omitted: deleting a SENT campaign destroys
 * its report history. Send/test/schedule/replicate-and-send live in the
 * workflow tools (`mailchimp_send_campaign`, `mailchimp_replicate_campaign`)
 * so they can run checklist validation + elicit confirmation.
 * @module mcp-server/tools/definitions/mailchimp-campaigns.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
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
    'cancel-send',
    'create-resend',
    'pause-rss',
    'resume-rss',
  ])
  .describe(
    'Which campaign operation to run. `list`/`get`/`create`/`update` are record-level; `get-content`/`set-content` manage the HTML/plaintext payload; `get-checklist` validates readiness; `cancel-send` aborts an in-flight send; `create-resend` makes a resend-to-non-openers draft; `pause-rss`/`resume-rss` control RSS-driven campaigns. NOT exposed: `send`, `send-test`, `schedule`, `delete`. Use the `mailchimp_send_campaign`/`mailchimp_replicate_campaign` workflow tools for sends — they include send-checklist validation and elicit confirmation.',
  );

const CampaignTypeSchema = z
  .enum(['regular', 'plaintext', 'rss'])
  .describe('Campaign type. `absplit`/`variate` are paid-only and intentionally excluded.');

const RecipientsSchema = z.object({
  listId: z.string().describe('Audience (list) ID.'),
  savedSegmentId: z
    .number()
    .int()
    .optional()
    .describe('Optional saved-segment ID to target a subset of the audience.'),
});

const SettingsSchema = z.object({
  subjectLine: z.string().optional(),
  previewText: z.string().optional(),
  title: z.string().optional().describe('Internal campaign title (not seen by recipients).'),
  fromName: z.string().optional(),
  replyTo: z.string().optional(),
  toName: z.string().optional().describe('Personalization merge tag for the To field.'),
  authenticate: z.boolean().optional(),
  autoFooter: z.boolean().optional(),
  inlineCss: z.boolean().optional(),
  templateId: z.number().int().optional(),
});

const ContentSchema = z.object({
  html: z.string().optional(),
  plainText: z.string().optional(),
  templateId: z.number().int().optional(),
  templateSections: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Per-section overrides when using `templateId`.'),
  archiveContent: z.string().optional().describe('Base64-encoded zip or HTML archive.'),
  archiveType: z.string().optional(),
  url: z.string().optional().describe('Fetch HTML from a URL.'),
});

const InputSchema = z.object({
  operation: OperationSchema,
  campaignId: z
    .string()
    .optional()
    .describe('Campaign ID. Required for every operation except `list` and `create`.'),
  type: CampaignTypeSchema.optional().describe('Required for `create`.'),
  recipients: RecipientsSchema.optional().describe('Required for `create`.'),
  settings: SettingsSchema.optional().describe('Required for `create`; partial for `update`.'),
  content: ContentSchema.optional().describe('Required for `set-content`.'),
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
  count: z.number().int().min(1).max(1000).default(10).describe('Page size for `list`. Max 1000.'),
  offset: z.number().int().min(0).default(0).describe('Offset for `list` pagination.'),
});

const CampaignSummarySchema = z.object({
  id: z.string(),
  webId: z.number().optional(),
  type: z.string(),
  status: z.string(),
  title: z.string().optional(),
  subjectLine: z.string().optional(),
  fromName: z.string().optional(),
  createTime: z.string().optional(),
  sendTime: z.string().optional(),
  emailsSent: z.number().optional(),
  archiveUrl: z.string().optional(),
  audienceId: z.string().optional(),
  audienceName: z.string().optional(),
  recipientCount: z.number().optional(),
  segmentText: z.string().optional(),
  openRate: z.number().optional(),
  clickRate: z.number().optional(),
});

const ChecklistItemSchema = z.object({
  type: z.enum(['success', 'warning', 'error']),
  heading: z.string(),
  details: z.string(),
  id: z.number().optional(),
});

const OutputSchema = z.object({
  operation: OperationSchema,
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
    'Campaign record management: list/get/create/update, replicate, content read/write, send-checklist, and RSS/resend controls. DELETE is intentionally not exposed — deleting a sent campaign destroys its historical reports; use `cancel-send` to abort an in-flight send, or delete via the Mailchimp UI if you truly need to. Use the `mailchimp_send_campaign` workflow tool to actually send a campaign (it chains create/content/checklist/send and elicits confirmation).',
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    switch (input.operation) {
      case 'list': {
        const query: Parameters<typeof svc.campaigns.list>[1] = {
          count: input.count,
          offset: input.offset,
        };
        if (input.status) query.status = input.status;
        if (input.listId) query.listId = input.listId;
        if (input.sinceSendTime) query.sinceSendTime = input.sinceSendTime;
        if (input.beforeSendTime) query.beforeSendTime = input.beforeSendTime;
        const { campaigns, total_items } = await svc.campaigns.list(ctx, query);
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
        if (content.html) out.html = content.html;
        if (content.plain_text) out.plainText = content.plain_text;
        if (content.archive_html) out.archiveHtml = content.archive_html;
        return { operation: 'get-content', content: out };
      }

      case 'set-content': {
        if (!input.content) throw validationError("'content' is required for 'set-content'.");
        const id = requireCampaignId(input);
        const body: Parameters<typeof svc.campaigns.setContent>[2] = {};
        if (input.content.html) body.html = input.content.html;
        if (input.content.plainText) body.plain_text = input.content.plainText;
        if (typeof input.content.templateId === 'number') {
          body.template = {
            id: input.content.templateId,
            ...(input.content.templateSections ? { sections: input.content.templateSections } : {}),
          };
        }
        if (input.content.archiveContent) {
          body.archive = {
            archive_content: input.content.archiveContent,
            ...(input.content.archiveType ? { archive_type: input.content.archiveType } : {}),
          };
        }
        if (input.content.url) body.url = input.content.url;
        if (Object.keys(body).length === 0)
          throw validationError(
            'Must provide at least one of: html, plainText, templateId, archiveContent, url.',
          );
        const saved = await svc.campaigns.setContent(ctx, id, body);
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
    const lines: string[] = [];
    if (result.operation === 'list' && result.campaigns) {
      lines.push(`# Campaigns (${result.campaigns.length} of ${result.totalItems ?? '?'})`, '');
      for (const c of result.campaigns) {
        const subj = c.subjectLine ? `"${c.subjectLine}"` : (c.title ?? '(untitled)');
        lines.push(
          `- **${subj}** (\`${c.id}\`) — ${c.type}, ${c.status}${c.sendTime ? `, sent ${c.sendTime}` : ''}`,
        );
      }
    } else if (result.campaign) {
      const c = result.campaign;
      lines.push(`# ${c.subjectLine ? `"${c.subjectLine}"` : (c.title ?? 'Campaign')}`, '');
      lines.push(`**ID:** ${c.id} · **Type:** ${c.type} · **Status:** ${c.status}  `);
      if (c.fromName) lines.push(`**From:** ${c.fromName}  `);
      if (c.audienceName)
        lines.push(`**Audience:** ${c.audienceName} (\`${c.audienceId ?? ''}\`)  `);
      if (c.segmentText) lines.push(`**Segment:** ${c.segmentText}  `);
      if (typeof c.recipientCount === 'number') lines.push(`**Recipients:** ${c.recipientCount}  `);
      if (c.sendTime) lines.push(`**Sent:** ${c.sendTime}  `);
      if (typeof c.emailsSent === 'number') lines.push(`**Emails sent:** ${c.emailsSent}  `);
      if (typeof c.openRate === 'number')
        lines.push(`**Open rate:** ${(c.openRate * 100).toFixed(2)}%  `);
      if (typeof c.clickRate === 'number')
        lines.push(`**Click rate:** ${(c.clickRate * 100).toFixed(2)}%  `);
      if (c.archiveUrl) lines.push('', `[Archive](${c.archiveUrl})`);
    } else if (result.content) {
      lines.push('# Campaign content', '');
      if (result.content.plainText) {
        lines.push(
          '**Plaintext preview:**',
          '```',
          result.content.plainText.slice(0, 1000),
          '```',
          '',
        );
      }
      if (result.content.html) {
        lines.push(`**HTML size:** ${result.content.html.length} chars`);
        lines.push('(HTML body omitted from inline preview.)');
      }
    } else if (result.checklist) {
      lines.push(`# Send checklist — ${result.checklist.isReady ? '✅ ready' : '⚠️ not ready'}`, '');
      for (const item of result.checklist.items) {
        const icon = item.type === 'success' ? '✓' : item.type === 'warning' ? '⚠' : '✗';
        lines.push(`- ${icon} **${item.heading}** — ${item.details}`);
      }
    } else {
      lines.push(`Operation \`${result.operation}\` completed.`);
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
