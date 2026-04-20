# mailchimp-mcp-server — Design

## MCP Surface

### Tools (17)

**Workflow tools** (7) — multi-step orchestration for common end-to-end tasks:

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `mailchimp_send_campaign` | Compose and send (or schedule/test) a campaign in one call: create the campaign, set content, run send-checklist, optionally send a test, then send or schedule. Aborted drafts are auto-deleted when `cleanupOnError: true` (default). Requests human confirmation via `ctx.elicit` on `mode: 'send' \| 'schedule'` when the client supports elicitation. | `audienceId`, `subject`, `fromName`, `replyTo`, `content` (html \| plaintext \| templateId+mergeData), `segmentId?`, `mode` (`draft`\|`test`\|`send`\|`schedule`), `scheduleTime?`, `testEmails?`, `cleanupOnError?` (default `true`) | `destructiveHint: true` (when mode=send/schedule), `openWorldHint: true` |
| `mailchimp_replicate_campaign` | Duplicate an existing campaign, optionally override subject/content/recipients, then send or leave as draft. Same elicitation + cleanup semantics as `send_campaign`. | `sourceCampaignId`, `subjectOverride?`, `fromNameOverride?`, `contentOverride?`, `audienceOverride?`, `segmentOverride?`, `mode`, `scheduleTime?`, `testEmails?`, `cleanupOnError?` | `destructiveHint: true` (when mode=send/schedule), `openWorldHint: true` |
| `mailchimp_upsert_subscriber` | Add or update a subscriber with status, merge fields, tags, and optional note in a single idempotent call. Uses PUT /members/{hash} + tag sync. `status: 'pending'` triggers Mailchimp's double-opt-in flow (user must click the confirmation email) — use `'subscribed'` for immediate opt-in. | `audienceId`, `email`, `status` (`subscribed`\|`unsubscribed`\|`cleaned`\|`pending`\|`transactional`), `mergeFields?`, `tags?`, `note?`, `vip?`, `language?` | `idempotentHint: true` |
| `mailchimp_import_subscribers` | Batch add/update subscribers via POST /lists/{id}, returns per-row succeeded/failed with reasons. **Status defaults to `pending`** (double-opt-in) to prevent accidental mass-sends; set `status: 'subscribed'` explicitly to import as already-opted-in. Capped at 500 per call. | `audienceId`, `subscribers[]` (≤500), `status?` (default `'pending'`), `updateExisting?`, `skipMergeValidation?` | `openWorldHint: true` |
| `mailchimp_find_subscriber` | Search for a subscriber by email across one or all audiences. Wraps `/search-members` and enriches with member detail + tags + last activity. | `email`, `audienceId?` | `readOnlyHint: true` |
| `mailchimp_campaign_report` | Aggregated post-send analytics for one campaign: headline stats, top clicked links, open timeline, top locations, unsubscribes, abuse reports. | `campaignId`, `includeTopN?` (default 10) | `readOnlyHint: true` |
| `mailchimp_audience_overview` | Audience health digest: info, stats, last 12 months of growth history, top email clients, merge-field schema, recent activity. | `audienceId` | `readOnlyHint: true` |

**Instruction tool** (1) — returns procedural guidance merged with live account state (no writes):

| Name | Description | Input | Annotations |
|:-----|:------------|:------|:------------|
| `mailchimp_playbook` | Returns a structured procedural playbook merged with live account state. Use at the start of a complex task (sending a campaign, post-send review, diagnosing deliverability, cleaning up a list, onboarding, triaging a subscriber issue) to get a tailored walkthrough. Advice-only — the agent executes subsequent steps using other tools. Returns markdown instructions + live state snapshot + `nextToolSuggestions`. | `topic`: `send` \| `post-send-review` \| `deliverability` \| `list-hygiene` \| `onboarding` \| `subscriber-triage`; `audienceId?`, `campaignId?`, `email?` (required per topic) | `readOnlyHint: true` |

**Primitive tools** (9) — fine-grained CRUD, consolidated by noun via `operation` enum:

