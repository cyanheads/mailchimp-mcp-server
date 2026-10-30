/**
 * @fileoverview `mailchimp_reports` — generic campaign-report slicer.
 * For the common "how did campaign X do?" question use the
 * `mailchimp_campaign_report` workflow tool instead — this tool is for
 * the 10+ individual report dimensions Mailchimp exposes.
 * @module mcp-server/tools/definitions/mailchimp-reports.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  type AppliedFilters,
  listEnrichment,
  listEnrichmentTrailer,
  pageEndNotice,
} from '@/mcp-server/tools/shared/list-enrichment.js';
import { renderRowTable } from '@/mcp-server/tools/shared/row-table.js';
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
  .describe(
    "Report slice dimension. Required when `operation = slice`. Variants: `abuse-reports` — subscribers who marked the campaign as spam · `advice` — Mailchimp's automated tips for the campaign · `click-details` — per-URL click counts; with `linkId`, the members who clicked that one URL · `open-details` — per-member open events (drill into one with `subscriberHash`) · `domain-performance` — aggregate stats grouped by recipient email domain · `eepurl` — Mailchimp's shortened-URL stats for this campaign · `email-activity` — per-recipient open/click/bounce timeline · `locations` — opens grouped by country/region · `sent-to` — per-recipient delivery state · `unsubscribed` — members who unsubscribed from this send.",
  );

type Dimension = z.infer<typeof DimensionSchema>;

const InputSchema = z.object({
  operation: OperationSchema,
  campaignId: z.string().optional().describe('Campaign ID. Required for `get` and `slice`.'),
  dimension: DimensionSchema.optional(),
  linkId: z
    .string()
    .optional()
    .describe(
      'Link ID (the `id` of a `click-details` row) — switches `click-details` to the members who clicked that URL, paged by `count`/`offset`.',
    ),
  subscriberHash: z
    .string()
    .optional()
    .describe('Subscriber hash for open-details drill-down (per-member open history).'),
  since: z
    .string()
    .optional()
    .describe('ISO 8601 lower bound for `email-activity` / `open-details`.'),
  type: z
    .string()
    .optional()
    .describe('Campaign type filter for `list` (`regular`, `plaintext`, `rss`).'),
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
    .describe(
      'Page size for list-style reads. Max 1000. Not sent for `abuse-reports`, `advice`, `domain-performance`, `eepurl`, or a `subscriberHash` drill-down, which return everything upstream has.',
    ),
  offset: z.coerce.number().int().min(0).default(0).describe('Offset for list-style pagination.'),
});

type Input = z.infer<typeof InputSchema>;

const ReportSummarySchema = z
  .object({
    id: z.string().describe('Campaign ID the report is for.'),
    campaignTitle: z.string().optional().describe('Internal campaign title.'),
    subjectLine: z.string().optional().describe('Subject line as sent to recipients.'),
    sendTime: z.string().optional().describe('ISO 8601 send timestamp.'),
    emailsSent: z.number().optional().describe('Emails actually delivered.'),
    openRate: z.number().optional().describe('Mean open rate (0–1).'),
    clickRate: z.number().optional().describe('Mean click rate (0–1).'),
    unsubscribed: z.number().optional().describe('Unsubscribes attributable to this campaign.'),
    abuseReports: z.number().optional().describe('Abuse reports filed against this campaign.'),
    audienceName: z.string().optional().describe('Human-readable audience (list) name.'),
  })
  .describe('Headline summary of one campaign report.');

const OutputSchema = z.object({
  operation: OperationSchema,
  dimension: DimensionSchema.optional(),
  campaignId: z.string().optional().describe('Echoed campaign ID for `get` and `slice`.'),
  linkId: z
    .string()
    .optional()
    .describe('Echoed link ID when `click-details` lists the members who clicked one URL.'),
  report: ReportSummarySchema.optional().describe('Populated for `get`.'),
  reports: z.array(ReportSummarySchema).optional().describe('Populated for `list`.'),
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Per-row data for the requested dimension; row shape varies by `dimension`. With `linkId`, one row per member who clicked the URL (`emailAddress`, `clicks`, `contactStatus`, …).',
    ),
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

function requireCampaignId(input: Input): string {
  if (!input.campaignId)
    throw validationError(`'campaignId' is required for operation '${input.operation}'.`);
  return input.campaignId;
}

/** One dimension's rows plus the query parameters the read sent upstream, if any. */
interface Slice {
  filters?: AppliedFilters;
  rows: Row[];
  totalItems?: number;
}

