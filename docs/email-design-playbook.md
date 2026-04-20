# Email Design Playbook

A reference for composing campaigns that feel editorial rather than templated. Distilled from a worked community-garden newsletter and generalized for reuse.

The goal is simple: emails should feel like they were written for the reader, typeset with intent, and illustrated only where an image earns its place. Everything below is in service of that.

---

## 1. Research the brand before you write

Before drafting a single line of HTML, spend a few minutes building a mental model of the source:

| Signal | What to extract |
|:-------|:----------------|
| **Palette** | Dominant colors, accent colors, backgrounds. Usually 4–5 total. |
| **Voice** | Casual vs. formal, first-person vs. institutional, warm vs. clinical. |
| **Visual rhythm** | Dense or airy? Serif or sans? Decorative or utilitarian? |
| **Subject-matter specifics** | Location, season, recurring themes, inside references, proper nouns. |
| **Mission line** | One-sentence statement of what the org exists to do. This usually anchors the footer. |

If the source is a website, `curl -sL https://r.jina.ai/<URL>` returns clean markdown — faster and lossless compared to scraping or summary tools.

---

## 2. Palette discipline

Pick a small, purposeful palette and commit to it. Four to six hex values, with clear roles.

An example garden-newsletter palette:

| Role | Hex | Used for |
|:-----|:----|:---------|
| Primary brand | `#2d4a22` | Masthead band, footer band, section headers, CTA backgrounds |
| Cream background | `#fbf8f0` | Card body — easier on the eye than pure white, warmer |
| Page background | `#f4efe4` | The space around the card, breathing room |
| Accent (CTA) | `#c84b31` | Button, hairline band under masthead — draws the click |
| Warm panel | `#f0e9d2` | Highlighted info block (planting almanac box) |
| Muted ink | `#6b5d3a` / `#8a6f3e` | Kicker labels, captions, secondary text |
| Body ink | `#2b2a26` | Near-black, not pure black — warmer on cream |

**Rules of thumb:**

- Pure `#000000` on cream looks harsh. Use `#2b2a26` or `#1f1e1a`.
- Pure `#ffffff` as background is cold. Warm creams (`#fbf8f0`, `#f9f5ea`) feel hand-set.
- One accent color only. Two accents compete.
- The same green appears in masthead, section headers, and footer — this creates visual coherence across 600px of scroll.

---

## 3. Typography

Two families at most. Usually one is enough.

Web-safe serifs (Georgia, Times New Roman) and sans-serifs (Arial, Helvetica, `-apple-system`) render everywhere. Custom fonts via `@import` work in Apple Mail and iOS but not Outlook or Gmail webmail — don't rely on them.

An example scale for an editorial newsletter:

| Role | Size | Weight |
|:-----|:-----|:-------|
| Masthead title | 34px | normal |
| Section header (`h2`) | 26px | normal |
| Community item bold line | 17px | bold |
| Body copy | 15–16px | normal |
| Kicker label (small caps) | 11–13px, letter-spacing 2–3px | normal or bold |
| Footer / caption | 12–13px | normal, often italic |

**Line-height** matters more than font choice. For body copy, `1.6–1.7` is the comfort range. For display headers, `1.1–1.25`.

---

## 4. Section scaffolding

An editorial newsletter reads top-to-bottom like a short magazine. A dependable structure:

1. **Masthead** — the publication's identity. Volume/issue, wordmark, tagline. Dense with meta, bold with typography.
2. **Greeting** — personalized (`*|FNAME|*`), warm, sets the issue's tone in 2–3 sentences.
3. **Feature** — the single most important thing this month. Give it room.
4. **Supporting sections** — two to four, each with a kicker label in small caps, a serif header, and a short body.
5. **Highlighted block** — one visually distinct card (colored background, colored left border) for the month's most reusable reference.
6. **CTA block** — dark inverted panel with one action. One, not five.
7. **Sign-off** — first person, human. "See you in the rows" beats "Best regards."
8. **Mission footer** — one italic sentence. Reminds the reader why you're in their inbox.
9. **Contact footer** — address, social links, memorial/credit line.

The Mailchimp auto-footer (unsubscribe, list address) appends after the mission footer automatically — don't duplicate it.

---

## 5. Email-safe HTML

Email is HTML 4.01 with extra constraints. The rules that matter:

| Rule | Why |
|:-----|:----|
| **Use tables for layout** | Outlook uses Word's rendering engine; flexbox and grid don't work. |
| **Inline every style** | Most clients strip `<style>` blocks. Styles in `style="…"` survive. |
| **Max width 600px** | Historical standard, still the safest for Outlook desktop. |
| **Explicit `width` and `height` on `<img>`** | Outlook ignores CSS-only sizing. Both attribute and inline style. |
| **`display:block` on images** | Prevents phantom whitespace under images in Gmail. |
| **`border="0"`, `outline:0` on `<img>`** | Some old clients outline linked images. |
| **Avoid background images** | Outlook renders them inconsistently. A solid fill is safer. |
| **Avoid inline SVG** | Gmail strips it; Outlook can't render it. |
| **Avoid `position:absolute` / `float`** | Unreliable. Use table cells. |
| **Use `<div style="display:none; …">` for preheader text** | Shows in the inbox preview, hidden in the body. |
| **Use `&mdash;`, `&amp;`, numeric entities** | Safer than raw Unicode punctuation across old clients. |
| **Hairlines via `<td style="height:4px;line-height:4px;font-size:0;">&nbsp;</td>`** | A 1–4px colored band across the design. More reliable than `<hr>`. |
| **Dividers via `<div style="border-top:1px solid #…">`** inside a padded `<td>` | Safer than `<hr>` which varies wildly across clients. |

