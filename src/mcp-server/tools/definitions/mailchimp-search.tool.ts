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
  includeTopN: z.number().int().min(1).max(100).default(10).describe('Max results to return.'),
});

const MemberMatchSchema = z.object({
  audienceId: z.string(),
  subscriberId: z.string(),
  email: z.string(),
  status: z.string(),
  fullName: z.string().optional(),
});

const CampaignMatchSchema = z.object({
  campaignId: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
  subjectLine: z.string().optional(),
  title: z.string().optional(),
  sendTime: z.string().optional(),
  snippet: z.string().optional(),
});

const OutputSchema = z.object({
  scope: ScopeSchema,
  query: z.string(),
  members: z
    .object({
      exact: z.array(MemberMatchSchema),
      fuzzy: z.array(MemberMatchSchema),
      totalExact: z.number(),
      totalFuzzy: z.number(),
    })
    .optional(),
  campaigns: z
    .object({
      matches: z.array(CampaignMatchSchema),
      totalMatches: z.number(),
    })
    .optional(),
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
      return {
        scope: 'members',
        query: input.query,
        members: {
          exact: exactAll.slice(0, input.includeTopN).map((m) => {
            const out: z.infer<typeof MemberMatchSchema> = {
              audienceId: m.list_id,
              subscriberId: m.id,
              email: m.email_address,
              status: m.status,
            };
            if (m.full_name) out.fullName = m.full_name;
            return out;
          }),
          fuzzy: fuzzyAll.slice(0, input.includeTopN).map((m) => {
            const out: z.infer<typeof MemberMatchSchema> = {
              audienceId: m.list_id,
              subscriberId: m.id,
              email: m.email_address,
              status: m.status,
            };
            if (m.full_name) out.fullName = m.full_name;
            return out;
          }),
          totalExact: resp.exact_matches?.total_items ?? exactAll.length,
          totalFuzzy: resp.full_search?.total_items ?? fuzzyAll.length,
        },
      };
    }

    const resp = await svc.search.campaigns(ctx, { query: input.query });
    return {
      scope: 'campaigns',
      query: input.query,
      campaigns: {
        totalMatches: resp.total_items,
        matches: resp.results.slice(0, input.includeTopN).map((r) => {
          const out: z.infer<typeof CampaignMatchSchema> = { campaignId: r.campaign.id };
          if (r.campaign.type) out.type = r.campaign.type;
          if (r.campaign.status) out.status = r.campaign.status;
          if (r.campaign.settings?.subject_line) out.subjectLine = r.campaign.settings.subject_line;
          if (r.campaign.settings?.title) out.title = r.campaign.settings.title;
          if (r.campaign.send_time) out.sendTime = r.campaign.send_time;
          if (r.snippet) out.snippet = r.snippet;
          return out;
        }),
      },
    };
  },

  format: (result) => {
    const lines: string[] = [`# Search: \`${result.query}\` (${result.scope})`, ''];
    if (result.members) {
      const m = result.members;
      lines.push(`**Exact matches:** ${m.totalExact} (showing ${m.exact.length})`);
      for (const r of m.exact) {
        lines.push(
          `- \`${r.email}\` — ${r.status}${r.fullName ? ` (${r.fullName})` : ''} in \`${r.audienceId}\``,
        );
      }
      if (m.fuzzy.length > 0) {
        lines.push('', `**Fuzzy matches:** ${m.totalFuzzy} (showing ${m.fuzzy.length})`);
        for (const r of m.fuzzy) {
          lines.push(
            `- \`${r.email}\` — ${r.status}${r.fullName ? ` (${r.fullName})` : ''} in \`${r.audienceId}\``,
          );
        }
      }
      if (m.exact.length === 0 && m.fuzzy.length === 0) lines.push('_No matches._');
    } else if (result.campaigns) {
      const c = result.campaigns;
      lines.push(
        `**${c.totalMatches} campaign match${c.totalMatches === 1 ? '' : 'es'}** (showing ${c.matches.length})`,
        '',
      );
      for (const r of c.matches) {
        lines.push(
          `- **${r.subjectLine ?? r.title ?? r.campaignId}** (\`${r.campaignId}\`)${r.status ? ` — ${r.status}` : ''}${r.sendTime ? ` · ${r.sendTime}` : ''}`,
        );
        if (r.snippet) lines.push(`  _${r.snippet}_`);
      }
      if (c.matches.length === 0) lines.push('_No matches._');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
