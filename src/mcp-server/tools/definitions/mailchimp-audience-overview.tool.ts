/**
 * @fileoverview `mailchimp_audience_overview` workflow tool — one-call health
 * digest merging audience info, 12-month growth, email-client mix, and
 * merge-field schema. Parallelizes under `MAILCHIMP_CONCURRENCY_LIMIT`.
 * @module mcp-server/tools/definitions/mailchimp-audience-overview.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

const InputSchema = z.object({
  audienceId: z.string().describe('Audience (list) ID to summarize.'),
  growthMonths: z
    .number()
    .int()
    .min(1)
    .max(36)
    .default(12)
    .describe('Months of growth history to include. Mailchimp caps at ~36.'),
});

const OutputSchema = z.object({
  audienceId: z.string().describe('Audience ID echoed back.'),
  name: z.string().describe('Audience display name.'),
  dateCreated: z.string().optional().describe('When the audience was created.'),
  visibility: z
    .enum(['pub', 'prv'])
    .optional()
    .describe('`pub` = publicly searchable, `prv` = private.'),
  doubleOptin: z
    .boolean()
    .optional()
    .describe('Whether this audience requires double opt-in confirmation for new subscribers.'),
  listRating: z.number().optional().describe('Mailchimp list rating 0-5.'),
  stats: z
    .object({
      memberCount: z.number().optional().describe('Active subscribed members.'),
      unsubscribeCount: z.number().optional().describe('Total members who have unsubscribed.'),
      cleanedCount: z.number().optional().describe('Bounced/invalid emails cleaned from the list.'),
      campaignCount: z.number().optional().describe('Campaigns ever sent to this audience.'),
      campaignLastSent: z.string().optional().describe('ISO 8601 timestamp of the last send.'),
      openRate: z.number().optional().describe('Mean open rate across campaigns (0–1).'),
      clickRate: z.number().optional().describe('Mean click rate across campaigns (0–1).'),
      avgSubRate: z.number().optional().describe('Mean monthly subscribes.'),
      avgUnsubRate: z.number().optional().describe('Mean monthly unsubscribes.'),
      lastSubDate: z.string().optional().describe('ISO 8601 of the most recent subscribe.'),
      lastUnsubDate: z.string().optional().describe('ISO 8601 of the most recent unsubscribe.'),
    })
    .optional()
    .describe('Audience-level aggregated stats.'),
  contact: z
    .object({
      company: z.string().optional().describe('Company or organization name.'),
      address1: z.string().optional().describe('Street address line 1.'),
      city: z.string().optional().describe('City.'),
      state: z.string().optional().describe('State / province / region.'),
      zip: z.string().optional().describe('Postal code.'),
      country: z.string().optional().describe('Two-letter ISO country code.'),
    })
    .optional()
    .describe('Physical contact info required by CAN-SPAM (appears in the email footer).'),
  campaignDefaults: z
    .object({
      fromName: z.string().optional().describe('Default "From" display name.'),
      fromEmail: z.string().optional().describe('Default "From" email address.'),
      subject: z.string().optional().describe('Default subject line.'),
      language: z.string().optional().describe('Default language code (e.g. `en`).'),
    })
    .optional()
    .describe('Default From/subject/language settings for new campaigns on this audience.'),
  growth: z
    .array(
      z
        .object({
          month: z.string().describe('Year-month (`YYYY-MM`) for this bucket.'),
          subscribed: z.number().optional().describe('New subscribers in the month.'),
          unsubscribed: z.number().optional().describe('Unsubscribes in the month.'),
          existing: z.number().optional().describe('Existing members carried in.'),
          cleaned: z.number().optional().describe('Members cleaned (bounced) in the month.'),
        })
        .describe('One month of growth history.'),
    )
    .describe('Monthly growth history, most recent first.'),
  emailClients: z
    .array(
      z
        .object({
          client: z.string().describe('Email client name (e.g. `Apple Mail`, `Gmail`).'),
          members: z.number().describe('Members using this client.'),
        })
        .describe('One email-client usage row.'),
    )
    .describe('Top email clients used by subscribers.'),
  mergeFields: z
    .array(
      z
        .object({
          tag: z.string().describe('Merge-field tag (e.g. `FNAME`, `EMAIL`).'),
          name: z.string().describe('Human-readable name.'),
          type: z.string().describe('Field type (`text`, `number`, `date`, `address`, etc.).'),
          required: z.boolean().optional().describe('Whether this field is required at signup.'),
        })
        .describe('One merge-field definition.'),
    )
    .describe('Custom subscriber attributes defined on this audience.'),
  subscribeUrl: z.string().optional().describe('Long-form subscribe URL for sharing.'),
  notes: z
    .array(z.string())
    .optional()
    .describe(
      'Plain-language notes explaining empty arrays — distinguishes "no data yet" (new audience, no sends, free-tier limits) from "zero engagement" (real but bad signal).',
    ),
});

type Output = z.infer<typeof OutputSchema>;

export const mailchimpAudienceOverviewTool = tool('mailchimp_audience_overview', {
  description:
    "One-call health digest for an audience: info, stats, N months of growth history, top email clients, and the full merge-field schema. Use this at the start of any session that will work with subscribers, segments, or campaigns — it answers 'what does this audience look like?' in a single request.",
  annotations: { readOnlyHint: true },
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
        'Inspect data.requiresPlan when present; otherwise the API key lacks scope for this audience read.',
    },
    {
      reason: 'mailchimp_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — audience does not exist or has been deleted.',
      recovery: 'Run mailchimp_audiences operation:list to discover valid audienceId values.',
    },
    {
      reason: 'mailchimp_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Mailchimp returned 429 — too many concurrent requests.',
      recovery:
        'Retry after a brief delay; reduce MAILCHIMP_CONCURRENCY_LIMIT for bulk operations.',
      retryable: true,
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const [audience, growthResp, clientsResp, mergeResp] = await Promise.all([
      svc.audiences.get(ctx, input.audienceId),
      svc.audiences.listGrowthHistory(ctx, input.audienceId, { count: input.growthMonths }),
      svc.audiences.listClients(ctx, input.audienceId),
      svc.mergeFields.list(ctx, input.audienceId, { count: 80 }),
    ]);

    const result: Output = {
      audienceId: audience.id,
      name: audience.name,
      growth: growthResp.history.map((h) => {
        const entry: Output['growth'][number] = { month: h.month };
        if (typeof h.subscribed === 'number') entry.subscribed = h.subscribed;
        if (typeof h.unsubscribed === 'number') entry.unsubscribed = h.unsubscribed;
        if (typeof h.existing === 'number') entry.existing = h.existing;
        if (typeof h.cleaned === 'number') entry.cleaned = h.cleaned;
        return entry;
      }),
      emailClients: clientsResp.clients.map((c) => ({ client: c.client, members: c.members })),
      mergeFields: mergeResp.merge_fields.map((m) => {
        const entry: Output['mergeFields'][number] = { tag: m.tag, name: m.name, type: m.type };
        if (typeof m.required === 'boolean') entry.required = m.required;
        return entry;
      }),
    };

    if (audience.date_created) result.dateCreated = audience.date_created;
    if (audience.visibility) result.visibility = audience.visibility;
    if (typeof audience.double_optin === 'boolean') result.doubleOptin = audience.double_optin;
    if (typeof audience.list_rating === 'number') result.listRating = audience.list_rating;
    if (audience.subscribe_url_long) result.subscribeUrl = audience.subscribe_url_long;

    if (audience.stats) {
      const stats: NonNullable<Output['stats']> = {};
      const s = audience.stats;
      if (typeof s.member_count === 'number') stats.memberCount = s.member_count;
      if (typeof s.unsubscribe_count === 'number') stats.unsubscribeCount = s.unsubscribe_count;
      if (typeof s.cleaned_count === 'number') stats.cleanedCount = s.cleaned_count;
      if (typeof s.campaign_count === 'number') stats.campaignCount = s.campaign_count;
      if (s.campaign_last_sent) stats.campaignLastSent = s.campaign_last_sent;
      if (typeof s.open_rate === 'number') stats.openRate = s.open_rate;
      if (typeof s.click_rate === 'number') stats.clickRate = s.click_rate;
      if (typeof s.avg_sub_rate === 'number') stats.avgSubRate = s.avg_sub_rate;
      if (typeof s.avg_unsub_rate === 'number') stats.avgUnsubRate = s.avg_unsub_rate;
      if (s.last_sub_date) stats.lastSubDate = s.last_sub_date;
      if (s.last_unsub_date) stats.lastUnsubDate = s.last_unsub_date;
      if (Object.keys(stats).length > 0) result.stats = stats;
    }

    if (audience.contact) {
      const contact: NonNullable<Output['contact']> = {};
      if (audience.contact.company) contact.company = audience.contact.company;
      if (audience.contact.address1) contact.address1 = audience.contact.address1;
      if (audience.contact.city) contact.city = audience.contact.city;
      if (audience.contact.state) contact.state = audience.contact.state;
      if (audience.contact.zip) contact.zip = audience.contact.zip;
      if (audience.contact.country) contact.country = audience.contact.country;
      if (Object.keys(contact).length > 0) result.contact = contact;
    }

    if (audience.campaign_defaults) {
      result.campaignDefaults = {
        fromName: audience.campaign_defaults.from_name,
        fromEmail: audience.campaign_defaults.from_email,
        subject: audience.campaign_defaults.subject,
        language: audience.campaign_defaults.language,
      };
    }

    const notes: string[] = [];
    const memberCount = result.stats?.memberCount ?? 0;
    const campaignCount = result.stats?.campaignCount ?? 0;
    if (result.growth.length === 0) {
      notes.push(
        'No growth-history rows returned — typical for an audience created within the current month, since Mailchimp buckets growth by month at month-end.',
      );
    }
    if (result.emailClients.length === 0) {
      notes.push(
        memberCount === 0
          ? 'No email-client breakdown — the audience has no members yet.'
          : campaignCount === 0
            ? 'No email-client breakdown — Mailchimp populates this from open events, and no campaigns have been sent to this audience yet.'
            : 'No email-client breakdown — Mailchimp records this from open events; no opens have been recorded yet (or open tracking is disabled).',
      );
    }
    if (notes.length > 0) result.notes = notes;

    ctx.log.info('audience_overview built', {
      audienceId: audience.id,
      memberCount: result.stats?.memberCount,
      growthMonths: result.growth.length,
    });

    return result;
  },

  format: (result) => {
    const lines: string[] = [`# ${result.name}`, '', `**ID:** ${result.audienceId}  `];
    if (result.dateCreated) lines.push(`**Created:** ${result.dateCreated}  `);
    if (typeof result.listRating === 'number')
      lines.push(`**List rating:** ${result.listRating}/5  `);
    if (typeof result.doubleOptin === 'boolean')
      lines.push(`**Double opt-in:** ${result.doubleOptin ? 'yes' : 'no'}  `);
    if (result.visibility)
      lines.push(`**Visibility:** ${result.visibility === 'pub' ? 'public' : 'private'}  `);
    if (result.subscribeUrl) lines.push(`**Subscribe URL:** ${result.subscribeUrl}  `);

    if (result.stats) {
      const s = result.stats;
      lines.push('', '## Stats', '');
      lines.push('| Metric | Value |');
      lines.push('|:-------|------:|');
      if (typeof s.memberCount === 'number') lines.push(`| Members | ${s.memberCount} |`);
      if (typeof s.unsubscribeCount === 'number')
        lines.push(`| Unsubscribed | ${s.unsubscribeCount} |`);
      if (typeof s.cleanedCount === 'number') lines.push(`| Cleaned | ${s.cleanedCount} |`);
      if (typeof s.campaignCount === 'number')
        lines.push(`| Campaigns sent | ${s.campaignCount} |`);
      if (typeof s.openRate === 'number')
        lines.push(`| Open rate | ${(s.openRate * 100).toFixed(2)}% |`);
      if (typeof s.clickRate === 'number')
        lines.push(`| Click rate | ${(s.clickRate * 100).toFixed(2)}% |`);
      if (typeof s.avgSubRate === 'number')
        lines.push(`| Avg subscribe rate | ${s.avgSubRate.toFixed(2)}/mo |`);
      if (typeof s.avgUnsubRate === 'number')
        lines.push(`| Avg unsubscribe rate | ${s.avgUnsubRate.toFixed(2)}/mo |`);
      if (s.campaignLastSent) lines.push(`| Last campaign | ${s.campaignLastSent} |`);
      if (s.lastSubDate) lines.push(`| Last subscribe | ${s.lastSubDate} |`);
      if (s.lastUnsubDate) lines.push(`| Last unsubscribe | ${s.lastUnsubDate} |`);
    }

    if (result.contact) {
      const c = result.contact;
      const parts: string[] = [];
      if (c.company) parts.push(c.company);
      if (c.address1) parts.push(c.address1);
      const cityLine = [c.city, c.state, c.zip].filter(Boolean).join(', ');
      if (cityLine) parts.push(cityLine);
      if (c.country) parts.push(c.country);
      if (parts.length > 0) {
        lines.push('', '## Contact (CAN-SPAM footer)', '');
        for (const p of parts) lines.push(`- ${p}`);
      }
    }

    if (result.campaignDefaults) {
      const d = result.campaignDefaults;
      lines.push('', '## Campaign defaults', '');
      if (d.fromName) lines.push(`- **From name:** ${d.fromName}`);
      if (d.fromEmail) lines.push(`- **From email:** ${d.fromEmail}`);
      if (d.subject) lines.push(`- **Default subject:** ${d.subject}`);
      if (d.language) lines.push(`- **Language:** ${d.language}`);
    }

    if (result.growth.length > 0) {
      lines.push('', `## Growth (${result.growth.length} months)`, '');
      lines.push('| Month | Subs | Unsubs | Existing | Cleaned |');
      lines.push('|:------|-----:|-------:|---------:|--------:|');
      for (const g of result.growth) {
        lines.push(
          `| ${g.month} | ${g.subscribed ?? 0} | ${g.unsubscribed ?? 0} | ${g.existing ?? 0} | ${g.cleaned ?? 0} |`,
        );
      }
    }

    if (result.emailClients.length > 0) {
      lines.push('', '## Top email clients', '');
      for (const c of result.emailClients) lines.push(`- ${c.client}: ${c.members}`);
    }

    if (result.mergeFields.length > 0) {
      lines.push('', `## Merge fields (${result.mergeFields.length})`, '');
      for (const mf of result.mergeFields) {
        const req = mf.required ? ' (required)' : '';
        lines.push(`- \`${mf.tag}\` — ${mf.name} [${mf.type}]${req}`);
      }
    }

    if (result.notes && result.notes.length > 0) {
      lines.push('', '## Notes', '');
      for (const n of result.notes) lines.push(`- _${n}_`);
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