| Name | Description | Operation enum | Annotations |
|:-----|:------------|:--------------|:------------|
| `mailchimp_account` | Account info + Chimp Chatter activity stream. (Startup validation already pings — no `ping` op exposed to agents.) | `info`, `activity-feed` | `readOnlyHint: true` |
| `mailchimp_audiences` | Audience read + create/update, audience-level analytics, and signup-form configuration. **No delete** — on free-tier (1-audience cap) delete is catastrophic; humans do it in the Mailchimp UI. | `list`, `get`, `create`, `update`, `list-activity`, `list-growth`, `list-clients`, `list-abuse-reports`, `list-locations`, `get-signup-forms`, `customize-signup-forms` | `openWorldHint: true` |
| `mailchimp_subscribers` | Subscriber read + update, tags, notes, activity, events, goals. **`archive` is the strongest delete** — removes from active list but preserves the record so the email can be resubscribed. No `delete-permanent` (GDPR-forget is irreversible and un-resubscribable). Upsert lives in the workflow tool. | `list`, `get`, `update`, `archive`, `list-tags`, `set-tags`, `list-notes`, `add-note`, `update-note`, `delete-note`, `list-activity`, `list-events`, `list-goals` | `openWorldHint: true` |
| `mailchimp_segments` | Segment CRUD and member assignment. `batch-update-members` can add/remove many subscribers in one call — use deliberately. Static and saved segments; conditions are free-tier, advanced dynamic filters require Premium. | `list`, `get`, `create`, `update`, `delete`, `list-members`, `batch-update-members` | `openWorldHint: true` |
| `mailchimp_merge_fields` | Custom subscriber-attribute (merge field) read + create/update. **No delete** — deleting a merge field removes the column-worth of data from every subscriber. Humans do it in the Mailchimp UI. | `list`, `get`, `create`, `update` | `openWorldHint: true` |
| `mailchimp_campaigns` | Campaign read + create/update + non-send actions. **No delete** — deleting a sent campaign destroys historical reports; pre-send cancellation is covered by `cancel-send`. Send/test/schedule/replicate+send live in the workflow tools. | `list`, `get`, `create`, `update`, `replicate`, `get-content`, `set-content`, `get-checklist`, `cancel-send`, `create-resend`, `pause-rss`, `resume-rss` | `openWorldHint: true` |
| `mailchimp_reports` | Campaign report slices. For the common at-a-glance digest, use `mailchimp_campaign_report` instead. | `list`, `get`, `slice` (+ `dimension`: `abuse-reports` \| `advice` \| `click-details` \| `open-details` \| `domain-performance` \| `eepurl` \| `email-activity` \| `locations` \| `sent-to` \| `unsubscribed`; + optional `subscriberHash` or `linkId` for drill-down) | `readOnlyHint: true` |
| `mailchimp_templates` | Template CRUD. Free plan has access to basic templates only. | `list`, `get`, `create`, `update`, `delete`, `get-default-content` | `openWorldHint: true` |
| `mailchimp_search` | Global search across members or campaigns. | `members`, `campaigns` | `readOnlyHint: true` |

### Resources (4)

Supplementary — all data is also reachable via tools. Stable URIs for capable clients.

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `mailchimp://account` | Account info + data center + ping timestamp. | no |
| `mailchimp://audiences/{audienceId}` | Audience snapshot (name, stats, config). | no |
| `mailchimp://campaigns/{campaignId}` | Campaign snapshot (status, settings, recipients summary). | no |
| `mailchimp://campaigns/{campaignId}/report` | Campaign report snapshot (headline metrics). | no |

Lists themselves (`mailchimp://audiences`, `mailchimp://campaigns`) are not exposed as resources — use the `list` operation on the corresponding tool. Mailchimp pagination is `count`/`offset` which doesn't map cleanly to resource cursors for large collections.

### Prompts (0)

None in v1. Candidates for a later iteration:

- `analyze_campaign_performance` — structured analysis of a `mailchimp_campaign_report` output.
- `compose_newsletter` — newsletter draft scaffold (topic, audience tone, section outline).

Skipped because the tool surface already covers the common flows and prompts add ceremony without earning their keep yet.

---

## Overview

