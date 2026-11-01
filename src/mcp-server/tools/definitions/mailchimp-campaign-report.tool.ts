/**
 * @fileoverview `mailchimp_campaign_report` — parallelized post-send digest.
 * Combines headline stats + top clicked links + top locations + recent
 * unsubscribes into one structured output. Uses `Promise.all` under the
 * concurrency cap.
 * @module mcp-server/tools/definitions/mailchimp-campaign-report.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

const InputSchema = z.object({
  campaignId: z.string().describe('Campaign ID to summarize.'),
  includeTopN: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('How many rows to include per slice (top links, top locations, recent unsubs).'),
});

const OutputSchema = z.object({
  campaignId: z.string().describe('Campaign ID echoed back.'),
  campaignTitle: z.string().optional().describe('Internal campaign title.'),
  subjectLine: z.string().optional().describe('Subject line that was sent.'),
  type: z.string().optional().describe('Campaign type (`regular`, `plaintext`, `rss`).'),
  sendTime: z.string().optional().describe('When the campaign was sent (ISO 8601).'),
  audienceName: z.string().optional().describe('Audience the campaign was sent to.'),
  recipientsCount: z.number().optional().describe('Emails that Mailchimp attempted to deliver.'),
  delivery: z
    .object({
      delivered: z
        .number()
        .optional()
        .describe('Successfully delivered emails (recipientsCount minus all bounce categories).'),
      bounces: z
        .object({
          hard: z.number().optional().describe('Hard bounces (permanent delivery failures).'),
          soft: z.number().optional().describe('Soft bounces (temporary delivery failures).'),
          syntax: z.number().optional().describe('Syntax-error bounces (malformed addresses).'),
        })
        .describe('Per-category bounce counts.'),
      abuseReports: z
        .number()
        .optional()
        .describe('Count of subscribers who marked the email as spam.'),
    })
    .describe('Delivery-side metrics.'),
  engagement: z
    .object({
      opens: z
        .object({
          total: z
            .number()
            .optional()
            .describe('Total opens (includes repeats by the same subscriber).'),
          unique: z.number().optional().describe('Unique opens (one per subscriber).'),
          rate: z.number().optional().describe('Open rate (0–1).'),
          lastOpen: z.string().optional().describe('Most recent open timestamp.'),
        })
        .describe('Open metrics.'),
      clicks: z
        .object({
          total: z.number().optional().describe('Total clicks.'),
          unique: z.number().optional().describe('Unique clickers.'),
          rate: z.number().optional().describe('Click rate (0–1).'),
          lastClick: z.string().optional().describe('Most recent click timestamp.'),
        })
        .describe('Click metrics.'),
      unsubscribes: z
        .number()
        .optional()
        .describe('Count of subscribers who unsubscribed from this campaign.'),
    })
    .describe('Engagement metrics.'),
  topClickedLinks: z
    .array(
      z
        .object({
          url: z.string().describe('Clicked URL.'),
          totalClicks: z.number().describe('Total clicks (includes repeats).'),
          uniqueClicks: z.number().describe('Unique clickers.'),
          clickPercentage: z.number().optional().describe('Share of total clicks (0–1).'),
        })
        .describe('One clicked-link row.'),
    )
    .describe("Clicked links, the first `includeTopN` in Mailchimp's default order."),
  topLocations: z
    .array(
      z
        .object({
          countryCode: z.string().describe('Two-letter ISO country code.'),
          region: z.string().optional().describe('Region code (e.g. US state abbreviation).'),
          regionName: z.string().optional().describe('Full region name.'),
          opens: z.number().optional().describe('Opens from this location.'),
        })
        .describe('One per-location opens row.'),
    )
    .describe('Top subscriber locations by opens.'),
  recentUnsubscribes: z
    .array(
      z
        .object({
          email: z.string().describe('Unsubscribing email address.'),
          reason: z.string().optional().describe('Reason text the subscriber provided, if any.'),
          timestamp: z.string().optional().describe('ISO 8601 timestamp of the unsubscribe.'),
        })
        .describe('One recent unsubscribe event.'),
    )
    .describe('Most recent unsubscribes with the reason subscribers gave, if any.'),
  industryBenchmarks: z
    .object({
      type: z.string().optional().describe('Industry label Mailchimp used for the benchmark.'),
      openRate: z.number().optional().describe('Industry mean open rate (0–1).'),
      clickRate: z.number().optional().describe('Industry mean click rate (0–1).'),
      bounceRate: z.number().optional().describe('Industry mean bounce rate (0–1).'),
      unsubRate: z.number().optional().describe('Industry mean unsubscribe rate (0–1).'),
      abuseRate: z.number().optional().describe('Industry mean abuse rate (0–1).'),
    })
    .optional()
    .describe('Industry benchmarks Mailchimp reports alongside this campaign, when available.'),
});

type Output = z.infer<typeof OutputSchema>;

export const mailchimpCampaignReportTool = tool('mailchimp_campaign_report', {
  description:
    "Post-send analytics digest for a campaign. One call returns headline delivery metrics (sent/bounce/abuse), engagement (opens, clicks, unsubscribes), top clicked links, top locations, recent unsubscribes, and industry benchmarks when available. For individual dimensions in detail, use the `mailchimp_reports` primitive tool with `operation: 'slice'`.",
  annotations: { readOnlyHint: true },
  input: InputSchema,
  output: OutputSchema,
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
      when: 'Mailchimp returned 404 — campaign does not exist or has been deleted.',
      recovery: 'Run mailchimp_campaigns operation:list to discover valid campaignId values.',
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
        "Inspect the existing campaign via mailchimp_campaigns operation:'get', or send that campaign through Mailchimp before requesting its report.",
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const report = await svc.reports.get(ctx, input.campaignId);
    if (!report.send_time) {
      throw ctx.fail(
        'campaign_not_sent',
        `Campaign '${input.campaignId}' has not been sent yet — no report data available.`,
        {
          campaignId: input.campaignId,
        },
      );
    }
    const [clicks, locations, unsubs] = await Promise.all([
      svc.reports.clickDetailsList(ctx, input.campaignId, { count: input.includeTopN }),
      svc.reports.locations(ctx, input.campaignId, { count: input.includeTopN }),
      svc.reports.unsubscribed(ctx, input.campaignId, { count: input.includeTopN }),
    ]);

    const bounces = report.bounces;
    const delivered =
      typeof report.emails_sent === 'number' &&
      typeof bounces?.hard_bounces === 'number' &&
      typeof bounces.soft_bounces === 'number' &&
      typeof bounces.syntax_errors === 'number'
        ? report.emails_sent - (bounces.hard_bounces + bounces.soft_bounces + bounces.syntax_errors)
        : undefined;

    const result: Output = {
      campaignId: report.id,
      delivery: {
        bounces: {},
      },
      engagement: {
        opens: {},
        clicks: {},
      },
      topClickedLinks: clicks.urls_clicked.map((c) => {
        const row: Output['topClickedLinks'][number] = {
          url: c.url,
          totalClicks: c.total_clicks,
          uniqueClicks: c.unique_clicks,
        };
        if (typeof c.click_percentage === 'number') row.clickPercentage = c.click_percentage;
        return row;
      }),
      topLocations: locations.locations.map((l) => {
        const row: Output['topLocations'][number] = {
          countryCode: l.country_code,
        };
        if (typeof l.opens === 'number') row.opens = l.opens;
        if (l.region) row.region = l.region;
        if (l.region_name) row.regionName = l.region_name;
        return row;
      }),
      recentUnsubscribes: unsubs.unsubscribes.map((u) => {
        const row: Output['recentUnsubscribes'][number] = { email: u.email_address };
        if (u.reason) row.reason = u.reason;
        if (u.timestamp) row.timestamp = u.timestamp;
        return row;
      }),
    };

    if (typeof bounces?.hard_bounces === 'number')
      result.delivery.bounces.hard = bounces.hard_bounces;
    if (typeof bounces?.soft_bounces === 'number')
      result.delivery.bounces.soft = bounces.soft_bounces;
    if (typeof bounces?.syntax_errors === 'number')
      result.delivery.bounces.syntax = bounces.syntax_errors;
    if (typeof report.abuse_reports === 'number')
      result.delivery.abuseReports = report.abuse_reports;
    if (typeof report.opens?.opens_total === 'number')
      result.engagement.opens.total = report.opens.opens_total;
    if (typeof report.opens?.unique_opens === 'number')
      result.engagement.opens.unique = report.opens.unique_opens;
    if (typeof report.opens?.open_rate === 'number')
      result.engagement.opens.rate = report.opens.open_rate;
    if (typeof report.clicks?.clicks_total === 'number')
      result.engagement.clicks.total = report.clicks.clicks_total;
    if (typeof report.clicks?.unique_clicks === 'number')
      result.engagement.clicks.unique = report.clicks.unique_clicks;
    if (typeof report.clicks?.click_rate === 'number')
      result.engagement.clicks.rate = report.clicks.click_rate;
    if (typeof report.unsubscribed === 'number')
      result.engagement.unsubscribes = report.unsubscribed;
    if (delivered !== undefined) result.delivery.delivered = delivered;
    if (report.campaign_title) result.campaignTitle = report.campaign_title;
    if (report.subject_line) result.subjectLine = report.subject_line;
    if (report.type) result.type = report.type;
    if (report.send_time) result.sendTime = report.send_time;
    if (report.list_name) result.audienceName = report.list_name;
    if (typeof report.emails_sent === 'number') result.recipientsCount = report.emails_sent;
    if (report.opens?.last_open) result.engagement.opens.lastOpen = report.opens.last_open;
    if (report.clicks?.last_click) result.engagement.clicks.lastClick = report.clicks.last_click;
    if (report.industry_stats) {
      const ib: NonNullable<Output['industryBenchmarks']> = {};
      if (report.industry_stats.type) ib.type = report.industry_stats.type;
      if (typeof report.industry_stats.open_rate === 'number')
        ib.openRate = report.industry_stats.open_rate;
      if (typeof report.industry_stats.click_rate === 'number')
        ib.clickRate = report.industry_stats.click_rate;
      if (typeof report.industry_stats.bounce_rate === 'number')
        ib.bounceRate = report.industry_stats.bounce_rate;
      if (typeof report.industry_stats.unsub_rate === 'number')
        ib.unsubRate = report.industry_stats.unsub_rate;
      if (typeof report.industry_stats.abuse_rate === 'number')
        ib.abuseRate = report.industry_stats.abuse_rate;
      if (Object.keys(ib).length > 0) result.industryBenchmarks = ib;
    }

    ctx.log.info('campaign_report built', {
      campaignId: report.id,
      openRate: result.engagement.opens.rate,
      clickRate: result.engagement.clicks.rate,
    });

    return result;
  },

  format: (result) => {
    const pct = (v: number | undefined) =>
      typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : 'unavailable';
    const lines: string[] = [
      `# ${result.campaignTitle ?? result.subjectLine ?? result.campaignId}`,
      '',
      `**ID:** ${result.campaignId}  `,
    ];
    if (result.subjectLine) lines.push(`**Subject:** "${result.subjectLine}"  `);
    if (result.type) lines.push(`**Type:** ${result.type}  `);
    if (result.sendTime) lines.push(`**Sent:** ${result.sendTime}  `);
    if (result.audienceName) lines.push(`**Audience:** ${result.audienceName}  `);
    if (typeof result.recipientsCount === 'number')
      lines.push(`**Emails sent:** ${result.recipientsCount}  `);

    lines.push('', '## Delivery');
    lines.push('| Metric | Value |');
    lines.push('|:-------|------:|');
    if (typeof result.delivery.delivered === 'number')
      lines.push(`| Delivered | ${result.delivery.delivered} |`);
    lines.push(`| Hard bounces | ${result.delivery.bounces.hard ?? 'unavailable'} |`);
    lines.push(`| Soft bounces | ${result.delivery.bounces.soft ?? 'unavailable'} |`);
    lines.push(`| Syntax errors | ${result.delivery.bounces.syntax ?? 'unavailable'} |`);
    lines.push(`| Abuse reports | ${result.delivery.abuseReports ?? 'unavailable'} |`);

    lines.push('', '## Engagement');
    lines.push('| Metric | Total | Unique | Rate |');
    lines.push('|:-------|------:|-------:|-----:|');
    lines.push(
      `| Opens | ${result.engagement.opens.total ?? 'unavailable'} | ${result.engagement.opens.unique ?? 'unavailable'} | ${pct(result.engagement.opens.rate)} |`,
    );
    lines.push(
      `| Clicks | ${result.engagement.clicks.total ?? 'unavailable'} | ${result.engagement.clicks.unique ?? 'unavailable'} | ${pct(result.engagement.clicks.rate)} |`,
    );
    lines.push(`| Unsubscribes | ${result.engagement.unsubscribes ?? 'unavailable'} | — | — |`);
    if (result.engagement.opens.lastOpen)
      lines.push(`_Last open: ${result.engagement.opens.lastOpen}_`);
    if (result.engagement.clicks.lastClick)
      lines.push(`_Last click: ${result.engagement.clicks.lastClick}_`);

    if (result.industryBenchmarks) {
      const ib = result.industryBenchmarks;
      lines.push('', '## Industry benchmarks');
      if (ib.type) lines.push(`_${ib.type}_`);
      if (typeof ib.openRate === 'number')
        lines.push(`- Open rate: ${pct(ib.openRate)} (industry avg)`);
      if (typeof ib.clickRate === 'number')
        lines.push(`- Click rate: ${pct(ib.clickRate)} (industry avg)`);
      if (typeof ib.bounceRate === 'number')
        lines.push(`- Bounce rate: ${pct(ib.bounceRate)} (industry avg)`);
      if (typeof ib.unsubRate === 'number')
        lines.push(`- Unsub rate: ${pct(ib.unsubRate)} (industry avg)`);
      if (typeof ib.abuseRate === 'number')
        lines.push(`- Abuse rate: ${pct(ib.abuseRate)} (industry avg)`);
    }

    if (result.topClickedLinks.length > 0) {
      lines.push('', `## Top clicked links (${result.topClickedLinks.length})`, '');
      for (const link of result.topClickedLinks) {
        const pctSuffix =
          typeof link.clickPercentage === 'number'
            ? ` [${pct(link.clickPercentage)} of clicks]`
            : '';
        lines.push(
          `- ${link.totalClicks} clicks (${link.uniqueClicks} unique)${pctSuffix} — ${link.url}`,
        );
      }
    }

    if (result.topLocations.length > 0) {
      lines.push('', `## Top locations by opens`, '');
      for (const loc of result.topLocations) {
        const regionParts = [loc.regionName, loc.region].filter(Boolean);
        const regionSuffix = regionParts.length > 0 ? ` (${regionParts.join(' / ')})` : '';
        lines.push(
          `- ${loc.countryCode}${regionSuffix}: ${typeof loc.opens === 'number' ? `${loc.opens} opens` : 'opens unavailable'}`,
        );
      }
    }

    if (result.recentUnsubscribes.length > 0) {
      lines.push('', `## Recent unsubscribes (${result.recentUnsubscribes.length})`, '');
      for (const u of result.recentUnsubscribes) {
        lines.push(
          `- \`${u.email}\`${u.timestamp ? ` at ${u.timestamp}` : ''}${u.reason ? ` — ${u.reason}` : ''}`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
