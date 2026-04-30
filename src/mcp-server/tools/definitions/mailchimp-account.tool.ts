/**
 * @fileoverview `mailchimp_account` tool — read-only account info + activity feed.
 * Startup validation pings the API; `ping` is not exposed as an agent operation
 * since every successful tool call already proves the key is valid.
 * @module mcp-server/tools/definitions/mailchimp-account.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

const OperationSchema = z
  .enum(['info', 'activity-feed'])
  .describe(
    'Which read to perform. `info` returns the account profile, plan, and aggregated stats. `activity-feed` returns the Chimp Chatter event stream (recent subscribes, unsubscribes, campaign sends).',
  );

const InputSchema = z.object({
  operation: OperationSchema,
  count: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Rows to return for `activity-feed` (ignored for `info`). Max 100.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Offset for `activity-feed` pagination (ignored for `info`).'),
});

const IndustryStatsSchema = z
  .object({
    openRate: z.number().optional().describe('Industry average open rate (0–1).'),
    clickRate: z.number().optional().describe('Industry average click rate (0–1).'),
    bounceRate: z.number().optional().describe('Industry average bounce rate (0–1).'),
  })
  .describe('Industry-average benchmarks for the declared vertical.');

const ActivityFeedItemSchema = z
  .object({
    type: z.string().describe('Event type (e.g. `campaign_sent`, `list_subscribe`).'),
    updateTime: z.string().describe('ISO 8601 timestamp of the event.'),
    activity: z.string().describe('Human-readable description of the event.'),
    title: z.string().optional().describe('Subject or item title when applicable.'),
    url: z.string().optional().describe('Deep link into Mailchimp UI.'),
    campaignId: z.string().optional().describe('Campaign ID when the event is campaign-related.'),
    listId: z.string().optional().describe('Audience ID when the event is list-related.'),
  })
  .describe('One event from the account-level Chimp Chatter activity stream.');

/**
 * Flat output schema — fields populated depend on `operation`. `info`-only fields
 * sit alongside `activity-feed` fields so the schema remains a plain `ZodObject`
 * (required by the MCP SDK's JSON-Schema serialization).
 */
const OutputSchema = z.object({
  operation: OperationSchema,
  // info
  accountId: z.string().optional().describe('Mailchimp account ID. Populated for `info`.'),
  accountName: z.string().optional().describe('Account display name. Populated for `info`.'),
  email: z.string().optional().describe('Account owner email.'),
  username: z.string().optional().describe('Account username.'),
  dataCenter: z
    .string()
    .optional()
    .describe('Mailchimp data center (e.g. `us22`). Derived from the API key.'),
  role: z.string().optional().describe('User role on the account.'),
  pricingPlanType: z
    .string()
    .optional()
    .describe('Pricing plan: `monthly`, `pay_as_you_go`, `forever_free`, etc.'),
  memberSince: z.string().optional().describe('ISO 8601 date the account was created.'),
  lastLogin: z.string().optional().describe('ISO 8601 timestamp of last login.'),
  totalSubscribers: z.number().optional().describe('Total subscribers across all audiences.'),
  industry: z.string().optional().describe('Account-declared industry vertical.'),
  timezone: z.string().optional().describe('Account timezone.'),
  proEnabled: z.boolean().optional().describe('Whether the account has Mailchimp Pro features.'),
  industryStats: IndustryStatsSchema.optional(),
  // activity-feed
  items: z
    .array(ActivityFeedItemSchema)
    .optional()
    .describe('Recent account-level events, newest first. Populated for `activity-feed`.'),
  totalItems: z
    .number()
    .optional()
    .describe('Total events available on the server. Populated for `activity-feed`.'),
  offset: z
    .number()
    .optional()
    .describe('Offset used for this page. Populated for `activity-feed`.'),
  note: z
    .string()
    .optional()
    .describe(
      'Plain-language note populated when `activity-feed` returns no rows — explains the empty result without forcing the agent to infer cause.',
    ),
});

type Output = z.infer<typeof OutputSchema>;