An MCP server that wraps the [Mailchimp Marketing API v3.0](https://mailchimp.com/developer/marketing/api/) so an LLM agent can manage audiences, subscribers, campaigns, templates, and reports against a Mailchimp account. Design prioritizes **free-plan** capabilities (250 contacts, 1 audience, 500 emails/month) — all workflow tools complete end-to-end on a free account, and primitive tools surface paid-feature errors with recovery hints rather than failing opaquely.

**Target users.** Developers and solo operators on the Mailchimp free plan who want an LLM agent to draft and send newsletters, manage a subscriber list, and review campaign performance without clicking through the UI. Also usable on paid plans — everything on free works on paid, plus paid-gated endpoints (`automations`, `ecommerce`, `customer-journeys`) are intentionally omitted from v1.

**Lean by design.** v1 covers the tasks agents actually repeat — send newsletters, manage subscribers, review performance. Low-frequency UI organization (folders, file manager, landing pages), one-time integration setup (webhooks), niche features (interest-category groups), and truly catastrophic operations (delete audience / permanent delete subscriber / delete sent campaign) are intentionally excluded. Easier to add when demand emerges than to remove.

**What's explicitly out of scope for v1:**

*Paid-plan features (not accessible on free):*
- Automations (`/automations/**`, 18 endpoints) — Standard plan required.
- Customer journeys (`/customer-journeys/**`) — Standard plan.
- E-commerce stores/orders/products (`/ecommerce/**`, 60 endpoints).
- Facebook ads reporting (`/reporting/facebook-ads/**`).
- Surveys (`/lists/*/surveys`, `/reporting/surveys/**`).
- Transactional email (Mandrill) — separate API with its own base URL and auth.
- A/B split / variate campaigns — `type: 'regular' \| 'plaintext' \| 'rss'` only.

*Low-signal for agent workflows (free but excluded):*
- Campaign / template folders (`/campaign-folders`, `/template-folders`) — UI ceremony; agents use IDs.
- File manager (`/file-manager/**`) — humans upload assets; agents inline or link.
- Landing pages (`/landing-pages/**`) — off-domain (web, not email), free-tier limited.
- Per-audience webhooks (`/lists/{id}/webhooks`) — one-time integration setup, not a recurring agent task.
- Interest-category groups (`/lists/{id}/interest-categories/**`) — niche opt-in feature; most free accounts don't use.

*Irreversible / admin operations (never expose to agent):*
- Audience deletion — catastrophic on 1-audience free plan.
- Subscriber permanent deletion (GDPR forget) — un-resubscribable.
- Campaign deletion — destroys historical reports.
- Merge field deletion — column-level data loss.

*Infra / admin:* connected sites, verified domains, batch webhooks (distinct from per-audience webhooks), `/batches` async runner, account exports, authorized apps, campaign feedback, conversations.

---

## Requirements

- Authenticate with a single Mailchimp API key (basic auth, username is any string, password is the key). Data center (`us1` … `us22`) parsed from the `-dc` suffix.
- Validate the API key at startup by issuing `GET /ping` — fail fast with `ConfigurationError` rather than surfacing auth failures on the first tool call.
- Support Free-plan operations across: audiences (read/create/update + analytics + signup forms), subscribers (read/update + tags/notes + activity), segments, merge fields (read/create/update), campaigns (regular/plaintext/rss, no delete), templates, reports, search.
- Expose workflow tools for the seven highest-frequency tasks (send campaign, replicate campaign, upsert/import/find subscribers, campaign report digest, audience overview), an instruction tool (`mailchimp_playbook`) for state-aware procedural guidance on complex multi-step tasks, and primitive tools for everything else.
- Gate destructive workflow operations (`mailchimp_send_campaign`/`mailchimp_replicate_campaign` with `mode: 'send' \| 'schedule'`) behind `ctx.elicit` confirmation when the client supports it.
- Default `mailchimp_import_subscribers` to `status: 'pending'` (double-opt-in) to prevent accidental mass-sends.
- Respect Mailchimp rate limits: ≤10 concurrent requests per account; backoff on 429 with `Retry-After` honored. Cap workflow-tool parallelism below the account limit to leave headroom for concurrent agent/UI sessions.
- 60-second per-request timeout (Mailchimp server-side is 120s; we fail fast earlier).
- No persistent state — all reads/writes go directly to Mailchimp.
- Secrets only via env var (`MAILCHIMP_API_KEY`).

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `MailchimpService` | Mailchimp Marketing API v3.0 (`https://{dc}.api.mailchimp.com/3.0/`). Handles DC resolution from key, basic auth header, retry/backoff via `withRetry`, 429 + `Retry-After`, timeout → `ServiceUnavailable`, 404 → `NotFound`, upstream validation → `ValidationError`, paid-feature 403 enrichment. | All tools — every tool makes at least one upstream request. |

The service exposes typed methods per endpoint group (`audiences.list`, `subscribers.upsert`, `campaigns.create`, `reports.get`, `reports.slice`, ...). Note: the service layer may internally call endpoints that aren't exposed as tools (e.g. interest-category lookups to resolve names inside `upsert_subscriber`, or webhook checks). Each method calls `withRetry` with calibrated backoff (base 500ms for general transient errors, base 2s when upstream returns 429 without a `Retry-After`, respect header when present).

Workflow tools that parallelize upstream calls use a shared `p-limit`-style semaphore capped at `MAILCHIMP_CONCURRENCY_LIMIT` (default 4), leaving headroom under Mailchimp's 10-concurrent account cap for other agent or UI sessions sharing the same key.

**Startup validation.** Registered in `createApp()`'s `setup()` — parses `MAILCHIMP_API_KEY`, extracts DC, and issues a `/ping` with a 10-second timeout. Auth failures throw `ConfigurationError` naming the env var; network failures are logged as warnings and the server starts anyway (Mailchimp outages shouldn't block startup).

**Elicit-guarded destructive ops.** `mailchimp_send_campaign` and `mailchimp_replicate_campaign`, when `mode` is `'send'` or `'schedule'`, check `ctx.elicit` and prompt for confirmation (`"Send campaign 'X' to N recipients?"`). On `reject` → short-circuit to `mode: 'draft'` and return with a `cancelledByUser: true` flag so the agent sees what happened. When `ctx.elicit` is absent (e.g. headless/stdio without a human), the tool proceeds — the `destructiveHint` annotation is the only signal, and it's up to the orchestrating agent's policy.

**Resilience calibration:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Service method wraps fetch + JSON parse. `withRetry` from framework. |
| Backoff | 500ms base for transient, honor `Retry-After` on 429, 2s base if 429 without header. Max 3 attempts. |
| Parse classification | Non-JSON HTML responses (e.g. upstream maintenance page) → `ServiceUnavailable`, not `SerializationError`. |
| Timeout | 60s per request via `fetchWithTimeout`. |
| Auth failure | 401 → `Unauthorized`, message names the env var to fix. |
| Paid feature | 403 with Mailchimp's "This feature is only available to paid accounts" → wrap as `Forbidden` with `{ requiresPlan: 'standard' \| 'premium' }` in error data. |
| Workflow cancellation | `ctx.signal` propagates through every upstream call. Multi-step workflows that have created mutable state (e.g., a campaign draft in `send_campaign`) honor `cleanupOnError` — default `true` — and delete the orphan on abort or mid-flow failure. |

