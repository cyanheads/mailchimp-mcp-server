# Changelog

All notable changes to `mailchimp-mcp-server` are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.4 — 2026-04-20

### Fixed

- **`mailchimp_campaign_report`, `mailchimp_reports` (`operation: get`), and the `mailchimp://campaigns/{campaignId}/report` resource** now throw a clear `ValidationError` when a campaign has not been sent yet, instead of returning a structurally complete zero-valued report that agents misinterpreted as "sent but fully ignored." The guard fires on an empty upstream `send_time`. `mailchimp_campaign_report` also short-circuits the three slice fetches (click-details, locations, unsubscribed) on the draft path — one upstream call on failure instead of four. ([#2](https://github.com/cyanheads/mailchimp-mcp-server/issues/2))
- **Mailchimp 4xx `errors[]` field entries are now surfaced in the thrown error message.** Previously 400 responses ended with "For field-specific details, see the 'errors' array" but discarded the array — e.g. `mailchimp_segments` `batch-update-members` failures were effectively opaque. The message now appends `Field errors: field: message; …`; the full array remains available in `data.upstream.errors`. ([#2](https://github.com/cyanheads/mailchimp-mcp-server/issues/2))

### Added

- Vitest coverage for both fixes — 3 cases for the draft guard (rejection, slice short-circuit, sent passes through) and 2 for upstream `errors[]` surfacing (present, absent). 55 tests total (up from 50).

## 0.2.3 — 2026-04-20

### Changed

- **Bumped `@cyanheads/mcp-ts-core` `^0.4.1` → `^0.5.0`.** Brings framework-level `ZodError` → `ConfigurationError` conversion at startup, so missing/invalid env vars now surface as a formatted banner on `stderr` instead of a raw Zod path dump.
- **Adopted `parseEnvConfig` for server config parsing.** `src/config/server-config.ts` now maps Zod schema paths → env var names, so validation errors name the actual variable (e.g. `MAILCHIMP_API_KEY (apiKey): ...`) rather than the internal Zod path. Internal refactor — no user-facing config surface change.

### Internal

- **`mailchimp-service.ts`** replaces the last raw `new McpError(JsonRpcErrorCode.Timeout, ...)` call with the `timeout()` error factory. No behavior change.
- **`skills/maintenance/SKILL.md`** rewritten to v1.3 — adds Mode A (full update flow) vs Mode B (post-update review), delegates changelog investigation to the `changelog` skill, and introduces the two-phase skill sync (package → project → agent directories).
- **`CLAUDE.md`** documents the `parseEnvConfig` pattern, expands the forbidden Zod types list in the checklist, and references the Phase B agent-skill-directory sync.

## 0.2.2 — 2026-04-20

### Fixed

- **`mailchimp_account` `activity-feed` no longer crashes on quiet accounts.** Mailchimp omits the `activity` array when there's nothing to report; the handler now treats it as optional and returns an empty list instead of a raw `TypeError`. ([#1](https://github.com/cyanheads/mailchimp-mcp-server/issues/1))
- **`mailchimp_subscribers` `set-tags` no longer fabricates `id: 0`.** The bulk tag-sync endpoint returns names only, so `tagsActive` entries now omit `id` entirely rather than filling a misleading placeholder. The output schema documents when `id` is present vs omitted. ([#1](https://github.com/cyanheads/mailchimp-mcp-server/issues/1))
- **`mailchimp_subscribers` `archive` returns `archived: true`** (was `deleted: true`). Archive preserves the subscriber record for resubscribe, so the field name now matches the behavior. `delete-note` continues to return `deleted: true`. ([#1](https://github.com/cyanheads/mailchimp-mcp-server/issues/1))

### Changed

- **Consistent `camelCase` across nested payloads.** Added `normalizeMailchimp()` — a small recursive helper that converts `snake_case` keys to `camelCase` and strips `_links` HAL arrays. Applied at every leaky call site, so these surfaces now return the same shape the primary CRUD operations already did:
  - `mailchimp_audiences` `list-activity`, `get-signup-forms`, `customize-signup-forms`
  - `mailchimp_subscribers` `list-activity`, `list-events`, `list-goals`
  - `mailchimp_reports` `slice` — every dimension (click-details, open-details, locations, sent-to, unsubscribed, abuse-reports, advice, domain-performance, eepurl, email-activity)
  - Resources: `mailchimp://audiences/{audienceId}` (`stats`, `contact`, `campaignDefaults`), `mailchimp://campaigns/{campaignId}` (`settings`, `recipients`, `tracking`, `reportSummary`), `mailchimp://campaigns/{campaignId}/report` (`bounces`, `opens`, `clicks`, `industryStats`)

### Added

- Vitest coverage for `normalizeMailchimp()` — key conversion, `_links` stripping, nested traversal, preservation of all-caps merge-field tags.

## 0.2.1 — 2026-04-20

### Added

- Vitest coverage for the Mailchimp service HTTP layer (success, error classification, retry/abort), the `mailchimp_playbook` tool (`design-campaign` topic, tone adjustments, `format()` projection), and the `newsletter_from_source` prompt template.

### Changed

- Shortened `server.json` description to fit MCP registry conventions. Long-form description is retained in `package.json` and `README.md`.

### Internal

- `mailchimpMemberHash` and `MailchimpService.request` are now synchronous / non-`async` — removes unnecessary promise wrapping around the MD5 hash and the retry-wrapped fetch.
- Dot-notation cleanup across tools, service, and config: replaced literal `obj['key']` access with `obj.key` where TypeScript permits.

## 0.2.0 — 2026-04-20

### Added

- **`newsletter_from_source` prompt** — user-invokable starter that briefs the agent to compose a monthly editorial newsletter from a URL or free-form description; chains into the `design-campaign` playbook and walks the draft → test → send flow.
- **`design-campaign` topic** on `mailchimp_playbook` — returns editorial design conventions (palette, typography, email-safe HTML, CDN graphics, subject/preview craft) merged with live audience engagement state for tone tuning.
- **`docs/email-design-playbook.md`** — comprehensive reference for composing campaigns that feel editorial rather than templated, distilled from a worked example and generalized for reuse.

### Changed

- **Package renamed** to the scoped `@cyanheads/mailchimp-mcp-server`. Update client configs that referenced the unscoped `mailchimp-mcp-server` package.
- `start:stdio` / `start:http` scripts now use `bun ./dist/index.js` instead of `node dist/index.js`.
- `package.json` metadata refreshed: added `funding`, reordered keywords, pinned `engines.bun` to `>=1.3.2`.

### Internal

- `mailchimpMemberHash` uses a top-level `node:crypto` import instead of dynamic import.
- `mergeSignals` simplified to the native `AbortSignal.any` path (Bun >=1.3 and Node >=22 both ship it).
- Dropped the redundant `status >= 500` branch in the upstream error classifier — both branches returned the same `serviceUnavailable()`.

## 0.1.0 — 2026-04-20

Initial release.

### Added

- **17 tools** covering the Mailchimp Marketing API surface:
  - Workflow (7): `mailchimp_send_campaign`, `mailchimp_replicate_campaign`, `mailchimp_upsert_subscriber`, `mailchimp_import_subscribers`, `mailchimp_find_subscriber`, `mailchimp_campaign_report`, `mailchimp_audience_overview`
  - Primitive (9): `mailchimp_account`, `mailchimp_audiences`, `mailchimp_subscribers`, `mailchimp_segments`, `mailchimp_merge_fields`, `mailchimp_campaigns`, `mailchimp_reports`, `mailchimp_templates`, `mailchimp_search`
  - Instruction (1): `mailchimp_playbook`
- **4 resources** for stable URIs: `mailchimp://account`, `mailchimp://audiences/{audienceId}`, `mailchimp://campaigns/{campaignId}`, `mailchimp://campaigns/{campaignId}/report`
- Mailchimp client service with retry, per-request timeout, concurrency limits, and payload normalization
- Auto-derives API base URL from the `-dc` suffix on the API key
- Safe-by-default send workflows:
  - `ctx.elicit` confirmation on `send` / `schedule` modes
  - `pending` default status for imports and upserts (Mailchimp's double-opt-in flow)
  - No permanent-delete paths for campaigns, merge fields, or audiences exposed to agents
  - Auto-cleanup of aborted or failed draft campaigns
- Declarative tag sync with `preserveTags` on `mailchimp_upsert_subscriber` and `mailchimp_subscribers` (`set-tags`) to protect static-segment memberships from removal
- `mailchimp_upsert_subscriber` splits create (PUT) and update (PATCH with `skip_merge_validation`) paths to avoid re-validating pre-existing merge fields
- STDIO and Streamable HTTP transports, Cloudflare Workers-ready
- Apache-2.0 license