async function readSlice(
  ctx: Pick<Context, 'signal' | 'log'>,
  input: Input,
  id: string,
  dimension: Dimension,
): Promise<Slice> {
  const svc = getMailchimpService();
  const page = { count: input.count, offset: input.offset };
  const pageSince: { count: number; offset: number; since?: string } = input.since
    ? { ...page, since: input.since }
    : page;

  switch (dimension) {
    case 'abuse-reports': {
      const { abuse_reports, total_items } = await svc.reports.abuseReports(ctx, id);
      return { rows: normalizeRows(abuse_reports), totalItems: total_items };
    }
    case 'advice': {
      const { advice, total_items } = await svc.reports.advice(ctx, id);
      return { rows: normalizeRows(advice), totalItems: total_items };
    }
    case 'click-details': {
      if (input.linkId) {
        const { members, total_items } = await svc.reports.clickDetailsMembers(
          ctx,
          id,
          input.linkId,
          page,
        );
        return { rows: normalizeRows(members), totalItems: total_items, filters: page };
      }
      const { urls_clicked, total_items } = await svc.reports.clickDetailsList(ctx, id, page);
      return { rows: normalizeRows(urls_clicked), totalItems: total_items, filters: page };
    }
    case 'open-details': {
      if (input.subscriberHash) {
        const detail = await svc.reports.openDetailsMember(ctx, id, input.subscriberHash);
        return { rows: [normalizeRow(detail)] };
      }
      const { members, total_items } = await svc.reports.openDetails(ctx, id, pageSince);
      return { rows: normalizeRows(members), totalItems: total_items, filters: pageSince };
    }
    case 'domain-performance': {
      const { domains, total_items } = await svc.reports.domainPerformance(ctx, id);
      return { rows: normalizeRows(domains), totalItems: total_items };
    }
    case 'eepurl':
      return { rows: [normalizeRow(await svc.reports.eepurl(ctx, id))] };
    case 'email-activity': {
      const { emails, total_items } = await svc.reports.emailActivity(ctx, id, pageSince);
      return { rows: normalizeRows(emails), totalItems: total_items, filters: pageSince };
    }
    case 'locations': {
      const { locations, total_items } = await svc.reports.locations(ctx, id, page);
      return { rows: normalizeRows(locations), totalItems: total_items, filters: page };
    }
    case 'sent-to': {
      const { sent_to, total_items } = await svc.reports.sentTo(ctx, id, page);
      return { rows: normalizeRows(sent_to), totalItems: total_items, filters: page };
    }
    case 'unsubscribed': {
      const { unsubscribes, total_items } = await svc.reports.unsubscribed(ctx, id, page);
      return { rows: normalizeRows(unsubscribes), totalItems: total_items, filters: page };
    }
  }
}

/** Why a dimension can legitimately come back empty, and where to look next. */
const EMPTY_SLICE: Record<Dimension, string> = {
  'abuse-reports': 'No recipient marked this campaign as spam.',
  advice: 'Mailchimp has no advice for this campaign.',
  'click-details':
    'No tracked link in this campaign was clicked; `operation: get` shows its headline click rate.',
  'open-details':
    'No opens were recorded for this campaign; `operation: get` shows its headline open rate.',
  'domain-performance': 'Mailchimp reports no per-domain stats for this campaign.',
  eepurl: 'Mailchimp reports no shortened-URL stats for this campaign.',
  'email-activity': 'No recipient activity was recorded for this campaign.',
  locations: 'No opens with a known location were recorded for this campaign.',
  'sent-to':
    'No recipients are recorded for this campaign; confirm it was sent with `operation: get`.',
  unsubscribed: 'No recipient unsubscribed from this campaign.',
};