---

## Config

Defined in `src/config/server-config.ts` as a separate Zod schema (lazy-parsed, never merged with framework core config).

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `MAILCHIMP_API_KEY` | yes | — | Mailchimp Marketing API key, including `-dc` suffix (e.g. `abc123…xyz-us22`). Generate in Mailchimp → Account → Extras → API keys. Manager permissions required. |
| `MAILCHIMP_BASE_URL` | no | `https://{dc}.api.mailchimp.com/3.0` | Override for mock servers / tests. `{dc}` parsed from the API key. |
| `MAILCHIMP_TIMEOUT_MS` | no | `60000` | Per-request timeout. Set below Mailchimp's 120s server-side to fail fast. |
| `MAILCHIMP_MAX_RETRIES` | no | `3` | Max retry attempts for transient failures (429, 5xx, network). |
| `MAILCHIMP_CONCURRENCY_LIMIT` | no | `4` | Max in-flight requests per workflow tool. Below Mailchimp's 10-concurrent account cap to leave headroom for concurrent agents/UI. |

---

## Domain Mapping

Full endpoint inventory from `docs/reference/mailchimp-openapi.json` (282 operations across 172 paths). Grouped by Mailchimp top-level resource; **Free?** column indicates whether the endpoint is callable on the Mailchimp Free plan.

| Resource (ops) | Free? | Covered by | Notes |
|:---------------|:------|:-----------|:------|
| `lists` (69) | ✅ partial | `mailchimp_audiences` (CRUD-except-delete + signup-forms + analytics), `mailchimp_subscribers` (CRUD-except-delete-permanent + tags/notes/activity), `mailchimp_segments`, `mailchimp_merge_fields` (CRUD-except-delete), `mailchimp_upsert_subscriber`, `mailchimp_import_subscribers`, `mailchimp_find_subscriber`, `mailchimp_audience_overview` | Free capped at 1 audience. Interest-categories + webhooks + signup-form-sub-resources under `/lists/**` deferred as low-signal. |
| `campaigns` (22) | ✅ partial | `mailchimp_campaigns` (CRUD-except-delete), `mailchimp_send_campaign`, `mailchimp_replicate_campaign` | Regular/plaintext/RSS only. Split/variate paid. Delete deferred (destroys reports). Scheduling may require Standard — surface 403 with hint. |
| `reports` (22) | ✅ | `mailchimp_reports` (consolidated via `dimension` enum), `mailchimp_campaign_report` | Basic post-send reports free. |
| `automations` (18) | ❌ | — | Standard+. **Excluded.** |
| `reporting` (12) | partial | — | Surveys/facebook-ads paid. **Excluded.** |
| `ecommerce` (60) | partial | — | **Excluded.** |
| `file-manager` (11) | ✅ | — | **Excluded as low-signal** — asset management is a human UI task. |
| `landing-pages` (8) | ✅ | — | **Excluded as low-signal** — off-domain (web pages). |
| `audiences` (8) | ✅ | — | BETA omni-channel contacts, separate from `/lists`. Defer. |
| `templates` (6) | ✅ | `mailchimp_templates` | Free limited template selection. |
| `template-folders` (5) | ✅ | — | **Excluded as low-signal.** |
| `campaign-folders` (5) | ✅ | — | **Excluded as low-signal.** |
| `verified-domains` (5) | ✅ | — | Admin. Defer. |
| `connected-sites` (5) | partial | — | Defer. |
| `batch-webhooks` (5) | ✅ | — | Infra. Defer. |
| `batches` (4) | ✅ | — | Async batch runner. Defer — workflow tools handle batches inline. |
| `conversations` (4) | partial | — | Partly paywalled. Defer. |
| `account-exports` (3) | ✅ | — | Admin. Defer. |
| `facebook-ads` (2) | ❌ | — | **Excluded.** |
| `authorized-apps` (2) | ✅ | — | OAuth metadata. Defer. |
| `search-members` (1) | ✅ | `mailchimp_search` (`scope: members`), `mailchimp_find_subscriber` | |
| `search-campaigns` (1) | ✅ | `mailchimp_search` (`scope: campaigns`) | |
| `ping` (1) | ✅ | startup validation only (not exposed as tool op) | |
| `customer-journeys` (1) | ❌ | — | Standard+. **Excluded.** |
| `activity-feed` (1) | ✅ | `mailchimp_account` (`operation: activity-feed`) | Chimp Chatter stream. |
| `/` root (1) | ✅ | `mailchimp_account` (`operation: info`) | |

**v1 coverage:** 17 tools covering ~140 operations (~50% of the API). `mailchimp_playbook` reuses existing endpoints for live state — no new upstream surface. Remaining ops are paid-gated, admin-tier, or intentionally deferred as low-signal.

---