The 600px outer table should be centered with `<table align="center">` at the top, not CSS margins.

---

## 6. Graphics via CDN (the bubbly bunny pattern)

**The problem.** Email clients strip inline SVG. They often strip base64 data URIs too. They frequently block external images by default. So the only reliable way to ship cute graphics is hosted PNGs on a public CDN.

**The solution.** Twemoji (Twitter's emoji artwork) is free, consistent, rounded/bubbly, covers every Unicode emoji codepoint, and is hosted on jsDelivr. The repo moved to `jdecked/twemoji` after Twitter archived the original.

URL pattern:

```
https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/<codepoint>.png
```

Where `<codepoint>` is the lowercase hex of the Unicode emoji — e.g. `1f430` for 🐰, `1f955` for 🥕, `1f331` for 🌱, `1f33b` for 🌻, `1f345` for 🍅, `1f41d` for 🐝, `1f98b` for 🦋.

**Before committing an email, curl-check each URL** to confirm a 200:

```bash
for cp in 1f430 1f955 1f331 1f33b 1f345 1f41d 1f98b 1f33c; do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${cp}.png")
  echo "${cp}: ${code}"
done
```

**Embed pattern.** Always specify `width`/`height` as both attributes and inline style, plus `display:block` (or `display:inline-block` for inline icons):

```html
<img
  src="https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f430.png"
  width="72"
  height="72"
  alt="bunny"
  style="display:block;border:0;outline:0;"
/>
```

For icons inline with text, use `vertical-align:-4px` (or `-5px` at 22px, `-3px` at 16px) to align the glyph's visual center with the baseline:

```html
<img src="…/1f331.png" width="18" height="18" alt=""
     style="display:inline-block;border:0;outline:0;vertical-align:-4px;margin-right:8px;">
Direct Sow Outdoors
```

**Placement philosophy.** Six to eight placements across a 600px email is plenty. More than that and the email reads as an emoji collage. Each graphic should either:

1. **Label** a section (the seedling/carrot/tomato next to "Direct Sow"/"Transplant"/"Start Indoors")
2. **Anchor** a moment of warmth (the 72px bunny beside the greeting)
3. **Pun** on literal content (the actual sunflower next to "The Sunflower Library")

If it does none of those, cut it.

**Fallback.** Because images may be blocked, the text layout has to stand on its own. Never put critical information inside an image.

### When you need custom artwork

- **Mailchimp Content Studio** — upload to Mailchimp, get a stable `mcusercontent.com` URL, reference via `<img>`. Best for branded illustrations reused across issues.
- **Your own CDN** (S3, Cloudflare R2, GitHub raw via jsDelivr) — works the same, with serving under your control.
- **Hand-drawn PNGs at 2× intended display size** — keep them crisp on retina. Declare display size via `width`/`height`.

Avoid: GIFs larger than ~500KB, animated formats in Outlook (shows first frame only), webp (spotty client support — use PNG).

---

## 7. Subject line & preview text

Three lines of copy decide whether the email gets opened. Write them last, after the content is settled.

| Field | Length budget | Goal |
|:------|:--------------|:-----|
| **From name** | ≤25 chars | The name a reader trusts — brand, not person, unless the brand is personal. |
| **Subject** | ~40–60 chars visible on mobile | Concrete, curious, not hype-y. Specific nouns beat adjectives. |
| **Preview text** | ~90 chars | Extends the subject instead of repeating it. Written in `<div style="display:none; …">` at the top of the body. |

Good subject patterns (garden-newsletter examples):

- *"This Month in the Garden — peas are up, and the blackberry is waking"* (concrete, seasonal, specific)
- *"April in the Garden — a bunny, some carrots, and your planting list"* (playful, promises utility)

Bad subject patterns:

- *"Newsletter — April 2026"* (no content promise)
- *"🚨 OPEN NOW: Huge announcements!!!"* (triggers spam filters, breaks trust)

Never repeat the subject verbatim in the body's opening line. The reader already read it.

---

## 8. Personalization

Use Mailchimp merge tags for low-effort, high-impact personalization:

| Tag | Yields |
|:----|:-------|
| `*|FNAME|*` | First name (often empty — write a fallback-aware greeting) |
| `*|LNAME|*` | Last name |
| `*|EMAIL|*` | Subscriber email |
| `*|LIST:COMPANY|*` | Audience company name — useful in signatures |
| `*|DATE:Y|*` | Current year — useful in copyright lines |

Handle empty names gracefully. `"Hello, *|FNAME|*,"` reads as `"Hello, ,"` when the first name is missing. Either set a merge-field default in Mailchimp (`*|FNAME:there|*`) or start the greeting with the name integrated:

```
Hello *|FNAME|*,  →  better: "Hi *|FNAME:friend|*,"
```

---

## 9. Accessibility

Email accessibility is usually an afterthought. Don't make it one.

- **Alt text** on every meaningful image. Decorative graphics can use `alt=""` — screen readers will skip them. Meaningful illustrations get a short description (`alt="bunny"`).
- **Contrast ratio ≥4.5:1** for body text against its background. The example palette: body `#2b2a26` on `#fbf8f0` cream is 13.7:1. Muted text `#6b5d3a` on `#fbf8f0` is 5.4:1. Both pass.
- **Linked text should be descriptive.** "Request a Plot ›" not "Click here."
- **Underline or color + weight** for links. Color alone can fail for colorblind readers.
- **Semantic HTML** when possible — `<h1>`, `<h2>`, `<p>` — even if you style them inline. Screen readers use the tags.

---

## 10. Sending discipline

Before `mode: 'send'`:

1. **Draft first.** `mailchimp_send_campaign` with `mode: 'draft'` to run the send-checklist without dispatching.
2. **Test send.** `mode: 'test'` with your own address in `testEmails`. Open on iOS, Gmail web, and desktop Outlook if possible.
3. **Proofread the rendered copy**, not the source. Missing merge tags, broken links, and awkward spacing are obvious in rendered view.
4. **Send.** On a human-in-the-loop client, Mailchimp's tool will prompt for confirmation via `ctx.elicit` — decline to downgrade back to draft.
5. **Review after.** Wait ~24 hours, then call `mailchimp_playbook` with `topic: 'post-send-review'` and the campaign ID.

Free-plan note: scheduling is gated behind paid plans. On free, only `draft`, `test`, and immediate `send` work.

---

## 11. Checklist

Before sending:

- [ ] Palette is 4–6 hex values with defined roles
- [ ] Two type families max, with a defined scale
- [ ] 600px max-width outer table, all styles inline
- [ ] Preview text in a hidden `<div>` at the top of the body
- [ ] Every `<img>` has explicit `width`, `height`, `alt`, `display:block` or `display:inline-block`, `border:0`
- [ ] Image URLs curl-checked (all 200)
- [ ] Layout works with images blocked (text-only fallback reads fine)
- [ ] Merge tags with graceful fallback for missing values (`*|FNAME:friend|*`)
- [ ] Subject + preview text written last, specific and non-repetitive
- [ ] From name is the brand, reply-to is monitored
- [ ] Tested on at least two clients (iOS Mail + Gmail web is a good minimum)
- [ ] Contrast ratio ≥4.5:1 for body text
- [ ] Mailchimp send-checklist has zero `error` items

---

## Appendix A: Twemoji codepoints for garden/food themes

| Emoji | Codepoint | URL path |
|:------|:----------|:---------|
| 🐰 rabbit face | `1f430` | `…/72x72/1f430.png` |
| 🥕 carrot | `1f955` | `…/72x72/1f955.png` |
| 🌱 seedling | `1f331` | `…/72x72/1f331.png` |
| 🌻 sunflower | `1f33b` | `…/72x72/1f33b.png` |
| 🌷 tulip | `1f337` | `…/72x72/1f337.png` |
| 🌸 cherry blossom | `1f338` | `…/72x72/1f338.png` |
| 🌼 blossom | `1f33c` | `…/72x72/1f33c.png` |
| 🌿 herb | `1f33f` | `…/72x72/1f33f.png` |
| 🌾 sheaf of rice | `1f33e` | `…/72x72/1f33e.png` |
| 🍅 tomato | `1f345` | `…/72x72/1f345.png` |
| 🥬 leafy greens | `1f96c` | `…/72x72/1f96c.png` |
| 🥦 broccoli | `1f966` | `…/72x72/1f966.png` |
| 🫐 blueberry | `1fad0` | `…/72x72/1fad0.png` |
| 🍎 red apple | `1f34e` | `…/72x72/1f34e.png` |
| 🐝 honeybee | `1f41d` | `…/72x72/1f41d.png` |
| 🦋 butterfly | `1f98b` | `…/72x72/1f98b.png` |
| 🐞 ladybug | `1f41e` | `…/72x72/1f41e.png` |

Full codepoint lookup: <https://unicode.org/emoji/charts/full-emoji-list.html>

## Appendix B: The worked example

The garden-newsletter example that seeded this doc was composed via `mailchimp_send_campaign` against a one-subscriber test audience. The illustrated revision adds eight Twemoji placements: masthead corner cluster, hero bunny, three planting-category labels, one poetic match (sunflower next to a seed-library section), a pollinator bee, and a trailing sign-off bunny.