/** Next step for an empty page. Names filter keys only; their values ride in `filters`. */
function emptyNotice(
  input: Input,
  filters: AppliedFilters | undefined,
  totalItems: number | undefined,
): string {
  // Only paged reads send `offset`; an unpaged read returns everything upstream has.
  const offset = typeof filters?.offset === 'number' ? filters.offset : 0;
  return pageEndNotice(
    input.operation === 'list' ? 'campaign reports' : 'rows',
    offset,
    totalItems,
    noRowsText(input, filters),
  );
}

/** Why the read matched nothing, naming the filter keys that narrowed it. */
function noRowsText(input: Input, filters: AppliedFilters | undefined): string {
  if (input.operation === 'list') {
    const narrowing = (['type', 'beforeSendTime', 'sinceSendTime'] as const).filter(
      (key) => filters?.[key] !== undefined,
    );
    return narrowing.length > 0
      ? `No campaign reports match ${narrowing.map((key) => `\`${key}\``).join(', ')}; widen or drop ${narrowing.length > 1 ? 'those filters' : 'that filter'}.`
      : 'No campaign reports exist yet; only sent campaigns have reports.';
  }

  if (input.dimension === 'click-details' && input.linkId)
    return 'No member clicked this link; run `click-details` without `linkId` to compare per-URL counts.';
  if (filters?.since !== undefined)
    return 'Nothing was recorded after `since`; move `since` earlier or drop it.';
  return input.dimension ? EMPTY_SLICE[input.dimension] : 'No rows returned.';
}

/** Leading columns per dimension; any other key a row carries follows them. */
const LEADING_COLUMNS: Partial<Record<Dimension, readonly string[]>> = {
  'click-details': [
    'url',
    'totalClicks',
    'uniqueClicks',
    'clickPercentage',
    'uniqueClickPercentage',
    'lastClick',
  ],
  'open-details': ['emailAddress', 'opensCount', 'opens'],
  locations: ['countryCode', 'region', 'regionName', 'opens'],
  unsubscribed: ['emailAddress', 'timestamp', 'reason'],
  'abuse-reports': ['emailAddress', 'date'],
  'sent-to': ['emailAddress', 'status', 'openCount', 'lastOpen'],
};

/** Leading columns for the members who clicked one link (`click-details` + `linkId`). */
const LINK_CLICKER_COLUMNS = ['emailAddress', 'clicks', 'contactStatus', 'vip'] as const;

/** Inline Markdown for one value: strings escaped, nested values as their JSON. */
function inlineValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return escapeMarkdownInline(value);
  if (value === null || typeof value !== 'object') return String(value);
  return escapeMarkdownInline(JSON.stringify(value));
}

/** One bullet per key: `- **key:** value`. */
const keyValueLines = (row: Row): string[] =>
  Object.entries(row).map(
    ([key, value]) => `- **${escapeMarkdownInline(key)}:** ${inlineValue(value)}`,
  );

function renderRows(rows: Row[], dimension: Dimension | undefined, linkId: string | undefined) {
  if (rows.length === 0) return [];
  if (dimension === 'eepurl') return rows.flatMap(keyValueLines);
  if (dimension === 'advice') {
    return rows.map((row) => {
      const { type, message, ...rest } = row;
      const head = [type, message]
        .filter((v) => v !== undefined)
        .map(inlineValue)
        .join(': ');
      const tail = Object.entries(rest).map(
        ([key, value]) => ` · ${escapeMarkdownInline(key)}: ${inlineValue(value)}`,
      );
      return `- ${head}${tail.join('')}`;
    });
  }
  const leading =
    dimension === 'click-details' && linkId
      ? LINK_CLICKER_COLUMNS
      : (dimension && LEADING_COLUMNS[dimension]) || [];
  return renderRowTable(rows, leading);
}

export const mailchimpReportsTool = tool('mailchimp_reports', {
  description:
    "Campaign reports — generic slicer. Use `operation: list` for the report index, `get` for a single campaign's headline metrics, and `slice` with a `dimension` enum to pull one specific breakdown (click-details, open-details, locations, unsubscribed, abuse-reports, advice, domain-performance, eepurl, email-activity, sent-to). For the common 'summarize this campaign' question, prefer the `mailchimp_campaign_report` workflow tool — it parallelizes the top 5 slices into one response.",
  annotations: { readOnlyHint: true },
  input: InputSchema,
  output: OutputSchema,
  enrichment: listEnrichment,
  enrichmentTrailer: listEnrichmentTrailer,
  errors: [
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
        'Inspect data.requiresPlan when present; otherwise the API key lacks scope for campaign reports.',
    },
    {
      reason: 'mailchimp_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — campaign or report dimension does not exist.',
      recovery:
        'Run mailchimp_reports operation:list to discover valid campaignId values; verify dimension/linkId/subscriberHash inputs.',
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
    {
      reason: 'campaign_not_sent',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Campaign exists but has not been sent yet — no report data available.',
      recovery:
        "Send the campaign with mailchimp_send_campaign, or inspect the draft via mailchimp_campaigns operation:'get'.",
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    switch (input.operation) {
      case 'list': {
        const q: Parameters<typeof svc.reports.list>[1] & AppliedFilters = {
          count: input.count,
          offset: input.offset,
        };
        if (input.type) q.type = input.type as never;
        if (input.beforeSendTime) q.beforeSendTime = input.beforeSendTime;
        if (input.sinceSendTime) q.sinceSendTime = input.sinceSendTime;
        const { reports, total_items } = await svc.reports.list(ctx, q);
        ctx.enrich({ filters: q });
        if (reports.length === 0) ctx.enrich.notice(emptyNotice(input, q, total_items));
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
          throw ctx.fail(
            'campaign_not_sent',
            `Campaign '${campaignId}' has not been sent yet — no report data available.`,
            { campaignId },
          );
        }
        return { operation: 'get', campaignId: r.id, report: summarize(r) };
      }

      case 'slice': {
        if (!input.dimension)
          throw validationError("'dimension' is required for operation 'slice'.");
        const id = requireCampaignId(input);
        const slice = await readSlice(ctx, input, id, input.dimension);
        if (slice.filters) ctx.enrich({ filters: slice.filters });
        if (slice.rows.length === 0)
          ctx.enrich.notice(emptyNotice(input, slice.filters, slice.totalItems));
        const result: Output = {
          operation: 'slice',
          dimension: input.dimension,
          campaignId: id,
          rows: slice.rows,
        };
        if (slice.totalItems !== undefined) result.totalItems = slice.totalItems;
        if (input.dimension === 'click-details' && input.linkId) result.linkId = input.linkId;
        return result;
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`Operation: ${result.operation}`];
    if (result.dimension) lines.push(`Dimension: ${result.dimension}`);
    if (result.campaignId) lines.push(`_campaignId: ${escapeMarkdownInline(result.campaignId)}_`);
    if (result.linkId) lines.push(`_linkId: ${escapeMarkdownInline(result.linkId)}_`);
    lines.push('');

    const renderSummary = (r: z.infer<typeof ReportSummarySchema>, bullet: boolean): void => {
      const prefix = bullet ? '- ' : '';
      const indent = bullet ? '  ' : '';
      const title = r.campaignTitle ?? r.subjectLine ?? r.id;
      const subj =
        r.subjectLine && r.subjectLine !== title
          ? ` subjectLine: "${escapeMarkdownInline(r.subjectLine)}"`
          : '';
      const aud = r.audienceName ? ` audience:${escapeMarkdownInline(r.audienceName)}` : '';
      lines.push(`${prefix}**${escapeMarkdownInline(title)}** (\`${r.id}\`)${subj}${aud}`);
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
      lines.push(`# ${escapeMarkdownInline(r.campaignTitle ?? r.subjectLine ?? r.id)}`, '');
      renderSummary(r, false);
    }

    if (result.rows) {
      const total = result.totalItems !== undefined ? ` of ${result.totalItems}` : '';
      if (lines.at(-1) !== '') lines.push('');
      lines.push(`# Rows (${result.rows.length}${total})`, '');
      lines.push(...renderRows(result.rows, result.dimension, result.linkId));
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