## Workflow Analysis

How the seven workflow tools compose upstream calls — each replaces a multi-step agent sequence with a single tool call.

**`mailchimp_send_campaign`** (5–8 upstream calls, plus elicit):
```
(if ctx.elicit && mode in send|schedule) → elicit confirmation — reject → short-circuit to draft
POST   /campaigns                            → create draft
PUT    /campaigns/{id}/content               → set html/plaintext/template content
GET    /campaigns/{id}/send-checklist        → validate
POST   /campaigns/{id}/actions/test          → (if mode=test) send preview to testEmails
POST   /campaigns/{id}/actions/send |        → (if mode=send)
POST   /campaigns/{id}/actions/schedule      → (if mode=schedule)
GET    /campaigns/{id}                       → post-action state for the response
(on mid-flow error + cleanupOnError)         → DELETE /campaigns/{id}
```
Output carries the campaign ID, send-checklist warnings (non-blocking; blocking items throw `ValidationError` before send), resolved mode, `cancelledByUser` if elicit rejected, and archive URL when available. If `ctx.signal` aborts mid-flow or any upstream step throws, and `cleanupOnError: true` (default), the draft is deleted before the error propagates — prevents orphan drafts cluttering the account.

**`mailchimp_replicate_campaign`** (4–9 upstream calls, plus elicit):
```
POST   /campaigns/{sourceId}/actions/replicate   → clone source → new campaignId
PATCH  /campaigns/{newId}                        → (if overrides) update subject/from/recipients/segment
PUT    /campaigns/{newId}/content                → (if contentOverride) set new content
GET    /campaigns/{newId}/send-checklist         → validate
(if ctx.elicit && mode in send|schedule) → elicit confirmation
POST   /campaigns/{newId}/actions/test | send | schedule   → dispatch per mode
GET    /campaigns/{newId}                        → post-action state
```
Same `cleanupOnError` + elicit semantics as `send_campaign`. Common agent pattern: "send a new version of campaign X with an updated subject line and a fresh intro paragraph."

**`mailchimp_upsert_subscriber`** (2–3 calls):
```
PUT    /lists/{id}/members/{hash}            → idempotent upsert with merge/status
POST   /lists/{id}/members/{hash}/tags       → (if tags provided) sync tags
POST   /lists/{id}/members/{hash}/notes      → (if note provided) attach note
```
Uses PUT to avoid the "already subscribed" race. `status_if_new` preserves existing status when updating. Tags are synced — provided tag set becomes the set (agents pass the full desired state, not deltas, to keep the tool declarative). `status: 'pending'` triggers double-opt-in — documented in param description to prevent the common agent misreading.

**`mailchimp_import_subscribers`** (1 call, batch):
```
POST   /lists/{id}                           → batch with members[] array, status defaults to 'pending'
```
Wraps the native batch subscribe. Returns per-row `total_created`, `total_updated`, `error_count` plus per-error `email_address`, `error`, `error_code`. **Status defaults to `'pending'`** — callers must explicitly pass `status: 'subscribed'` to import as already-opted-in. Caps input at 500 per call (Mailchimp hard limit).

**`mailchimp_find_subscriber`** (2–N calls):
```
GET    /search-members?query={email}&list_id?   → locate
GET    /lists/{list_id}/members/{hash}          → (per match) full detail
GET    /lists/{list_id}/members/{hash}/tags     → (per match) tags
```
Returns matches across audiences (if `audienceId` omitted) with full state — email, status, merge fields, tags, last activity. Most free accounts have one audience, so usually a single upstream call.

**`mailchimp_campaign_report`** (5 calls, parallelized under concurrency cap):
```
GET /reports/{id}
GET /reports/{id}/click-details?count=N&sort_field=total_clicks
GET /reports/{id}/open-details?count=N&sort_field=opens
GET /reports/{id}/locations?count=N
GET /reports/{id}/unsubscribed?count=N
```
Parallelized via `Promise.all` subject to `MAILCHIMP_CONCURRENCY_LIMIT`. Output is a single structured digest. Individual slices remain available via `mailchimp_reports` with `operation: 'slice'` for agents that need one specific dimension in detail.

**`mailchimp_audience_overview`** (4 calls, parallelized):
```
GET /lists/{id}
GET /lists/{id}/growth-history?count=12
GET /lists/{id}/clients
GET /lists/{id}/merge-fields
```
Digest of audience state, used as a "what does this audience look like" one-call.

**`mailchimp_playbook`** (0–2 upstream calls per topic):
```
GET /                                      → (topic=onboarding) account state
GET /lists/{id}                            → (topic=send | list-hygiene) audience stats
GET /lists/{id}/growth-history?count=3     → (topic=send) recent-growth context
GET /reports/{campaignId}                  → (topic=post-send-review) campaign headline stats
GET /reports?count=10                      → (topic=deliverability) recent-campaign trend
GET /search-members?query={email}          → (topic=subscriber-triage) locate subscriber
```
Returns markdown instructions tailored to current account state plus `nextToolSuggestions` (recommended follow-up calls given the live numbers). Read-only — the agent consumes the playbook, then executes steps using action tools.