export const mailchimpAccountTool = tool('mailchimp_account', {
  description:
    'Read-only view of the Mailchimp account. Use `operation: info` for profile, plan, data center, and total subscribers. Use `operation: activity-feed` for the Chimp Chatter stream (recent subscribes, unsubscribes, campaign sends across the whole account).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    if (input.operation === 'info') {
      const info = await svc.account.info(ctx);
      const result: Output = {
        operation: 'info',
        accountId: info.account_id,
        accountName: info.account_name,
        dataCenter: svc.dataCenter,
      };
      if (info.email) result.email = info.email;
      if (info.username) result.username = info.username;
      if (info.role) result.role = info.role;
      if (info.pricing_plan_type) result.pricingPlanType = info.pricing_plan_type;
      if (info.member_since) result.memberSince = info.member_since;
      if (info.last_login) result.lastLogin = info.last_login;
      if (typeof info.total_subscribers === 'number')
        result.totalSubscribers = info.total_subscribers;
      if (info.account_industry) result.industry = info.account_industry;
      if (info.account_timezone) result.timezone = info.account_timezone;
      if (typeof info.pro_enabled === 'boolean') result.proEnabled = info.pro_enabled;
      if (info.industry_stats) {
        const stats: z.infer<typeof IndustryStatsSchema> = {};
        if (typeof info.industry_stats.open_rate === 'number')
          stats.openRate = info.industry_stats.open_rate;
        if (typeof info.industry_stats.click_rate === 'number')
          stats.clickRate = info.industry_stats.click_rate;
        if (typeof info.industry_stats.bounce_rate === 'number')
          stats.bounceRate = info.industry_stats.bounce_rate;
        if (Object.keys(stats).length > 0) result.industryStats = stats;
      }
      ctx.log.info('mailchimp_account info', { accountId: info.account_id });
      return result;
    }

    const feed = await svc.account.activityFeed(ctx, { count: input.count, offset: input.offset });
    const items = (feed.activity ?? []).map((item) => {
      const mapped: z.infer<typeof ActivityFeedItemSchema> = {
        type: item.type,
        updateTime: item.update_time,
        activity: item.activity,
      };
      if (item.title) mapped.title = item.title;
      if (item.url) mapped.url = item.url;
      if (item.campaign_id) mapped.campaignId = item.campaign_id;
      if (item.list_id) mapped.listId = item.list_id;
      return mapped;
    });
    ctx.log.info('mailchimp_account activity-feed', { count: items.length });
    const out: Output = {
      operation: 'activity-feed',
      items,
      totalItems: feed.total_items ?? items.length,
      offset: input.offset,
    };
    if (items.length === 0 && (feed.total_items ?? 0) === 0) {
      out.note =
        'No Chimp Chatter events returned. Common causes: the account has no recent activity (no campaigns sent, no subscribes, no unsubscribes), or the chatter feed is still warming up on a brand-new account. Check mailchimp_audiences and mailchimp_campaigns for direct signal instead.';
    }
    return out;
  },

  format: (result) => {
    const lines: string[] = [];
    const hasInfo = result.operation === 'info' || result.accountId !== undefined;
    if (hasInfo) {
      lines.push(
        `# Account: ${result.accountName ?? '(unnamed)'}`,
        '',
        `**Operation:** ${result.operation}  `,
        `**ID:** ${result.accountId ?? '—'}  `,
        `**Data center:** ${result.dataCenter ?? '—'}  `,
      );
      if (result.email) lines.push(`**Email:** ${result.email}  `);
      if (result.username) lines.push(`**Username:** ${result.username}  `);
      if (result.role) lines.push(`**Role:** ${result.role}  `);
      if (result.pricingPlanType) lines.push(`**Plan:** ${result.pricingPlanType}  `);
      if (typeof result.proEnabled === 'boolean')
        lines.push(`**Pro enabled:** ${result.proEnabled}  `);
      if (typeof result.totalSubscribers === 'number')
        lines.push(`**Total subscribers:** ${result.totalSubscribers}  `);
      if (result.industry) lines.push(`**Industry:** ${result.industry}  `);
      if (result.timezone) lines.push(`**Timezone:** ${result.timezone}  `);
      if (result.memberSince) lines.push(`**Member since:** ${result.memberSince}  `);
      if (result.lastLogin) lines.push(`**Last login:** ${result.lastLogin}  `);
      if (result.industryStats) {
        lines.push('', '**Industry benchmarks**');
        if (typeof result.industryStats.openRate === 'number')
          lines.push(`- Open rate: ${(result.industryStats.openRate * 100).toFixed(2)}%`);
        if (typeof result.industryStats.clickRate === 'number')
          lines.push(`- Click rate: ${(result.industryStats.clickRate * 100).toFixed(2)}%`);
        if (typeof result.industryStats.bounceRate === 'number')
          lines.push(`- Bounce rate: ${(result.industryStats.bounceRate * 100).toFixed(2)}%`);
      }
    }

    if (result.items !== undefined) {
      const items = result.items;
      const total = result.totalItems ?? items.length;
      if (hasInfo) lines.push('');
      lines.push(`# Activity feed (${items.length} of ${total}, offset ${result.offset ?? 0})`, '');
      if (items.length === 0) {
        lines.push(`_${result.note ?? 'No activity in the requested window.'}_`);
      } else {
        for (const item of items) {
          lines.push(`**${item.updateTime}** — type: ${item.type}`);
          lines.push(`  ${item.activity}`);
          if (item.title) lines.push(`  _${item.title}_`);
          if (item.url) lines.push(`  <${item.url}>`);
          if (item.campaignId) lines.push(`  campaign: \`${item.campaignId}\``);
          if (item.listId) lines.push(`  list: \`${item.listId}\``);
          lines.push('');
        }
      }
    }
    if (result.note && (result.items === undefined || result.items.length > 0)) {
      lines.push('', `_${result.note}_`);
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
