/**
 * @fileoverview `mailchimp_campaign_report` — parallelized post-send digest.
 * Combines headline stats + top clicked links + top locations + recent
 * unsubscribes into one structured output. Uses `Promise.all` under the
 * concurrency cap.
 * @module mcp-server/tools/definitions/mailchimp-campaign-report.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
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
      delivered: z.number().optional().describe('emails_sent - hard - soft - syntax bounces.'),
      bounces: z
        .object({
          hard: z.number().describe('Hard bounces (permanent delivery failures).'),
          soft: z.number().describe('Soft bounces (temporary delivery failures).'),
          syntax: z.number().describe('Syntax-error bounces (malformed addresses).'),
        })
        .describe('Per-category bounce counts.'),
      abuseReports: z.number().describe('Count of subscribers who marked the email as spam.'),
    })
    .describe('Delivery-side metrics.'),
  engagement: z
    .object({
      opens: z
        .object({
          total: z.number().describe('Total opens (includes repeats by the same subscriber).'),
          unique: z.number().describe('Unique opens (one per subscriber).'),
          rate: z.number().describe('Open rate (0–1).'),
          lastOpen: z.string().optional().describe('Most recent open timestamp.'),
        })
        .describe('Open metrics.'),
      clicks: z
        .object({
          total: z.number().describe('Total clicks.'),
          unique: z.number().describe('Unique clickers.'),
          rate: z.number().describe('Click rate (0–1).'),
          lastClick: z.string().optional().describe('Most recent click timestamp.'),
        })
        .describe('Click metrics.'),
      unsubscribes: z
        .number()
        .describe('Count of subscribers who unsubscribed from this campaign.'),
    })
    .describe('Engagement metrics.'),
  topClickedLinks: z
    .array(
      z.object({
        url: z.string(),
        totalClicks: z.number(),
        uniqueClicks: z.number(),
        clickPercentage: z.number().optional(),
      }),
    )
    .describe('Top clicked links, sorted by total clicks.'),
  topLocations: z
    .array(
      z.object({
        countryCode: z.string(),
        region: z.string().optional(),
        regionName: z.string().optional(),
        opens: z.number(),
      }),
    )
    .describe('Top subscriber locations by opens.'),
  recentUnsubscribes: z
    .array(
      z.object({
        email: z.string(),
        reason: z.string().optional(),
        timestamp: z.string().optional(),
      }),
    )
    .describe('Most recent unsubscribes with the reason subscribers gave, if any.'),
  industryBenchmarks: z
    .object({
      type: z.string().optional(),
      openRate: z.number().optional(),
      clickRate: z.number().optional(),
      bounceRate: z.number().optional(),
      unsubRate: z.number().optional(),
      abuseRate: z.number().optional(),
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

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const report = await svc.reports.get(ctx, input.campaignId);
    if (!report.send_time) {
      throw validationError(
        `Campaign '${input.campaignId}' has not been sent yet — no report data available. Send it with mailchimp_send_campaign, or inspect the draft with mailchimp_campaigns (operation: 'get').`,
        { campaignId: input.campaignId, status: report.type ?? 'unsent' },
      );
    }
    const [clicks, locations, unsubs] = await Promise.all([
      svc.reports
        .clickDetailsList(ctx, input.campaignId, { count: input.includeTopN })
        .catch(() => ({ urls_clicked: [], total_items: 0 })),
      svc.reports
        .locations(ctx, input.campaignId, { count: input.includeTopN })
        .catch(() => ({ locations: [], total_items: 0 })),
      svc.reports
        .unsubscribed(ctx, input.campaignId, { count: input.includeTopN })
        .catch(() => ({ unsubscribes: [], total_items: 0 })),
    ]);

    const bounces = report.bounces ?? { hard_bounces: 0, soft_bounces: 0, syntax_errors: 0 };
    const delivered =
      typeof report.emails_sent === 'number'
        ? report.emails_sent - (bounces.hard_bounces + bounces.soft_bounces + bounces.syntax_errors)
        : undefined;

    const result: Output = {
      campaignId: report.id,
      delivery: {
        bounces: {
          hard: bounces.hard_bounces,
          soft: bounces.soft_bounces,
          syntax: bounces.syntax_errors,
        },
        abuseReports: report.abuse_reports ?? 0,
      },
      engagement: {
        opens: {
          total: report.opens?.opens_total ?? 0,
          unique: report.opens?.unique_opens ?? 0,
          rate: report.opens?.open_rate ?? 0,
        },
        clicks: {
          total: report.clicks?.clicks_total ?? 0,
          unique: report.clicks?.unique_clicks ?? 0,
          rate: report.clicks?.click_rate ?? 0,
        },
        unsubscribes: report.unsubscribed ?? 0,
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
          opens: l.opens ?? 0,
        };
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
    const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
    const lines: string[] = [
      `# ${result.campaignTitle ?? result.subjectLine ?? result.campaignId}`,
      '',
      `**ID:** ${result.campaignId}  `,
    ];
    if (result.subjectLine) lines.push(`**Subject:** "${result.subjectLine}"  `);
    if (result.sendTime) lines.push(`**Sent:** ${result.sendTime}  `);
    if (result.audienceName) lines.push(`**Audience:** ${result.audienceName}  `);
    if (typeof result.recipientsCount === 'number')
      lines.push(`**Emails sent:** ${result.recipientsCount}  `);

    lines.push('', '## Delivery');
    lines.push('| Metric | Value |');
    lines.push('|:-------|------:|');
    if (typeof result.delivery.delivered === 'number')
      lines.push(`| Delivered | ${result.delivery.delivered} |`);
    lines.push(`| Hard bounces | ${result.delivery.bounces.hard} |`);
    lines.push(`| Soft bounces | ${result.delivery.bounces.soft} |`);
    lines.push(`| Syntax errors | ${result.delivery.bounces.syntax} |`);
    lines.push(`| Abuse reports | ${result.delivery.abuseReports} |`);

    lines.push('', '## Engagement');
    lines.push('| Metric | Total | Unique | Rate |');
    lines.push('|:-------|------:|-------:|-----:|');
    lines.push(
      `| Opens | ${result.engagement.opens.total} | ${result.engagement.opens.unique} | ${pct(result.engagement.opens.rate)} |`,
    );
    lines.push(
      `| Clicks | ${result.engagement.clicks.total} | ${result.engagement.clicks.unique} | ${pct(result.engagement.clicks.rate)} |`,
    );
    lines.push(`| Unsubscribes | ${result.engagement.unsubscribes} | — | — |`);
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
    }

    if (result.topClickedLinks.length > 0) {
      lines.push('', `## Top clicked links (${result.topClickedLinks.length})`, '');
      for (const link of result.topClickedLinks) {
        lines.push(`- ${link.totalClicks} clicks (${link.uniqueClicks} unique) — ${link.url}`);
      }
    }

    if (result.topLocations.length > 0) {
      lines.push('', `## Top locations by opens`, '');
      for (const loc of result.topLocations) {
        const region = loc.regionName ?? loc.region ?? '';
        lines.push(`- ${loc.countryCode}${region ? ` (${region})` : ''}: ${loc.opens} opens`);
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