---

## Flagship Output Shapes

Sketches for the two highest-leverage workflow tools. Full Zod schemas land during implementation; these set the contract.

### `mailchimp_send_campaign` output

```ts
z.object({
  campaignId: z.string().describe('Mailchimp campaign ID (use for follow-up tool calls).'),
  webId: z.number().describe('Mailchimp web-id for constructing UI links.'),
  mode: z.enum(['draft', 'test', 'send', 'schedule']).describe('What actually happened — echoes the input unless cancelled.'),
  status: z.enum(['save', 'paused', 'schedule', 'sending', 'sent']).describe('Post-action campaign status from Mailchimp.'),
  sendTime: z.string().optional().describe('Scheduled send time (ISO 8601) when mode=schedule.'),
  testsSentTo: z.array(z.string()).optional().describe('Test recipients echo, only when mode=test.'),
  checklistWarnings: z.array(z.object({
    type: z.enum(['success', 'warning', 'error']),
    heading: z.string(),
    details: z.string(),
  })).describe('Non-blocking send-checklist results. Blocking items throw ValidationError before this point.'),
  archiveUrl: z.string().url().optional().describe('Public archive URL, populated once sending begins.'),
  cancelledByUser: z.boolean().optional().describe('True if elicit confirmation was rejected; mode was downgraded to draft.'),
  cleanedUp: z.boolean().optional().describe('True if the draft was deleted due to mid-flow failure.'),
})
```

`format()` renders: campaign ID + web link, resolved mode/status, scheduled time or test recipients if applicable, warnings as bulleted list, archive URL. Content-complete — an LLM seeing only `content[]` has enough to confirm success or diagnose the warning list.

### `mailchimp_campaign_report` output

```ts
z.object({
  campaignId: z.string(),
  campaignTitle: z.string(),
  sendTime: z.string(),
  recipientsCount: z.number(),
  delivery: z.object({
    delivered: z.number(),
    bounces: z.object({ hard: z.number(), soft: z.number(), syntax: z.number() }),
    abuseReports: z.number(),
  }),
  engagement: z.object({
    opens: z.object({ total: z.number(), unique: z.number(), rate: z.number(), lastOpen: z.string().optional() }),
    clicks: z.object({ total: z.number(), unique: z.number(), rate: z.number(), lastClick: z.string().optional() }),
    unsubscribes: z.number(),
  }),
  topClickedLinks: z.array(z.object({ url: z.string(), totalClicks: z.number(), uniqueClicks: z.number() })),
  topLocations: z.array(z.object({ country: z.string(), region: z.string().optional(), opens: z.number() })),
  recentUnsubscribes: z.array(z.object({ email: z.string(), reason: z.string().optional(), timestamp: z.string() })),
  industryBenchmarks: z.object({ openRate: z.number(), clickRate: z.number() }).optional(),
})
```

`format()` renders as structured markdown: headline metrics table, then sections for top links / locations / unsubs. Include industry benchmark deltas when Mailchimp returns them — helpful comparative context without fabricating anything.

---

## Design Decisions

**Workflow tools first, primitives second.** The user workflow for Mailchimp is almost always multi-step (create → content → validate → send). Forcing agents to chain primitive tools is error-prone and wastes context. Workflow tools encode the happy path; primitives exist for edge cases and fine control.

**Consolidate REST verbs into `operation` enum.** Mailchimp's REST surface has 69 `/lists/**` endpoints. Exposing one tool per endpoint would blow up the surface. Grouping by noun with `operation` enum keeps the surface at 17 tools while preserving the CRUD access the agent actually needs.

**Lean surface > comprehensive surface.** v1 ships with 16 tools, not 21. Folders, file manager, landing pages, per-audience webhooks, and interest-category groups are intentionally excluded — they're either UI ceremony, off-domain (web pages), one-time human setup, or niche enough that agents rarely touch them. Easier to add a tool when a real use case surfaces than to deprecate one after agents build habits around it.

**Irreversible writes live in the UI, not the tool surface.** Deleting an audience on free plan (1-audience cap) nukes everything. Permanent-delete on a subscriber prevents them from ever resubscribing. Deleting a sent campaign destroys historical reports. Deleting a merge field drops a column's worth of data across every subscriber. These don't belong behind an LLM — humans should do them in the Mailchimp UI with its confirmation dialogs. `archive`, `cancel-send`, and other recoverable alternatives remain.

**Elicit-guarded sends.** `mailchimp_send_campaign` and `mailchimp_replicate_campaign` with `mode: 'send' \| 'schedule'` prompt via `ctx.elicit` when the client supports it — "Send campaign X to N recipients?" — and downgrade to draft on reject. On clients without elicitation, the `destructiveHint: true` annotation is the signal and the orchestrating agent's policy decides. Can't fully prevent footguns in headless contexts, but human-in-the-loop sessions get a real confirm step.

**`import_subscribers` defaults to pending (double-opt-in).** Agents routinely pass lists of emails without thinking through the consent chain. Defaulting to `pending` forces Mailchimp's double-opt-in flow — each subscriber confirms via email before being added — and requires an explicit `status: 'subscribed'` for the "I already have consent for these" path.

