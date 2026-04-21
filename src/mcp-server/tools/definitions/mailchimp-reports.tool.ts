/**
 * @fileoverview `mailchimp_reports` — generic campaign-report slicer.
 * For the common "how did campaign X do?" question use the
 * `mailchimp_campaign_report` workflow tool instead — this tool is for
 * the 10+ individual report dimensions Mailchimp exposes.
 * @module mcp-server/tools/definitions/mailchimp-reports.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import { normalizeMailchimp } from '@/services/mailchimp/normalize.js';
import type { CampaignReport } from '@/services/mailchimp/types.js';

type Row = Record<string, unknown>;
const normalizeRows = (rows: unknown): Row[] => normalizeMailchimp<Row[]>(rows ?? []);
const normalizeRow = (row: unknown): Row => normalizeMailchimp<Row>(row);

const OperationSchema = z
  .enum(['list', 'get', 'slice'])
  .describe(
    'Which report read. `list`/`get` — report index or a single campaign report. `slice` — one dimension (click-details / opens / locations / etc.), chosen via `dimension`.',
  );

const DimensionSchema = z
  .enum([
    'abuse-reports',
    'advice',
    'click-details',
    'open-details',
    'domain-performance',
    'eepurl',
    'email-activity',
    'locations',
    'sent-to',
    'unsubscribed',
  ])
  .describe('Report slice dimension. Required when `operation = slice`.');

const InputSchema = z.object({
  operation: OperationSchema,
  campaignId: z.string().optional().describe('Campaign ID. Required for `get` and `slice`.'),
  dimension: DimensionSchema.optional(),
  linkId: z
    .string()
    .optional()
    .describe(
      'Link ID for click-details drill-down (fetches per-member click history for a specific URL).',
    ),
  subscriberHash: z
    .string()
    .optional()
    .describe('Subscriber hash for open-details drill-down (per-member open history).'),
  since: z
    .string()
    .optional()
    .describe('ISO 8601 lower bound for `email-activity` / `open-details`.'),
  type: z.string().optional().describe('Campaign type filter for `list`.'),
  beforeSendTime: z
    .string()
    .optional()
    .describe('Filter `list` to reports for campaigns sent before this ISO 8601 timestamp.'),
  sinceSendTime: z
    .string()
    .optional()
    .describe('Filter `list` to reports for campaigns sent after this ISO 8601 timestamp.'),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(20)
    .describe('Page size for list-style reads. Max 1000.'),
  offset: z.coerce.number().int().min(0).default(0).describe('Offset for list-style pagination.'),
});

const ReportSummarySchema = z.object({
  id: z.string(),
  campaignTitle: z.string().optional(),
  subjectLine: z.string().optional(),
  sendTime: z.string().optional(),
  emailsSent: z.number().optional(),
  openRate: z.number().optional(),
  clickRate: z.number().optional(),
  unsubscribed: z.number().optional(),
  abuseReports: z.number().optional(),
  audienceName: z.string().optional(),
});

const OutputSchema = z.object({
  operation: OperationSchema,
  dimension: DimensionSchema.optional(),
  campaignId: z.string().optional().describe('Echoed campaign ID for `get` and `slice`.'),
  report: ReportSummarySchema.optional().describe('Populated for `get`.'),
  reports: z.array(ReportSummarySchema).optional().describe('Populated for `list`.'),
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('Raw per-row data for the requested dimension.'),
  totalItems: z
    .number()
    .optional()
    .describe('Total items available upstream (for `list` / `slice`).'),
});

type Output = z.infer<typeof OutputSchema>;

function summarize(r: CampaignReport): z.infer<typeof ReportSummarySchema> {
  const out: z.infer<typeof ReportSummarySchema> = { id: r.id };
  if (r.campaign_title) out.campaignTitle = r.campaign_title;
  if (r.subject_line) out.subjectLine = r.subject_line;
  if (r.send_time) out.sendTime = r.send_time;
  if (typeof r.emails_sent === 'number') out.emailsSent = r.emails_sent;
  if (typeof r.opens?.open_rate === 'number') out.openRate = r.opens.open_rate;
  if (typeof r.clicks?.click_rate === 'number') out.clickRate = r.clicks.click_rate;
  if (typeof r.unsubscribed === 'number') out.unsubscribed = r.unsubscribed;
  if (typeof r.abuse_reports === 'number') out.abuseReports = r.abuse_reports;
  if (r.list_name) out.audienceName = r.list_name;
  return out;
}

function requireCampaignId(input: z.infer<typeof InputSchema>): string {
  if (!input.campaignId)
    throw validationError(`'campaignId' is required for operation '${input.operation}'.`);
  return input.campaignId;
}

export const mailchimpReportsTool = tool('mailchimp_reports', {
  description:
    "Campaign reports — generic slicer. Use `operation: list` for the report index, `get` for a single campaign's headline metrics, and `slice` with a `dimension` enum to pull one specific breakdown (click-details, open-details, locations, unsubscribed, abuse-reports, advice, domain-performance, eepurl, email-activity, sent-to). For the common 'summarize this campaign' question, prefer the `mailchimp_campaign_report` workflow tool — it parallelizes the top 5 slices into one response.",
  annotations: { readOnlyHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    switch (input.operation) {
      case 'list': {
        const q: Parameters<typeof svc.reports.list>[1] = {
          count: input.count,
          offset: input.offset,
        };
        if (input.type) q.type = input.type as never;
        if (input.beforeSendTime) q.beforeSendTime = input.beforeSendTime;
        if (input.sinceSendTime) q.sinceSendTime = input.sinceSendTime;
        const { reports, total_items } = await svc.reports.list(ctx, q);
        return {
          operation: 'list',
          totalItems: total_items,
          reports: reports.map(summarize),
        };
      }

      case 'get': {
        const campaignId = requireCampaignId(input);
        const r = await svc.reports.get(ctx, campaignId);
        if (!r.send_time) {
          throw validationError(
            `Campaign '${campaignId}' has not been sent yet — no report data available. Send it with mailchimp_send_campaign, or inspect the draft with mailchimp_campaigns (operation: 'get').`,
            { campaignId },
          );
        }
        return { operation: 'get', campaignId: r.id, report: summarize(r) };
      }

      case 'slice': {
        if (!input.dimension)
          throw validationError("'dimension' is required for operation 'slice'.");
        const id = requireCampaignId(input);
        const pg = { count: input.count, offset: input.offset };
        switch (input.dimension) {
          case 'abuse-reports': {
            const { abuse_reports, total_items } = await svc.reports.abuseReports(ctx, id);
            return {
              operation: 'slice',
              dimension: 'abuse-reports',
              campaignId: id,
              totalItems: total_items,
              rows: normalizeRows(abuse_reports),
            };
          }
          case 'advice': {
            const { advice, total_items } = await svc.reports.advice(ctx, id);
            return {
              operation: 'slice',
              dimension: 'advice',
              campaignId: id,
              totalItems: total_items,
              rows: normalizeRows(advice),
            };
          }
          case 'click-details': {
            if (input.linkId) {
              const detail = await svc.reports.clickDetailsGet(ctx, id, input.linkId);
              return {
                operation: 'slice',
                dimension: 'click-details',
                campaignId: id,
                rows: [normalizeRow(detail)],
              };
            }
            const { urls_clicked, total_items } = await svc.reports.clickDetailsList(ctx, id, pg);
            return {
              operation: 'slice',
              dimension: 'click-details',
              campaignId: id,
              totalItems: total_items,
              rows: normalizeRows(urls_clicked),
            };
          }
          case 'open-details': {
            if (input.subscriberHash) {
              const detail = await svc.reports.openDetailsMember(ctx, id, input.subscriberHash);
              return {
                operation: 'slice',
                dimension: 'open-details',
                campaignId: id,
                rows: [normalizeRow(detail)],
              };
            }
            const odParams: Parameters<typeof svc.reports.openDetails>[2] = {
              count: input.count,
              offset: input.offset,
            };
            if (input.since) odParams.since = input.since;
            const { members, total_items } = await svc.reports.openDetails(ctx, id, odParams);
            return {
              operation: 'slice',
              dimension: 'open-details',
              campaignId: id,
              totalItems: total_items,
              rows: normalizeRows(members),
            };
          }
          case 'domain-performance': {
            const { domains, total_items } = await svc.reports.domainPerformance(ctx, id);
            return {
              operation: 'slice',
              dimension: 'domain-performance',
              campaignId: id,
              totalItems: total_items,
              rows: normalizeRows(domains),
            };
          }
          case 'eepurl': {
            const data = await svc.reports.eepurl(ctx, id);
            return {
              operation: 'slice',
              dimension: 'eepurl',
              campaignId: id,
              rows: [normalizeRow(data)],
            };
          }
          case 'email-activity': {
            const eaParams: Parameters<typeof svc.reports.emailActivity>[2] = {
              count: input.count,
              offset: input.offset,
            };
            if (input.since) eaParams.since = input.since;
            const { emails, total_items } = await svc.reports.emailActivity(ctx, id, eaParams);
            return {
              operation: 'slice',
              dimension: 'email-activity',
              campaignId: id,
              totalItems: total_items,
              rows: normalizeRows(emails),
            };
          }
          case 'locations': {
            const { locations, total_items } = await svc.reports.locations(ctx, id, pg);
            return {
              operation: 'slice',
              dimension: 'locations',
              campaignId: id,
              totalItems: total_items,
              rows: normalizeRows(locations),
            };
          }
          case 'sent-to': {
            const { sent_to, total_items } = await svc.reports.sentTo(ctx, id, pg);
            return {
              operation: 'slice',
              dimension: 'sent-to',
              campaignId: id,
              totalItems: total_items,
              rows: normalizeRows(sent_to),
            };
          }
          case 'unsubscribed': {
            const { unsubscribes, total_items } = await svc.reports.unsubscribed(ctx, id, pg);
            return {
              operation: 'slice',
              dimension: 'unsubscribed',
              campaignId: id,
              totalItems: total_items,
              rows: normalizeRows(unsubscribes),
            };
          }
        }
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`_Operation: ${result.operation}_`];
    if (result.dimension) lines.push(`_Dimension: ${result.dimension}_`);
    if (result.campaignId) lines.push(`_campaignId: ${result.campaignId}_`);
    lines.push('');

    const renderSummary = (r: z.infer<typeof ReportSummarySchema>, bullet: boolean): void => {
      const prefix = bullet ? '- ' : '';
      const indent = bullet ? '  ' : '';
      const title = r.campaignTitle ?? r.subjectLine ?? r.id;
      const subj =
        r.subjectLine && r.subjectLine !== title ? ` subjectLine: "${r.subjectLine}"` : '';
      const aud = r.audienceName ? ` audience:${r.audienceName}` : '';
      lines.push(`${prefix}**${title}** (\`${r.id}\`)${subj}${aud}`);
      const metrics: string[] = [];
      if (typeof r.emailsSent === 'number') metrics.push(`emailsSent ${r.emailsSent}`);
      if (typeof r.openRate === 'number')
        metrics.push(`openRate ${(r.openRate * 100).toFixed(2)}%`);
      if (typeof r.clickRate === 'number')
        metrics.push(`clickRate ${(r.clickRate * 100).toFixed(2)}%`);
      if (typeof r.unsubscribed === 'number') metrics.push(`unsubscribed ${r.unsubscribed}`);
      if (typeof r.abuseReports === 'number') metrics.push(`abuseReports ${r.abuseReports}`);
      if (metrics.length > 0) lines.push(`${indent}${metrics.join(' · ')}`);
      if (r.sendTime) lines.push(`${indent}sendTime ${r.sendTime}`);
    };

    if (result.reports) {
      lines.push(`# Reports (${result.reports.length} of ${result.totalItems ?? '?'})`, '');
      for (const r of result.reports) renderSummary(r, true);
    }

    if (result.report) {
      if (result.reports) lines.push('');
      const r = result.report;
      lines.push(`# ${r.campaignTitle ?? r.subjectLine ?? r.id}`, '');
      renderSummary(r, false);
    }

    if (result.rows) {
      lines.push(
        '',
        `# Rows (${result.rows.length}${result.totalItems ? ` of ${result.totalItems}` : ''})`,
        '',
      );
      const sample = result.rows.slice(0, 30);
      for (const row of sample) lines.push(`- ${JSON.stringify(row)}`);
      if (result.rows.length > sample.length)
        lines.push(`- …and ${result.rows.length - sample.length} more.`);
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
