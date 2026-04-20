/**
 * @fileoverview `mailchimp_find_subscriber` — email lookup across one or all
 * audiences, enriched with member detail and tags.
 * @module mcp-server/tools/definitions/mailchimp-find-subscriber.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import type { Subscriber } from '@/services/mailchimp/types.js';

const InputSchema = z.object({
  email: z.string().describe('Email address to search for.'),
  audienceId: z
    .string()
    .optional()
    .describe(
      'Restrict the search to a single audience. Omit to search across every audience on the account.',
    ),
  includeTags: z
    .boolean()
    .default(true)
    .describe('Fetch the full active tag list for each match. Adds one upstream call per match.'),
});

const MatchSchema = z.object({
  audienceId: z.string(),
  subscriberId: z.string(),
  email: z.string(),
  status: z.string(),
  fullName: z.string().optional(),
  memberRating: z.number().optional(),
  language: z.string().optional(),
  vip: z.boolean().optional(),
  source: z.string().optional(),
  lastChanged: z.string().optional(),
  timestampSignup: z.string().optional(),
  timestampOpt: z.string().optional(),
  mergeFields: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  stats: z
    .object({
      avgOpenRate: z.number().optional(),
      avgClickRate: z.number().optional(),
    })
    .optional(),
});

const OutputSchema = z.object({
  email: z.string().describe('Email address that was searched for, echoed back.'),
  searchedAcross: z
    .enum(['single-audience', 'all-audiences'])
    .describe(
      'Scope of the search: `single-audience` when an audienceId was supplied, `all-audiences` otherwise.',
    ),
  exactMatches: z.array(MatchSchema).describe('Exact email-address matches.'),
  fuzzyMatches: z
    .array(MatchSchema)
    .describe('Fuzzy matches — near-miss records Mailchimp thinks might be related.'),
  totalMatches: z.number().describe('exactMatches + fuzzyMatches.'),
});

type Output = z.infer<typeof OutputSchema>;

function summarize(s: Subscriber, tags: string[] | undefined): z.infer<typeof MatchSchema> {
  const out: z.infer<typeof MatchSchema> = {
    audienceId: s.list_id,
    subscriberId: s.id,
    email: s.email_address,
    status: s.status,
  };
  if (s.full_name) out.fullName = s.full_name;
  if (typeof s.member_rating === 'number') out.memberRating = s.member_rating;
  if (s.language) out.language = s.language;
  if (typeof s.vip === 'boolean') out.vip = s.vip;
  if (s.source) out.source = s.source;
  if (s.last_changed) out.lastChanged = s.last_changed;
  if (s.timestamp_signup) out.timestampSignup = s.timestamp_signup;
  if (s.timestamp_opt) out.timestampOpt = s.timestamp_opt;
  if (s.merge_fields && Object.keys(s.merge_fields).length > 0) out.mergeFields = s.merge_fields;
  if (tags !== undefined) out.tags = tags;
  if (s.stats) {
    const stats: NonNullable<z.infer<typeof MatchSchema>['stats']> = {};
    if (typeof s.stats.avg_open_rate === 'number') stats.avgOpenRate = s.stats.avg_open_rate;
    if (typeof s.stats.avg_click_rate === 'number') stats.avgClickRate = s.stats.avg_click_rate;
    if (Object.keys(stats).length > 0) out.stats = stats;
  }
  return out;
}

export const mailchimpFindSubscriberTool = tool('mailchimp_find_subscriber', {
  description:
    'Locate a subscriber by email across one audience (when `audienceId` is provided) or all audiences on the account. Returns exact and fuzzy matches from Mailchimp search, enriched with merge fields, stats, and active tags. Most free accounts have a single audience, so this is usually a fast one-call lookup.',
  annotations: { readOnlyHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();
    const searchParams: { query: string; listId?: string } = { query: input.email };
    if (input.audienceId) searchParams.listId = input.audienceId;
    const resp = await svc.search.members(ctx, searchParams);

    const exactMembers = resp.exact_matches?.members ?? [];
    const fuzzyMembers = resp.full_search?.members ?? [];

    const fetchTags = async (s: Subscriber): Promise<string[] | undefined> => {
      if (!input.includeTags) return;
      const hash = s.id;
      const { tags } = await svc.subscribers
        .listTags(ctx, s.list_id, hash, { count: 1000 })
        .catch(() => ({ tags: [], total_items: 0 }));
      return tags.map((t) => t.name);
    };

    const [exactEnriched, fuzzyEnriched] = await Promise.all([
      Promise.all(exactMembers.map(async (s) => summarize(s, await fetchTags(s)))),
      Promise.all(fuzzyMembers.map(async (s) => summarize(s, await fetchTags(s)))),
    ]);

    ctx.log.info('find_subscriber', {
      email: input.email,
      audienceId: input.audienceId,
      exact: exactEnriched.length,
      fuzzy: fuzzyEnriched.length,
    });

    return {
      email: input.email,
      searchedAcross: input.audienceId ? 'single-audience' : 'all-audiences',
      exactMatches: exactEnriched,
      fuzzyMatches: fuzzyEnriched,
      totalMatches: exactEnriched.length + fuzzyEnriched.length,
    };
  },

  format: (result) => {
    const lines: string[] = [`# \`${result.email}\``, '', `Searched: ${result.searchedAcross}`];
    if (result.totalMatches === 0) {
      lines.push('', '_No matches._');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    const render = (m: z.infer<typeof MatchSchema>): string[] => {
      const sub: string[] = [
        `- **${m.email}** — ${m.status}${m.fullName ? ` (${m.fullName})` : ''}`,
        `  Audience: \`${m.audienceId}\` · Subscriber: \`${m.subscriberId}\``,
      ];
      if (typeof m.memberRating === 'number') sub.push(`  Rating: ${m.memberRating}/5`);
      if (m.timestampOpt) sub.push(`  Opted in: ${m.timestampOpt}`);
      if (m.tags && m.tags.length > 0) sub.push(`  Tags: ${m.tags.join(', ')}`);
      if (m.mergeFields && Object.keys(m.mergeFields).length > 0) {
        const kv = Object.entries(m.mergeFields)
          .filter(([, v]) => v !== '' && v !== null && v !== undefined)
          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
        if (kv.length > 0) sub.push(`  Merge: ${kv.join(', ')}`);
      }
      return sub;
    };
    if (result.exactMatches.length > 0) {
      lines.push('', `## Exact matches (${result.exactMatches.length})`);
      for (const m of result.exactMatches) lines.push(...render(m));
    }
    if (result.fuzzyMatches.length > 0) {
      lines.push('', `## Fuzzy matches (${result.fuzzyMatches.length})`);
      for (const m of result.fuzzyMatches) lines.push(...render(m));
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