**`mailchimp_reports` uses `operation` + `dimension`.** The report slice endpoints all return rows-per-dimension with the same shape. `operation: 'list' \| 'get' \| 'slice'` with a `dimension` discriminator cuts the enum from 13 values down to 3 operations + a discriminator.

**Naming uses the Mailchimp UI vocabulary.** Mailchimp UI says "audience" and "subscriber"; the legacy API says "list" and "member". Tool names use the UI terms. The service layer maps to `/lists/**` and `/members/**` internally.

**Tags as declarative state in `upsert_subscriber`.** Mailchimp's tag API has add/remove endpoints but not "set". The workflow tool reads current tags, computes the delta, issues the right add/remove calls — agents pass the desired set, not operations. Trades one extra GET for a much cleaner interface.

**Orphan-draft cleanup by default.** Mid-flow failure in `send_campaign` or `replicate_campaign` leaves a draft in Mailchimp. Default to cleaning it up (`cleanupOnError: true`); expose the flag so power users can opt out (e.g., to debug what the draft looked like).

**Paid-feature error enrichment.** Mailchimp's 403 for paid features is opaque ("This feature is only available to paid accounts"). Service classifies these and adds `{ requiresPlan: 'standard' | 'premium' }` to error data so the agent can surface actionable guidance instead of just "forbidden".

**Startup API-key validation.** Issuing `/ping` in `setup()` catches malformed or revoked keys at server start, not on the first tool call 30 seconds into a user session. The tool-level `ping` op is therefore redundant and not exposed — `mailchimp_account` keeps `info` + `activity-feed` only.

**Instruction tool for state-aware playbooks.** `mailchimp_playbook` returns procedural guidance *merged with live account state* (e.g., "your bounce rate is 2.1%, prioritize list cleanup before tweaking subject lines"). Static playbooks could live as MCP Prompts, but the value is specifically in the state-aware tailoring — generic advice + this account's numbers = prescriptive next steps. Consolidated into one tool with a `topic` enum rather than six separate tools to keep the surface small and discoverable. Mirrors the pattern of `git_wrapup_instructions` from the git MCP server: the tool doesn't do the work, it tells the agent how to.

**No app-tools in v1.** Mailchimp data is well-suited to text rendering (tables, lists). Revisit after v1 ships if an interactive dashboard use case emerges.

**No prompts in v1.** Tool surface covers the use cases. Prompts earn their keep when there's a recurring LLM interaction pattern worth templating — none of the current flows need that.

---

## Known Limitations

- **Free-plan caps.** 250 contacts, 1 audience, 500 emails/month, 250/day. Tools surface these as `Forbidden` or `RateLimited` with plan-upgrade guidance.
- **No scheduling on some free accounts.** Mailchimp gates scheduling behind Standard on some account tiers. `mailchimp_send_campaign` with `mode: 'schedule'` surfaces the 403 with `requiresPlan: 'standard'`.
- **No automations or multi-step journeys.** Single-send campaigns only.
- **No A/B or variate campaigns.** Only `regular`, `plaintext`, `rss` campaign types exposed.
- **Irreversible deletes unavailable via tool surface.** Audience delete, subscriber permanent-delete, campaign delete, merge-field delete are intentionally excluded. Humans do them in the UI.
- **Elicit guard is best-effort.** Clients without `ctx.elicit` (stdio without a human, headless batch runs) see only the `destructiveHint` annotation. Sending is still possible — policy lives in the orchestrator.
- **Rate limit is per-account-concurrent, not per-period.** 10 simultaneous requests. Workflow tools cap internal concurrency at `MAILCHIMP_CONCURRENCY_LIMIT` (default 4) to leave headroom for other sessions.
- **Pagination is `count`/`offset`, not cursor.** Tools expose `count` and `offset` directly; callers page explicitly. Mailchimp caps `count` at 1000.
- **Tag sync requires GET + POST.** No atomic "set tags" endpoint; a concurrent modification between our read and write could lose a tag. Acceptable for v1; documented in the tool's description.
- **Import batch cap.** `mailchimp_import_subscribers` caps at 500 per call. Larger imports require client-side chunking or the async `/batches` API (deferred).
- **Cleanup-on-error is best-effort.** If the cleanup DELETE also fails (e.g., during a full Mailchimp outage), the orphan remains. Error response includes `cleanedUp: false` so agents know.

---

## Testing Strategy

Three layers — all land alongside implementation, not after.

**Unit tests.** Per-tool, per-service-method. `createMockContext()` from `@cyanheads/mcp-ts-core/testing` for context (with `elicit: vi.fn()` mocked for send-path tests). Mock `MailchimpService` methods return canned fixtures per scenario (happy path, sparse upstream response, 404, 429, paid-feature 403, timeout, elicit-reject). Assert tool output shape, error classification, and `format()` content includes all relevant fields. Colocate `foo.tool.test.ts` with `foo.tool.ts`.

