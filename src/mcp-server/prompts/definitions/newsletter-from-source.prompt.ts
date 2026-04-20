/**
 * @fileoverview `newsletter_from_source` prompt — user-invokable starter that
 * briefs the agent to compose a monthly editorial newsletter from a source URL
 * or free-form description. Chains into `mailchimp_playbook` (`topic:
 * design-campaign`) for live audience-aware design guidance, then walks the
 * draft → test → send flow via `mailchimp_send_campaign`.
 * @module mcp-server/prompts/definitions/newsletter-from-source.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

const ArgsSchema = z.object({
  source: z
    .string()
    .describe(
      "Source material for the newsletter. Either a URL (e.g. the organization's website) that the agent will fetch, or a free-form brief describing the content and context.",
    ),
  audienceId: z
    .string()
    .optional()
    .describe(
      'Mailchimp audience ID to target. If provided, the `design-campaign` playbook will fold in live engagement state to tune tone, CTA weight, and copy.',
    ),
  seasonalContext: z
    .string()
    .optional()
    .describe(
      'Optional seasonal or monthly theme (e.g. "April spring planting", "Q4 year-in-review", "back-to-school"). Shapes copy, subject line, and graphics.',
    ),
});

export const newsletterFromSourcePrompt = prompt('newsletter_from_source', {
  description:
    "Compose a monthly editorial newsletter from a source URL or brief. The agent fetches the source, calls the `design-campaign` playbook with live audience state, drafts HTML using the server's editorial design conventions, and walks the send via draft → test → send. Full design reference lives at `docs/email-design-playbook.md`.",
  args: ArgsSchema,
  generate: (args) => {
    const audienceLine = args.audienceId
      ? `The target audience is \`${args.audienceId}\`. Pass this to every tool call that needs an audience ID.`
      : "The target audience is not specified — confirm with the user before sending, or use the account's primary audience if there is only one (check with `mailchimp_audiences` `operation: list`).";
    const seasonLine = args.seasonalContext
      ? `\n\n**Seasonal / thematic context:** ${args.seasonalContext}. Reflect this in copy, subject line, and any illustrations.`
      : '';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Compose a monthly editorial newsletter based on the following source:',
            '',
            `**Source:** ${args.source}${seasonLine}`,
            '',
            audienceLine,
            '',
            '**Workflow:**',
            '',
            '1. **Research the source.** If the source is a URL, fetch it with `curl -sL https://r.jina.ai/<URL>` (returns clean markdown — lossless compared to WebFetch summaries). Extract: palette, voice, visual rhythm, subject-matter specifics (location, season, proper nouns), and the one-sentence mission.',
            '',
            `2. **Get design guidance.** Call \`mailchimp_playbook\` with \`topic: 'design-campaign'\`${args.audienceId ? ` and \`audienceId: '${args.audienceId}'\`` : ' (with the audience ID once confirmed)'} to get design conventions merged with live audience engagement state.`,
            '',
            '3. **Compose the HTML.** Follow the editorial patterns from `docs/email-design-playbook.md`:',
            '   - 4–6 color palette with defined roles (primary brand, cream body bg, page bg, accent, muted ink, body ink — avoid pure white and pure black)',
            '   - 2 font families max (Georgia + system sans is a safe default), with a size scale',
            '   - 600px outer table, every style inline, table-based layout (no flex/grid — Outlook uses Word renderer)',
            '   - Section flow: masthead → greeting (`*|FNAME:friend|*` with fallback) → feature → 2–4 supporting sections → highlighted block → CTA panel → sign-off → mission → contact footer',
            '   - Preheader text in a hidden `<div style="display:none;max-height:0;overflow:hidden;opacity:0;…">` at the top of the body',
            '',
            '4. **Add graphics (optional but effective).** 6–8 Twemoji placements max via jsDelivr:',
            '   ```',
            '   https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/<codepoint>.png',
            '   ```',
            '   Each placement should label a section, anchor warmth, or pun on content — not decorate aimlessly. curl-check each URL for a 200 before embedding. Every `<img>` needs explicit `width`, `height`, `alt`, `display:block` (or `inline-block` for inline icons), `border:0`.',
            '',
            "5. **Draft and validate.** `mailchimp_send_campaign` with `mode: 'draft'` to create the campaign and run the send-checklist. Fix any `error` items in `checklistWarnings`.",
            '',
            "6. **Test send.** Re-run with `mode: 'test'` and the user's email in `testEmails` to proofread the rendered output. iOS Mail + Gmail web is a good minimum review pair.",
            '',
            "7. **Send.** `mode: 'send'`. The workflow tool will elicit confirmation on human-in-the-loop clients — decline downgrades it back to draft safely.",
            '',
            "8. **Review after ~24h.** `mailchimp_playbook` with `topic: 'post-send-review'` and the returned `campaignId` for the tailored results digest (opens, clicks, abuse, industry benchmarks).",
            '',
            '**Discipline:**',
            '- Write the subject line and preview text *last*, after the content is settled. Subject: 40–60 chars, concrete nouns, no hype punctuation. Preview: ~90 chars that extends the subject, not repeats it.',
            '- From-name is the brand (≤25 chars), reply-to is a monitored address.',
            '- Layout must still read well with images blocked — never put critical information inside an image.',
            '- Use merge tags with graceful fallbacks: `*|FNAME:friend|*`, not bare `*|FNAME|*`.',
          ].join('\n'),
        },
      },
    ];
  },
});
