# Changelog

All notable changes to `mailchimp-mcp-server` are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.6 — 2026-04-21

### Changed

- **Bumped `@cyanheads/mcp-ts-core` `^0.5.2` → `^0.6.3`.** Six upstream releases of polish, additive features, and no breaking changes for consumers. Highlights: HTTP-mode servers now auto-serve an HTML landing page at `/` and a SEP-1649 Server Card at `/.well-known/mcp.json` ([0.6.0](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.6.x/0.6.0.md)); definition-linter diagnostics now embed a `See: skills/api-linter/SKILL.md#<rule>` breadcrumb ([0.5.4](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.5.x/0.5.4.md)); `ToolDefinition` / `ResourceDefinition` / `PromptDefinition` gained an optional `sourceUrl` field for landing-page view-source overrides ([0.6.3](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.6.x/0.6.3.md)). Full per-version notes in `node_modules/@cyanheads/mcp-ts-core/changelog/`.
- **Bumped `vitest` `^4.1.4` → `^4.1.5`.** Pure bug-fix patch.
- **`CLAUDE.md` `format()` checklist item** rewritten to the dual-surface framing ("Claude Code → `structuredContent`, Claude Desktop → `content[]`; both must carry the same data"), replacing the older "`content[]` is the only field most clients forward" wording — see framework [0.5.3](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.5.x/0.5.3.md).
- **Skills synced from `@cyanheads/mcp-ts-core` 0.6.3:** `add-app-tool` v1.2→v1.3, `add-prompt` v1.1→v1.2, `add-resource` v1.2→v1.3, `add-service` v1.2→v1.3, `add-tool` v1.5→v1.7, `api-context` v1.0→v1.1, `api-services` v1.2→v1.3, `api-utils` v2.0→v2.1, `design-mcp-server` v2.3→v2.5, `maintenance` v1.3→v1.4, `polish-docs-meta` v1.4→v1.6, `setup` v1.3→v1.4. `.claude/skills/` refreshed (Phase B).

### Added

- **`landing.envExample` in `createApp()` (`src/index.ts`).** Surfaces `MAILCHIMP_API_KEY` in the auto-generated STDIO / Claude CLI connect snippets on the landing page so new users see the one required env var without digging into docs. Feature from framework [0.6.1](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.6.x/0.6.1.md).
- **New `api-linter` skill (v1.0)** — reference for every definition-linter rule ID (`format-parity`, `schema-*`, `name-*`, `server-json-*`, …). Added to both `skills/` and `.claude/skills/`, and registered in the CLAUDE.md skills table alongside the previously unlisted `migrate-mcp-ts-template`.

## 0.2.5 — 2026-04-21

### Changed

- **Bumped `@cyanheads/mcp-ts-core` `^0.5.0` → `^0.5.2`.** 0.5.2 adds a `format-parity` definition-lint rule that fails startup when a tool's `output` schema contains any terminal field not rendered by `format()` — since most LLM clients only forward `content[]` (not `structuredContent`), fields in the schema but absent from `format()` are invisible to the model. Full framework CHANGELOG: [cyanheads/mcp-ts-core](https://github.com/cyanheads/mcp-ts-core/blob/main/CHANGELOG.md).
- **Rewrote `format()` for every tool to satisfy `format-parity` the right way — enriching the rendered text, not loosening the schema.** Zero uses of `z.object({}).passthrough()` or schema-field deletions (the "escape hatch" called out in [cyanheads/mcp-ts-core#37](https://github.com/cyanheads/mcp-ts-core/issues/37)). All Zod `output` shapes are unchanged; only the rendering layer was expanded.
  - **Presence-based rendering for operation-enum tools.** `mailchimp_account`, `mailchimp_audiences`, `mailchimp_campaigns`, `mailchimp_merge_fields`, `mailchimp_reports`, `mailchimp_segments`, `mailchimp_subscribers`, `mailchimp_templates` — the old `if (result.operation === 'X') { ... } else if (result.operation === 'Y') { ... }` branching satisfied the lint rule's synthetic sample for only the first branch, hiding every other branch's fields. Each `format()` is now driven by field presence (`if (result.subscribers) { ... } if (result.subscriber) { ... }`), so all declared fields render when populated. Factored out a local `renderSummary(item, bullet)` helper per tool to render list-item and detail-view shapes consistently.
  - **`mailchimp_audience_overview`:** now surfaces `visibility`, the `contact.*` CAN-SPAM block, `stats.avgSubRate`/`avgUnsubRate`, and an `existing` column in the growth table.
  - **`mailchimp_campaign_report`:** now renders `type`, `industryBenchmarks.abuseRate`, `topClickedLinks[].clickPercentage`, and both `region` and `regionName` on top locations (previously `regionName ?? region` silently dropped one).
  - **`mailchimp_search`:** changed `if (members) ... else if (campaigns)` to render both branches when present, added `subscriberId` to member match lines and `type` / title-alt fallback to campaign match lines.
  - **`mailchimp_playbook`:** `format()` now echoes `topic` and appends a `## Live state` JSON block so the agent can verify the data the walkthrough was built from.
  - **`mailchimp_campaigns`:** `content.html`/`content.archiveHtml` now render a fenced-code preview with explicit size, satisfying the rule's strict string-sentinel match (length-only rendering was dropping the sentinel).
  - **`mailchimp_send_campaign`, `mailchimp_replicate_campaign`:** checklist warning lines now include the `[type]` severity tag (success/warning/error); replicate adds the `cleanedUp` post-failure blurb; both render `webId` alongside the UI deep link.
  - **`mailchimp_find_subscriber`, `mailchimp_subscribers`, `mailchimp_upsert_subscriber`, `mailchimp_import_subscribers`:** expanded match / summary lines to cover every member field declared in the output schema — `language`, `vip`, `source`, `lastChanged`, `timestampSignup`, `stats.avgOpenRate`/`avgClickRate`, tag `id`s, and merge-field key=value pairs (with an explicit `(none populated)` marker so the `mergeFields` key name survives when the record is empty).
- **Skills synced from `@cyanheads/mcp-ts-core` 0.5.2:** `add-tool` v1.4→v1.5, `api-config` v1.1→v1.2, `field-test` v1.1→v1.2, `polish-docs-meta` v1.3→v1.4 (substantial README-reference rewrite), `setup` v1.2→v1.3. Also refreshed `.claude/skills/` (Phase B propagation).

### Removed

- **`skills/devcheck/`** deleted — the upstream skill was dropped in mcp-ts-core 0.5.2 (["The skill was a thin restatement of CLAUDE.md's Commands table"](https://github.com/cyanheads/mcp-ts-core/blob/main/CHANGELOG.md)). Removed from both `skills/` and `.claude/skills/` to match the new package shape.

### Fixed

- **`mailchimp_campaigns` no longer renders a redundant `[title: X]` tag when `title` equals `subjectLine`.** The comparison was against the quote-wrapped display string (`"subjectLine"`), so it always mismatched even when title and subject were the same. Now compares raw `c.title` against raw `c.subjectLine`.

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