**Sparse-payload cases.** Per the project checklist, every tool that wraps an external API needs at least one test with upstream fields omitted (e.g., a member with no merge fields, a campaign with no archive URL). Mailchimp's spec marks many fields optional — normalize and `format()` must handle absence without fabricating values.

**Integration tests.** Gated by `MAILCHIMP_API_KEY` env var — skipped when absent. Cover the seven workflow tools end-to-end against a real free-tier account. Use dedicated test prefixes (e.g., `[MCP-TEST]`) so fixtures are easy to clean. Live in `tests/integration/` with a separate vitest config.

**Fuzz tests.** `fuzzTool` from `@cyanheads/mcp-ts-core/testing/fuzz` on every tool. Focus: no crashes on adversarial strings in email/tag/merge fields, no prototype pollution, no stack-trace leaks. Lower priority than unit tests but worth adding once the service stabilizes.

---

## API Reference

- **Host:** `https://{dc}.api.mailchimp.com/3.0/` where `{dc}` is derived from the API key suffix (`-us22` → `us22`).
- **Auth:** HTTP Basic. Username is arbitrary (`anystring`), password is the API key. Header: `Authorization: Basic base64("anystring:API_KEY")`.
- **Rate limit:** 10 concurrent requests per account. No explicit per-minute cap; 429 responses include `Retry-After`.
- **Timeout:** Mailchimp-side 120s. Client-side default 60s.
- **Pagination:** `?count=N&offset=K` on list endpoints. `count` max 1000 (most endpoints default 10).
- **Field selection:** Supported on many endpoints via `?fields=a,b,c` and `?exclude_fields=x,y`. Service methods accept a `fields` option and forward.
- **Errors:** Standard HTTP status codes. Mailchimp error body: `{ type, title, status, detail, instance }` ([problem+json](https://datatracker.ietf.org/doc/html/rfc7807)).
- **Reference spec:** `docs/reference/mailchimp-openapi.json` (bundled Swagger 2.0, 10 MB, gitignored — see `docs/reference/README.md` for fetch command).

---

## Implementation Order

Each step is independently testable. `bun run devcheck` after each.

1. **Remove echo scaffolds.** Delete `echo.tool.ts`, `echo-app.app-tool.ts`, `echo.resource.ts`, `echo-app-ui.app-resource.ts`, `echo.prompt.ts`; trim `src/index.ts`; delete fixture tests under `tests/`. Clean foundation first.
2. **Config.** `src/config/server-config.ts` — Zod schema with DC extraction, concurrency limit, timeout, retries. Update `.env.example` with `MAILCHIMP_API_KEY` + optional overrides. Unit tests for DC parsing edge cases.
3. **Service types.** `src/services/mailchimp/types.ts` — domain types (`Audience`, `Subscriber`, `Campaign`, `Report`, `MergeField`, ...) mapped from upstream responses. Prefer narrow types over `unknown`.
4. **MailchimpService.** `src/services/mailchimp/mailchimp-service.ts` — `fetchWithTimeout` + `withRetry`, basic-auth, error classification (401 → Unauthorized, 403-paid → Forbidden+hint, 404 → NotFound, 429 → RateLimited, 5xx → ServiceUnavailable). Init/accessor pattern registered in `setup()`, which also issues the startup `/ping` validation.
5. **`mailchimp_account`** — info + activity-feed. Smallest tool, validates the whole auth + service plumbing end-to-end.
6. **`mailchimp_audiences`** + **`mailchimp_audience_overview`** — list/get/create/update + analytics + signup-forms + the digest workflow tool.
7. **`mailchimp_subscribers`** + **`mailchimp_upsert_subscriber`** + **`mailchimp_find_subscriber`** + **`mailchimp_import_subscribers`** — the subscriber surface. `import_subscribers` defaults status to `'pending'`.
8. **`mailchimp_segments`** + **`mailchimp_merge_fields`** — audience-config tools.
9. **`mailchimp_campaigns`** + **`mailchimp_send_campaign`** + **`mailchimp_replicate_campaign`** — campaign CRUD (no delete) and send workflows with elicit guard.
10. **`mailchimp_reports`** (consolidated `list`/`get`/`slice` with `dimension` enum) + **`mailchimp_campaign_report`** — reports + digest.
11. **`mailchimp_templates`** — template CRUD.
12. **`mailchimp_search`** — search-members + search-campaigns.
13. **`mailchimp_playbook`** — procedural guidance tool with `topic` enum. Static markdown templates per topic + 0–2 live-state fetches merged inline. Lands after action tools so playbook advice can reference them reliably.
14. **Resources.** `mailchimp://account`, `mailchimp://audiences/{id}`, `mailchimp://campaigns/{id}`, `mailchimp://campaigns/{id}/report`.
15. **Smoke-test** via `bun run dev:stdio` + MCP Inspector against a real API key.
16. **Field-test** with `skills/field-test` — exercise each tool with realistic inputs, log pain points.
17. **`polish-docs-meta`** — README, CHANGELOG, version sync, server.json description refresh.

Estimated effort: small service + 17 tools + 4 resources ≈ 30–38 files, with tests. 2 focused sessions.
