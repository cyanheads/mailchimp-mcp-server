/**
 * @fileoverview `mailchimp_playbook` — procedural guidance merged with live
 * account state. Returns markdown instructions tailored to current numbers
 * plus a `nextToolSuggestions` list so the agent can chain follow-up calls
 * deterministically. Read-only; the agent does the work with other tools.
 * @module mcp-server/tools/definitions/mailchimp-playbook.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  getMailchimpService,
  mailchimpMemberHash,
} from '@/services/mailchimp/mailchimp-service.js';
import { MAILCHIMP_SERVICE_ERRORS } from './_error-contracts.js';

const TopicSchema = z
  .enum([
    'send',
    'post-send-review',
    'deliverability',
    'list-hygiene',
    'onboarding',
    'subscriber-triage',
    'design-campaign',
  ])
  .describe(
    "Which playbook to render. `send` — compose & dispatch a campaign. `post-send-review` — interpret a just-sent campaign. `deliverability` — diagnose bounces / abuse / low engagement. `list-hygiene` — clean a stale audience. `onboarding` — first-time setup walk-through. `subscriber-triage` — investigate one subscriber. `design-campaign` — compose a well-designed editorial newsletter (palette, typography, graphics via CDN, subject/preview craft) tailored to the audience's engagement profile.",
  );

const InputSchema = z.object({
  topic: TopicSchema,
  audienceId: z
    .string()
    .optional()
    .describe(
      'Audience ID. Needed for `send`, `list-hygiene`, `subscriber-triage`, `design-campaign` (to scope the probe).',
    ),
  campaignId: z.string().optional().describe('Campaign ID. Needed for `post-send-review`.'),
  email: z.string().optional().describe('Subscriber email. Needed for `subscriber-triage`.'),
});

const NextToolSchema = z
  .object({
    tool: z.string().describe('Tool name to call next.'),
    reason: z.string().describe('Why this tool, in the current context.'),
    suggestedInput: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Prefilled input you can pass to the tool.'),
  })
  .describe('A recommended follow-up tool call, with reason and pre-filled arguments.');

const OutputSchema = z.object({
  topic: TopicSchema,
  instructions: z.string().describe('Markdown walkthrough tailored to the live numbers.'),
  liveState: z
    .record(z.string(), z.unknown())
    .describe('The live data the playbook folded in (so the agent can verify or drill down).'),
  nextToolSuggestions: z
    .array(NextToolSchema)
    .describe('Ordered list of follow-up tool calls, with reasons.'),
});

type Output = z.infer<typeof OutputSchema>;

const PCT = (v: number | undefined): string =>
  typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—';

export const mailchimpPlaybookTool = tool('mailchimp_playbook', {
  description:
    'Returns a structured procedural playbook merged with live account state. Call this at the start of a complex multi-step task (designing a campaign, sending a campaign, reviewing a send, diagnosing deliverability, cleaning a list, onboarding, triaging a subscriber) to get a tailored walkthrough. Advice-only — the agent executes subsequent steps using the other tools. Returns markdown instructions + a live-state snapshot + `nextToolSuggestions` with pre-filled arguments.',
  annotations: { readOnlyHint: true },
  input: InputSchema,
  output: OutputSchema,
  errors: [
    ...MAILCHIMP_SERVICE_ERRORS,
    {
      reason: 'subscriber_search_no_usable_match',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Subscriber search returned matches but none had usable record data.',
      recovery:
        'Use mailchimp_find_subscriber with the same email to inspect the raw search response and pick a candidate.',
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    switch (input.topic) {
      case 'onboarding': {
        const info = await svc.account.info(ctx);
        const totalSubs = info.total_subscribers ?? 0;
        const plan = info.pricing_plan_type ?? 'unknown';
        const instructions = [
          '# Onboarding walkthrough',
          '',
          `You're on account **${info.account_name}** (plan: ${plan}, total subscribers: ${totalSubs}).`,
          '',
          '1. **Confirm the account is set up.** `mailchimp_account` with `operation: info` should show your plan, email, and total subscribers.',
          '2. **See what audiences exist.** `mailchimp_audiences` with `operation: list`. Free plan allows 1 audience.',
          '3. **If no audience exists**, create one with `mailchimp_audiences` `operation: create`. Required fields: name, contact.{company,address1,city,state,zip,country}, permissionReminder, campaignDefaults.{fromName,fromEmail,language}.',
          '4. **Review the audience schema.** `mailchimp_merge_fields` `operation: list` shows which subscriber attributes you can personalize on.',
          '5. **Add your first subscribers.** `mailchimp_upsert_subscriber` for one email at a time, or `mailchimp_import_subscribers` for a batch. Status defaults to `pending` for double-opt-in — change to `subscribed` only if you have explicit consent.',
          '6. **Snapshot the audience before sending.** `mailchimp_audience_overview` returns stats + growth + email clients + merge-field schema in one call.',
          '7. **Send your first campaign.** `mailchimp_send_campaign` with `mode: draft` or `mode: test` before doing `mode: send`.',
        ].join('\n');
        return {
          topic: 'onboarding',
          instructions,
          liveState: {
            accountName: info.account_name,
            plan,
            totalSubscribers: totalSubs,
            dataCenter: svc.dataCenter,
          },
          nextToolSuggestions: [
            {
              tool: 'mailchimp_audiences',
              reason: 'See what audiences exist',
              suggestedInput: { operation: 'list' },
            },
            {
              tool: 'mailchimp_audience_overview',
              reason: 'Once you have an audience, snapshot it',
              suggestedInput: {},
            },
          ],
        };
      }

      case 'send': {
        if (!input.audienceId) {
          throw validationError("'audienceId' is required for topic 'send'.");
        }
        const [audience, growth] = await Promise.all([
          svc.audiences.get(ctx, input.audienceId),
          svc.audiences
            .listGrowthHistory(ctx, input.audienceId, { count: 3 })
            .catch(() => ({ history: [], total_items: 0 })),
        ]);
        const recentNet = growth.history.reduce(
          (acc, h) => acc + (h.subscribed ?? 0) - (h.unsubscribed ?? 0),
          0,
        );
        const open = audience.stats?.open_rate;
        const click = audience.stats?.click_rate;
        const memberCount = audience.stats?.member_count ?? 0;
        const instructions = [
          `# Send playbook — "${audience.name}"`,
          '',
          `**Current state:** ${memberCount} members, avg open ${PCT(open)}, avg click ${PCT(click)}, net growth last 3 months: ${recentNet >= 0 ? '+' : ''}${recentNet}.`,
          '',
          '1. **Pick a template or write content.** `mailchimp_templates` `operation: list` to browse saved templates. Or write HTML / plaintext directly.',
          '2. **Draft first.** Call `mailchimp_send_campaign` with `mode: draft` (or `mode: test` with `testEmails`) to build the campaign and run the send-checklist without dispatching.',
          '3. **Review the checklist.** The tool returns `checklistWarnings`. Fix any `error` items before sending.',
          '4. **Send a test.** Re-run with `mode: test` and your own email in `testEmails` to proofread the rendered output.',
          '5. **Confirm the send.** Re-run with `mode: send` (or `mode: schedule` + `scheduleTime`). A human-in-the-loop client will prompt for confirmation via `ctx.elicit`; decline to downgrade back to draft.',
          '6. **Post-send review.** Once status becomes `sent`, call `mailchimp_playbook` with `topic: post-send-review` and the returned `campaignId` for a tailored follow-up.',
          '',
          open !== undefined && open < 0.15
            ? '> **Note on deliverability:** your open rate is trending below industry norms — subject line and from-name quality matter more than frequency right now.'
            : '',
          recentNet < 0
            ? '> **Note on list health:** you are losing more subscribers than you gain. Consider `topic: list-hygiene` before sending.'
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          topic: 'send',
          instructions,
          liveState: {
            audienceId: audience.id,
            audienceName: audience.name,
            memberCount,
            openRate: open,
            clickRate: click,
            recentNetGrowth: recentNet,
          },
          nextToolSuggestions: [
            {
              tool: 'mailchimp_templates',
              reason: 'See saved templates before drafting',
              suggestedInput: { operation: 'list', type: 'user' },
            },
            {
              tool: 'mailchimp_send_campaign',
              reason: 'Draft the campaign and run the send-checklist',
              suggestedInput: { audienceId: audience.id, mode: 'draft' },
            },
          ],
        };
      }

      case 'post-send-review': {
        if (!input.campaignId) {
          throw validationError("'campaignId' is required for topic 'post-send-review'.");
        }
        const report = await svc.reports.get(ctx, input.campaignId);
        const open = report.opens?.open_rate ?? 0;
        const click = report.clicks?.click_rate ?? 0;
        const sent = report.emails_sent ?? 0;
        const ib = report.industry_stats;
        const benchmark = (actual: number | undefined, avg: number | undefined): string => {
          if (typeof actual !== 'number' || typeof avg !== 'number') return '';
          const delta = actual - avg;
          const sign = delta >= 0 ? '+' : '';
          return ` (${sign}${(delta * 100).toFixed(2)}pp vs industry)`;
        };
        /** Suppress rate-based advice on tiny sends — 0/1 isn't a "low rate", it's no signal. Threshold: 50 recipients gives roughly ±5pp confidence on a 15% rate. */
        const SAMPLE_THRESHOLD = 50;
        const tooSmall = sent < SAMPLE_THRESHOLD;
        const instructions = [
          `# Post-send review — "${report.campaign_title ?? report.subject_line ?? report.id}"`,
          '',
          `**Sent to:** ${sent}  `,
          `**Open rate:** ${PCT(open)}${tooSmall ? '' : benchmark(open, ib?.open_rate)}  `,
          `**Click rate:** ${PCT(click)}${tooSmall ? '' : benchmark(click, ib?.click_rate)}  `,
          `**Unsubscribed:** ${report.unsubscribed ?? 0}  `,
          `**Abuse reports:** ${report.abuse_reports ?? 0}  `,
          '',
          tooSmall
            ? `> **Sample too small for rate analysis.** ${sent} recipient${sent === 1 ? '' : 's'} — open/click rates are not meaningful below ~${SAMPLE_THRESHOLD}. Inspect raw events directly instead of treating percentages as signal.`
            : '',
          '1. **Get the full digest.** `mailchimp_campaign_report` returns top clicked links, top locations, recent unsubs, and industry benchmarks in one call.',
          tooSmall
            ? '2. **Inspect the raw event timeline.** `mailchimp_reports` `operation: slice` with `dimension: email-activity` shows per-recipient opens / clicks / bounces — far more useful than a rate at this volume.'
            : open < 0.15
              ? "2. **Low opens — look at subject/from.** Open rate is below typical industry benchmarks. Check `mailchimp_reports` with `dimension: advice` for Mailchimp's automated tips."
              : '2. **Opens look healthy.** Focus review on content → action funnel.',
          tooSmall
            ? '3. **Click-by-click drilldown.** `mailchimp_reports` `operation: slice` with `dimension: click-details` lists every URL with its click count — useful even when there are zero clicks.'
            : click < 0.02
              ? "3. **Low clicks — look at content.** Click rate is low; use `mailchimp_reports` `operation: slice` with `dimension: click-details` to see which links landed (and which didn't)."
              : '3. **Clicks are healthy — which CTAs won?** `mailchimp_reports` `operation: slice` with `dimension: click-details`.',
          (report.abuse_reports ?? 0) > 0
            ? '4. **⚠ Abuse reports present.** Review with `mailchimp_reports` `dimension: abuse-reports` — high counts damage deliverability.'
            : '4. **No abuse reports.** Good signal.',
          '5. **Unsub reasons.** `mailchimp_reports` with `dimension: unsubscribed` — the `reason` field tells you what drove the unsubs.',
          '6. **If this was bad, diagnose next.** `mailchimp_playbook` with `topic: deliverability`.',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          topic: 'post-send-review',
          instructions,
          liveState: {
            campaignId: report.id,
            emailsSent: report.emails_sent,
            openRate: open,
            clickRate: click,
            unsubscribed: report.unsubscribed,
            abuseReports: report.abuse_reports,
            industryOpenRate: ib?.open_rate,
            industryClickRate: ib?.click_rate,
          },
          nextToolSuggestions: [
            {
              tool: 'mailchimp_campaign_report',
              reason: 'Full digest with top links, locations, recent unsubs, benchmarks',
              suggestedInput: { campaignId: report.id },
            },
            {
              tool: 'mailchimp_reports',
              reason: 'Drill into advice from Mailchimp',
              suggestedInput: { operation: 'slice', campaignId: report.id, dimension: 'advice' },
            },
          ],
        };
      }

      case 'deliverability': {
        const reportsResp = await svc.reports
          .list(ctx, { count: 10 })
          .catch(() => ({ reports: [], total_items: 0 }));
        const recent = reportsResp.reports ?? [];
        const avgOpen = recent.length
          ? recent.reduce((a, r) => a + (r.opens?.open_rate ?? 0), 0) / recent.length
          : 0;
        const avgClick = recent.length
          ? recent.reduce((a, r) => a + (r.clicks?.click_rate ?? 0), 0) / recent.length
          : 0;
        const totalBounces = recent.reduce(
          (a, r) =>
            a +
            (r.bounces?.hard_bounces ?? 0) +
            (r.bounces?.soft_bounces ?? 0) +
            (r.bounces?.syntax_errors ?? 0),
          0,
        );
        const totalSent = recent.reduce((a, r) => a + (r.emails_sent ?? 0), 0);
        const bounceRate = totalSent > 0 ? totalBounces / totalSent : 0;
        const totalAbuse = recent.reduce((a, r) => a + (r.abuse_reports ?? 0), 0);
        const instructions = [
          '# Deliverability diagnosis',
          '',
          `Across the last ${recent.length} campaigns: avg open ${PCT(avgOpen)}, avg click ${PCT(avgClick)}, overall bounce rate ${PCT(bounceRate)}, ${totalAbuse} abuse reports.`,
          '',
          "1. **Check each campaign's advice.** `mailchimp_reports` `operation: slice` with `dimension: advice` per campaign gives Mailchimp's own automated recommendations.",
          bounceRate > 0.02
            ? "2. **⚠ High bounce rate.** >2% bounce is Mailchimp's deliverability threshold. Run `topic: list-hygiene` to clean stale addresses."
            : '2. **Bounce rate is within limits.** <2% is the target.',
          totalAbuse > 0
            ? '3. **⚠ Abuse reports across recent sends.** Investigate content/subject/from-name. Abuse correlates with unwanted content perception.'
            : '3. **No abuse reports across the last 10 campaigns.** Good signal.',
          avgOpen < 0.15
            ? '4. **Low open rate.** Weak from-name/subject or inbox-placement issues. Run a small A/B by sending the same content with a different subject to a test segment.'
            : '4. **Open rates look healthy.**',
          avgClick < 0.02
            ? '5. **Low click rate.** Content-driven; review CTA placement and wording.'
            : '5. **Click rates look healthy.**',
          '6. **Authentication.** Make sure your sending domain has SPF/DKIM/DMARC records set up in Mailchimp → Website → Domains.',
        ].join('\n');
        return {
          topic: 'deliverability',
          instructions,
          liveState: {
            campaignsAnalyzed: recent.length,
            avgOpenRate: avgOpen,
            avgClickRate: avgClick,
            overallBounceRate: bounceRate,
            totalAbuseReports: totalAbuse,
          },
          nextToolSuggestions: [
            {
              tool: 'mailchimp_reports',
              reason: 'Get Mailchimp-generated advice for the most recent campaign',
              suggestedInput: recent[0]
                ? { operation: 'slice', campaignId: recent[0].id, dimension: 'advice' }
                : { operation: 'list' },
            },
            {
              tool: 'mailchimp_playbook',
              reason: 'If bounce rate is high, plan list hygiene',
              suggestedInput: { topic: 'list-hygiene' },
            },
          ],
        };
      }

      case 'list-hygiene': {
        if (!input.audienceId) {
          throw validationError("'audienceId' is required for topic 'list-hygiene'.");
        }
        const audience = await svc.audiences.get(ctx, input.audienceId);
        const m = audience.stats?.member_count ?? 0;
        const c = audience.stats?.cleaned_count ?? 0;
        const u = audience.stats?.unsubscribe_count ?? 0;
        const cleanedRatio = m > 0 ? c / m : 0;
        const instructions = [
          `# List hygiene — "${audience.name}"`,
          '',
          `**Members:** ${m}  `,
          `**Cleaned (hard bounces):** ${c} (${PCT(cleanedRatio)})  `,
          `**Unsubscribed:** ${u}  `,
          '',
          '1. **Archive chronically disengaged subscribers.** Use `mailchimp_subscribers` `operation: list` with `status: subscribed` to pull recent members, then review their `stats.avg_open_rate`. Archive those under 10% over the last ~10 sends with `operation: archive`.',
          "2. **Review cleaned addresses.** `mailchimp_subscribers` `operation: list` with `status: cleaned` — these are hard bounces; confirm they're truly dead addresses before letting the count pile up (it's already hurting your sender reputation).",
          '3. **Check the growth history.** `mailchimp_audiences` `operation: list-growth` — a growing `cleaned` column often points to a corrupted import.',
          '4. **Tighten signup.** If cleaned ratio is high (>5%), consider enabling double opt-in on this audience (`mailchimp_audiences` `operation: update` with `doubleOptin: true`).',
          '5. **Do NOT delete the audience.** That destroys campaign history and stats. Archiving subscribers is the reversible approach.',
          '',
          cleanedRatio > 0.05
            ? '> **⚠** Your cleaned ratio is over 5%. Cleaning this audience *before* your next send is the highest-leverage thing you can do.'
            : '> Cleaned ratio is within normal bounds.',
        ].join('\n');
        return {
          topic: 'list-hygiene',
          instructions,
          liveState: {
            audienceId: audience.id,
            audienceName: audience.name,
            memberCount: m,
            cleanedCount: c,
            unsubscribeCount: u,
            cleanedRatio,
          },
          nextToolSuggestions: [
            {
              tool: 'mailchimp_subscribers',
              reason: 'Pull cleaned subscribers for review',
              suggestedInput: {
                operation: 'list',
                audienceId: audience.id,
                status: 'cleaned',
                count: 50,
              },
            },
            {
              tool: 'mailchimp_audiences',
              reason: 'Check long-term growth trend for patterns',
              suggestedInput: { operation: 'list-growth', audienceId: audience.id, count: 12 },
            },
          ],
        };
      }

      case 'subscriber-triage': {
        if (!input.email) {
          throw validationError("'email' is required for topic 'subscriber-triage'.");
        }
        const searchParams: { query: string; listId?: string } = { query: input.email };
        if (input.audienceId) searchParams.listId = input.audienceId;
        const found = await svc.search.members(ctx, searchParams).catch(() => null);
        const exact = found?.exact_matches?.members ?? [];
        const fuzzy = found?.full_search?.members ?? [];
        if (exact.length === 0 && fuzzy.length === 0) {
          const hash = mailchimpMemberHash(input.email);
          return {
            topic: 'subscriber-triage',
            instructions: [
              `# Subscriber triage — \`${input.email}\``,
              '',
              '**No matches** across search-members. They are not currently on any audience on this account.',
              '',
              '1. **If they should be here:** call `mailchimp_upsert_subscriber` to create them (status `pending` for double-opt-in, `subscribed` for immediate opt-in).',
              '2. **If they were archived:** archived subscribers are not returned by search. Re-subscribing via `mailchimp_upsert_subscriber` will resurrect the record.',
              "3. **If permanently deleted:** Mailchimp blocks re-adding GDPR-deleted emails. You'd need to use a different address.",
            ].join('\n'),
            liveState: {
              email: input.email,
              exactMatches: 0,
              fuzzyMatches: 0,
              computedHash: hash,
            },
            nextToolSuggestions: [
              {
                tool: 'mailchimp_upsert_subscriber',
                reason: 'Create the subscriber if they should be here',
                suggestedInput: { email: input.email, status: 'pending' },
              },
            ],
          };
        }
        const top = exact[0] ?? fuzzy[0];
        if (!top) {
          throw ctx.fail('subscriber_search_no_usable_match', undefined, {
            email: input.email,
            ...ctx.recoveryFor('subscriber_search_no_usable_match'),
          });
        }
        const instructions = [
          `# Subscriber triage — \`${input.email}\``,
          '',
          `Found ${exact.length} exact and ${fuzzy.length} fuzzy matches. Working with the top match:`,
          `- **Audience:** \`${top.list_id}\``,
          `- **Status:** ${top.status}`,
          `- **Rating:** ${top.member_rating ?? '—'}/5`,
          top.timestamp_opt ? `- **Opted in:** ${top.timestamp_opt}` : '',
          top.last_changed ? `- **Last changed:** ${top.last_changed}` : '',
          '',
          '1. **Get the full record.** `mailchimp_find_subscriber` with this email (and optional audienceId) enriches with merge fields, stats, and full tag list.',
          '2. **See their activity.** `mailchimp_subscribers` `operation: list-activity` shows what campaigns they opened/clicked.',
          '3. **Review notes / tags.** `mailchimp_subscribers` `operation: list-notes` and `operation: list-tags`.',
          top.status === 'unsubscribed'
            ? "4. **They unsubscribed.** Do NOT resubscribe them without explicit new consent — Mailchimp enforces this. Use the audience's signup form to give them the choice."
            : top.status === 'cleaned'
              ? '4. **Cleaned (hard bounce).** Their email is dead. Do not retry.'
              : '4. **They are active.** Update merge fields / tags / status via `mailchimp_subscribers` `operation: update` or `mailchimp_upsert_subscriber`.',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          topic: 'subscriber-triage',
          instructions,
          liveState: {
            email: input.email,
            exactMatches: exact.length,
            fuzzyMatches: fuzzy.length,
            topMatch: {
              audienceId: top.list_id,
              subscriberId: top.id,
              status: top.status,
              memberRating: top.member_rating,
              lastChanged: top.last_changed,
            },
          },
          nextToolSuggestions: [
            {
              tool: 'mailchimp_find_subscriber',
              reason: 'Full record with tags, merge fields, stats',
              suggestedInput: {
                email: input.email,
                ...(input.audienceId ? { audienceId: input.audienceId } : {}),
              },
            },
            {
              tool: 'mailchimp_subscribers',
              reason: 'Recent activity (opens, clicks)',
              suggestedInput: {
                operation: 'list-activity',
                audienceId: top.list_id,
                email: input.email,
                count: 20,
              },
            },
          ],
        };
      }

      case 'design-campaign': {
        if (!input.audienceId) {
          throw validationError("'audienceId' is required for topic 'design-campaign'.");
        }
        const [audience, growth] = await Promise.all([
          svc.audiences.get(ctx, input.audienceId),
          svc.audiences
            .listGrowthHistory(ctx, input.audienceId, { count: 3 })
            .catch(() => ({ history: [], total_items: 0 })),
        ]);
        const memberCount = audience.stats?.member_count ?? 0;
        const open = audience.stats?.open_rate;
        const click = audience.stats?.click_rate;
        const recentNet = growth.history.reduce(
          (acc, h) => acc + (h.subscribed ?? 0) - (h.unsubscribed ?? 0),
          0,
        );
        const toneAdjustments: string[] = [];
        if (memberCount > 0 && memberCount < 25) {
          toneAdjustments.push(
            '- **Small list.** Write like a personal note, not a broadcast. Skip the big CTA panels; a single inline link is plenty.',
          );
        }
        if (memberCount >= 500) {
          toneAdjustments.push(
            '- **Large list.** Compose for the median reader, not the power fan. Keep the feature tight and the CTA obvious.',
          );
        }
        if (typeof open === 'number' && open < 0.15 && memberCount > 0) {
          toneAdjustments.push(
            `- **Low open rate (${PCT(open)}).** Subject line + from-name quality matter more than frequency. Write the subject last, make it concrete, avoid hype punctuation.`,
          );
        }
        if (typeof open === 'number' && open >= 0.25) {
          toneAdjustments.push(
            `- **Strong open rate (${PCT(open)}).** Readers trust the from-name; you can be a little more playful with the subject.`,
          );
        }
        if (recentNet > 0) {
          toneAdjustments.push(
            `- **Net growth (+${recentNet}) over the last 3 months.** Consider a one-line welcome to newer subscribers in the greeting.`,
          );
        }
        if (recentNet < 0) {
          toneAdjustments.push(
            `- **Shrinking list (${recentNet}).** Tone should feel earned, not urgent. Avoid sales language.`,
          );
        }
        const instructions = [
          `# Design playbook — "${audience.name}"`,
          '',
          `**Audience state:** ${memberCount} members, avg open ${PCT(open)}, avg click ${PCT(click)}, net growth (3mo): ${recentNet >= 0 ? '+' : ''}${recentNet}.`,
          '',
          'Design an editorial newsletter: warm, typographic, restrained. Full reference with worked examples lives at `docs/email-design-playbook.md`.',
          '',
          '## 1. Research the brand',
          'Before drafting, build a mental model of the source. Pull palette, voice, visual rhythm, subject-matter specifics, and the one-sentence mission. If the source is a website, `curl -sL https://r.jina.ai/<URL>` returns clean markdown.',
          '',
          '## 2. Palette (pick 4–6 hex values with roles)',
          '- **Primary brand** — masthead, section headers, footer, CTA bg',
          '- **Cream body bg** — NOT pure white (`#fbf8f0`-ish is warmer)',
          '- **Page bg** — slightly darker than body, for breathing room',
          '- **Accent** — one color for the CTA button / hairline bands',
          '- **Muted ink** — kicker labels, captions',
          '- **Body ink** — near-black, not pure black (`#2b2a26`)',
          '',
          '## 3. Typography',
          'Two families max. Georgia/Times for serif, system sans or Arial for sans. Body line-height 1.6–1.7, display headers 1.1–1.25. Scale: 11–13px kicker, 15–16px body, 22–26px headers, 34px masthead.',
          '',
          '## 4. Layout (email-safe HTML)',
          '- 600px max-width outer table, all styles inline',
          "- Tables for layout (Outlook uses Word's renderer — no flex/grid)",
          '- Every `<img>` has explicit `width`, `height`, `alt`, `display:block`, `border:0`',
          '- Preheader in a hidden `<div style="display:none;…">` at top of body',
          '- Section structure: masthead → greeting → feature → 2–4 supporting sections → highlighted block → CTA panel → sign-off → mission → contact footer',
          '',
          '## 5. Graphics via CDN (optional but effective)',
          'Inline SVG and base64 data URIs get stripped. The reliable path is hosted PNGs. Twemoji on jsDelivr is free, consistent, bubbly:',
          '```',
          'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/<codepoint>.png',
          '```',
          '6–8 placements max across a 600px email. Each should label a section, anchor warmth, or pun on content. curl-check each URL for 200 before sending.',
          '',
          '## 6. Subject & preview',
          '- **From name:** brand, ≤25 chars, monitored inbox',
          '- **Subject:** 40–60 chars, concrete nouns not adjectives, specific over generic',
          '- **Preview text:** ~90 chars, extends the subject instead of repeating it',
          '- Write these *last*, after the content is settled',
          '',
          '## 7. Personalization',
          'Use merge tags with graceful fallbacks: `*|FNAME:friend|*` — not bare `*|FNAME|*`, which renders as empty string when missing.',
          '',
          toneAdjustments.length > 0
            ? ['## 8. Tailored for this audience', ...toneAdjustments].join('\n')
            : '',
          '',
          '## Workflow',
          '1. Research source → extract palette, voice, mission',
          '2. Outline sections and write copy',
          '3. Build HTML (600px table, inline styles)',
          '4. Curl-check any CDN image URLs',
          '5. `mailchimp_send_campaign` `mode: draft` → review `checklistWarnings`',
          '6. `mode: test` → proofread the rendered output (iOS + Gmail web minimum)',
          '7. `mode: send` (elicits confirmation on HITL clients)',
          '8. After ~24h: `mailchimp_playbook` `topic: post-send-review`',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          topic: 'design-campaign',
          instructions,
          liveState: {
            audienceId: audience.id,
            audienceName: audience.name,
            memberCount,
            openRate: open,
            clickRate: click,
            recentNetGrowth: recentNet,
            toneAdjustmentCount: toneAdjustments.length,
          },
          nextToolSuggestions: [
            {
              tool: 'mailchimp_audience_overview',
              reason: 'Refresh audience state (growth, clients, merge-field schema)',
              suggestedInput: { audienceId: audience.id },
            },
            {
              tool: 'mailchimp_templates',
              reason: 'Browse saved templates before drafting from scratch',
              suggestedInput: { operation: 'list', type: 'user' },
            },
            {
              tool: 'mailchimp_send_campaign',
              reason: 'Start the draft once design is settled',
              suggestedInput: { audienceId: audience.id, mode: 'draft' },
            },
          ],
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`_Topic: ${result.topic}_`, '', result.instructions, ''];
    if (Object.keys(result.liveState).length > 0) {
      lines.push('', '## Live state', '```json', JSON.stringify(result.liveState, null, 2), '```');
    }
    if (result.nextToolSuggestions.length > 0) {
      lines.push('', '## Suggested next calls', '');
      for (const s of result.nextToolSuggestions) {
        lines.push(`- **\`${s.tool}\`** — ${s.reason}`);
        if (s.suggestedInput && Object.keys(s.suggestedInput).length > 0) {
          lines.push(`  \`\`\`json`);
          lines.push(`  ${JSON.stringify(s.suggestedInput)}`);
          lines.push(`  \`\`\``);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
