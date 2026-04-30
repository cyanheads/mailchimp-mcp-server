/**
 * @fileoverview `mailchimp_search` — global search across subscribers or campaigns.
 * For subscriber detail + tag enrichment, use `mailchimp_find_subscriber` instead.
 * @module mcp-server/tools/definitions/mailchimp-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

const ScopeSchema = z
  .enum(['members', 'campaigns'])
  .describe(
    'What to search. `members` matches across all audiences. `campaigns` matches titles/subjects/previews.',
  );

const InputSchema = z.object({
  scope: ScopeSchema,
  query: z.string().min(1).describe('Search terms.'),
  audienceId: z
    .string()
    .optional()
    .describe('Restrict member search to a single audience. Ignored for `scope: campaigns`.'),
  includeTopN: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('Max results to return.'),
});

const MemberMatchSchema = z
  .object({
    audienceId: z.string().describe('Audience (list) ID the match belongs to.'),
    subscriberId: z.string().describe('Mailchimp subscriber ID (member hash).'),
    email: z.string().describe('Subscriber email address.'),
    status: z.string().describe('Current subscription status.'),
    fullName: z.string().optional().describe('Full name from merge fields, if available.'),
  })
  .describe('One member hit from the global search.');

const CampaignMatchSchema = z
  .object({
    campaignId: z.string().describe('Campaign ID.'),
    type: z.string().optional().describe('Campaign type (`regular`, `plaintext`, `rss`).'),
    status: z.string().optional().describe('Campaign status (`save`, `sent`, …).'),
    subjectLine: z.string().optional().describe('Subject line as sent.'),
    title: z.string().optional().describe('Internal campaign title.'),
    sendTime: z.string().optional().describe('ISO 8601 send timestamp.'),
    snippet: z.string().optional().describe('Context snippet showing where the hit occurred.'),
  })
  .describe('One campaign hit from the global search.');

const OutputSchema = z.object({
  scope: ScopeSchema,
  query: z.string().describe('Echoed search query.'),
  members: z
    .object({
      exact: z.array(MemberMatchSchema).describe('Exact email-address matches.'),
      fuzzy: z
        .array(MemberMatchSchema)
        .describe('Near-miss members Mailchimp thinks may be related.'),
      totalExact: z.number().describe('Total exact matches available upstream.'),
      totalFuzzy: z.number().describe('Total fuzzy matches available upstream.'),
    })
    .optional()
    .describe('Populated for `scope: members`.'),
  campaigns: z
    .object({
      matches: z
        .array(CampaignMatchSchema)
        .describe('Matching campaigns with a snippet of where the hit occurred.'),
      totalMatches: z.number().describe('Total matches available upstream.'),
    })
    .optional()
    .describe('Populated for `scope: campaigns`.'),
  note: z
    .string()
    .optional()
    .describe(
      'Plain-language note populated when the search returns no results — echoes the query and suggests next moves.',
    ),
});

type Output = z.infer<typeof OutputSchema>;

export const mailchimpSearchTool = tool('mailchimp_search', {
  description:
    'Global search. Use `scope: members` to find subscribers by email/name fragment across all audiences (or pass `audienceId` to restrict). Use `scope: campaigns` to find campaigns by subject / title / preview text / archive. For subscriber detail + tags, prefer `mailchimp_find_subscriber` — this tool is for lightweight discovery.',
  annotations: { readOnlyHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    if (input.scope === 'members') {
      const params: { query: string; listId?: string } = { query: input.query };
      if (input.audienceId) params.listId = input.audienceId;
      const resp = await svc.search.members(ctx, params);
      const exactAll = resp.exact_matches?.members ?? [];
      const fuzzyAll = resp.full_search?.members ?? [];
      const totalExact = resp.exact_matches?.total_items ?? exactAll.length;
      const totalFuzzy = resp.full_search?.total_items ?? fuzzyAll.length;
      const out: Output = {
        scope: 'members',
        query: input.query,
        members: {
          exact: exactAll.slice(0, input.includeTopN).map((m) => {
            const o: z.infer<typeof MemberMatchSchema> = {
              audienceId: m.list_id,
              subscriberId: m.id,
              email: m.email_address,
              status: m.status,
            };
            if (m.full_name) o.fullName = m.full_name;
            return o;
          }),
          fuzzy: fuzzyAll.slice(0, input.includeTopN).map((m) => {
            const o: z.infer<typeof MemberMatchSchema> = {
              audienceId: m.list_id,
              subscriberId: m.id,
              email: m.email_address,
              status: m.status,
            };
            if (m.full_name) o.fullName = m.full_name;
            return o;
          }),
          totalExact,
          totalFuzzy,
        },
      };
      if (totalExact === 0 && totalFuzzy === 0) {
        out.note = `No subscribers matched '${input.query}'${input.audienceId ? ` in audience '${input.audienceId}'` : ' across any audience'}. Archived subscribers are excluded — check via mailchimp_find_subscriber for the exact email, broaden the query, or omit audienceId to widen the scope.`;
      }
      return out;
    }

    const resp = await svc.search.campaigns(ctx, { query: input.query });
    const out: Output = {
      scope: 'campaigns',
      query: input.query,
      campaigns: {
        totalMatches: resp.total_items,
        matches: resp.results.slice(0, input.includeTopN).map((r) => {
          const o: z.infer<typeof CampaignMatchSchema> = { campaignId: r.campaign.id };
          if (r.campaign.type) o.type = r.campaign.type;
          if (r.campaign.status) o.status = r.campaign.status;
          if (r.campaign.settings?.subject_line) o.subjectLine = r.campaign.settings.subject_line;
          if (r.campaign.settings?.title) o.title = r.campaign.settings.title;
          if (r.campaign.send_time) o.sendTime = r.campaign.send_time;
          if (r.snippet) o.snippet = r.snippet;
          return o;
        }),
      },
    };
    if (resp.total_items === 0) {
      out.note = `No campaigns matched '${input.query}'. Search covers subject line, internal title, preview text, and archive HTML — try broader terms, or use mailchimp_campaigns (operation: list) to browse all campaigns.`;
    }
    return out;
  },

  format: (result) => {
    const lines: string[] = [`# Search: \`${result.query}\` (${result.scope})`, ''];
    if (result.members) {
      const m = result.members;
      lines.push(`**Exact matches:** ${m.totalExact} (showing ${m.exact.length})`);
      for (const r of m.exact) {
        lines.push(
          `- \`${r.email}\` [${r.subscriberId}] — ${r.status}${r.fullName ? ` (${r.fullName})` : ''} in \`${r.audienceId}\``,
        );
      }
      if (m.fuzzy.length > 0) {
        lines.push('', `**Fuzzy matches:** ${m.totalFuzzy} (showing ${m.fuzzy.length})`);
        for (const r of m.fuzzy) {
          lines.push(
            `- \`${r.email}\` [${r.subscriberId}] — ${r.status}${r.fullName ? ` (${r.fullName})` : ''} in \`${r.audienceId}\``,
          );
        }
      }
      if (m.exact.length === 0 && m.fuzzy.length === 0) {
        lines.push(result.note ? `_${result.note}_` : '_No matches._');
      }
    }
    if (result.campaigns) {
      const c = result.campaigns;
      lines.push(
        '',
        `**${c.totalMatches} campaign match${c.totalMatches === 1 ? '' : 'es'}** (showing ${c.matches.length})`,
        '',
      );
      for (const r of c.matches) {
        const titleLabel = r.subjectLine ?? r.title ?? r.campaignId;
        const titleAlt = r.title && r.title !== titleLabel ? ` / title: ${r.title}` : '';
        const typeTag = r.type ? ` [${r.type}]` : '';
        lines.push(
          `- **${titleLabel}**${titleAlt} (\`${r.campaignId}\`)${typeTag}${r.status ? ` — ${r.status}` : ''}${r.sendTime ? ` · ${r.sendTime}` : ''}`,
        );
        if (r.snippet) lines.push(`  _${r.snippet}_`);
      }
      if (c.matches.length === 0) {
        lines.push(result.note ? `_${result.note}_` : '_No matches._');
      }
    }
    if (
      result.note &&
      ((result.members && (result.members.exact.length > 0 || result.members.fuzzy.length > 0)) ||
        (result.campaigns && result.campaigns.matches.length > 0))
    ) {
      lines.push('', `_${result.note}_`);
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
