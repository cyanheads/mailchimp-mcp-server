# Changelog

All notable changes to `mailchimp-mcp-server` are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
