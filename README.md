<div align="center">
  <h1>@cyanheads/mailchimp-mcp-server</h1>
  <p><b>Draft, test, and send Mailchimp campaigns straight from your MCP client — with audience management, subscriber CRUD, and post-send analytics behind safe-by-default send gates. STDIO or Streamable HTTP.</b>
  <div>18 Tools (+2 conditional) • 4 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/mailchimp-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/mailchimp-mcp-server) [![Version](https://img.shields.io/badge/Version-0.3.9-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/mailchimp-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/mailchimp-mcp-server/releases/latest/download/mailchimp-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=mailchimp-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbWFpbGNoaW1wLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7Ik1BSUxDSElNUF9BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22mailchimp-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/mailchimp-mcp-server%22%5D%2C%22env%22%3A%7B%22MAILCHIMP_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Mailchimp campaign management over the Mailchimp Marketing API v3. Draft, test, and send email campaigns, manage audiences and subscribers, and review post-send analytics from any MCP client. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `mailchimp_account` | Account profile, plan, data center, and the Chimp Chatter activity feed. |
| `mailchimp_audiences` | Manage audiences (lists) — read, create/update, per-audience analytics, signup-form config. No delete. |
| `mailchimp_audience_overview` | One-call audience health digest: info, stats, growth history, top email clients, merge-field schema. |
| `mailchimp_subscribers` | Subscriber CRUD + tags/notes/activity. `archive` is the strongest delete available. |
| `mailchimp_upsert_subscriber` | Add or update a subscriber idempotently with status, merge fields, tags, and an optional note. |
| `mailchimp_find_subscriber` | Locate a subscriber by email in one audience or across the account. |
| `mailchimp_import_subscribers` | Batch add/update subscribers (capped at 500/call). Status defaults to `pending`. |
| `mailchimp_segments` | CRUD for audience segments (saved, static, fuzzy) plus member listing and batch add/remove. |
| `mailchimp_merge_fields` | Read + create/update custom subscriber attributes. No delete. |
| `mailchimp_campaigns` | Campaign record management: list/get/create/update, replicate, content, checklist, RSS/resend controls. |
| `mailchimp_send_campaign` | Compose and send (or schedule/test) a campaign in one call. |
| `mailchimp_replicate_campaign` | Duplicate a campaign with optional overrides, then draft/test/send/schedule. |
| `mailchimp_reports` | Campaign reports — generic slicer across ten dimensions. |
| `mailchimp_campaign_report` | Post-send analytics digest — headline metrics plus top-N slices in one response. |
| `mailchimp_templates` | Mailchimp-hosted templates: reads work on free; writes require a paid plan. |
| `mailchimp_files` | File Manager (Content Studio) — upload, list, fetch, rename, delete files on Mailchimp's CDN. |
| `mailchimp_search` | Global search across members or campaigns. |
| `mailchimp_assets` *(conditional — set `MAILCHIMP_ASSETS_DIR`)* | Local-assets surface — inspect and pre-warm uploads for `@assets/<path>` references in campaign HTML. |
| `mailchimp_local_templates` *(conditional — set `MAILCHIMP_TEMPLATES_DIR`)* | Author and render local `.eta` templates — the write path for templates on free-tier Mailchimp. |
| `mailchimp_playbook` | Structured procedural playbook merged with live account state. Advice-only. |

### Resources

| Resource | Description |
|:---|:---|
| `mailchimp://account` | Account info snapshot — profile, plan, data center, total subscribers. |
| `mailchimp://audiences/{audienceId}` | Audience snapshot — name, contact, stats, double opt-in status. |
| `mailchimp://campaigns/{campaignId}` | Campaign snapshot — status, settings, recipients summary. |
| `mailchimp://campaigns/{campaignId}/report` | Post-send campaign report headline metrics. |

All resource data is also reachable via tools. Large collections (`audiences`, `campaigns`) are not exposed as resources — use the `list` operation on the corresponding tool instead.

### Prompts

| Prompt | Description |
|:---|:---|
| `newsletter_from_source` | Compose a monthly editorial newsletter from a URL or brief, chaining into `mailchimp_playbook` and the draft → test → send flow. |

Design reference: [`docs/email-design-playbook.md`](./docs/email-design-playbook.md).

## Capability reference

### `mailchimp_account` <sub>tool</sub>

- `operation: info` returns profile, plan, data center, and total subscribers; `operation: activity-feed` returns the Chimp Chatter event stream
- `activity-feed` pages via `count` (max 100, default 20) and `offset`; each item carries type, timestamp, and a human-readable description
- An empty activity feed returns a plain-language `note` explaining likely causes instead of a bare empty array

---

### `mailchimp_audiences` <sub>tool</sub>

- `list`/`get`/`create`/`update` manage audience records; `create` requires `name`, `contact` (company/address1/city/state/zip/country), `permissionReminder`, and `campaignDefaults` (fromName/fromEmail/language)
- Analytics reads: `list-activity`, `list-growth`, `list-clients`, `list-abuse-reports`, `list-locations`
- `get-signup-forms`/`customize-signup-forms` manage hosted/embedded signup-form header, content sections, and CSS
- No delete — on the free plan's 1-audience cap this is destructive; delete via the Mailchimp UI
- `count` caps at 1000 per page

---

### `mailchimp_audience_overview` <sub>tool</sub>

- One call merges audience info, `growthMonths` of growth history (1–36, default 12), top email clients, and the full merge-field schema
- `notes[]` distinguishes "no data yet" (new audience, no sends) from a genuine empty-engagement signal

---

### `mailchimp_subscribers` <sub>tool</sub>

- CRUD except permanent delete: `list`/`get`/`update`, plus `archive` (removes from the active audience, preserves the record so the email can resubscribe)
- `set-tags` is declarative — the provided set becomes the full active tag list; anything not included is removed unless named in `preserveTags`
- Mailchimp stores static-segment membership as a tag, so an unguarded `set-tags` can silently drop segment membership
- `list-notes`/`add-note`/`update-note`/`delete-note` manage CRM-style notes; `list-activity`/`list-events`/`list-goals` are engagement reads
- No GDPR permanent-delete — do that in the Mailchimp UI

---

### `mailchimp_upsert_subscriber` <sub>tool</sub>

- Idempotent add-or-update by email — creates via PUT, updates via PATCH, skipping merge-field revalidation on updates that don't touch merge fields
- Declarative tag sync computes the add/remove delta from a desired set; `preserveTags` protects named tags (including static-segment names) from removal
- `status: 'pending'` triggers Mailchimp's double opt-in email; `'subscribed'` requires documented consent
- `updateExistingStatus: false` applies `status` only to newly-created subscribers, leaving existing ones untouched

---

### `mailchimp_find_subscriber` <sub>tool</sub>

- Searches one audience (`audienceId`) or every audience on the account by email, returning separate `exactMatches`/`fuzzyMatches` arrays
- Each match is enriched with merge fields and engagement stats; `includeTags: true` (default) adds the full active tag list at one extra call per match

---

### `mailchimp_import_subscribers` <sub>tool</sub>

- Batch add/update, capped at 500 rows per call — chunk larger imports client-side
- `status` defaults to `pending` (double opt-in) to prevent accidental mass-sends; a per-row `status` overrides the top-level default
- `updateExisting: false` (default) skips rows that already exist instead of overwriting them
- Returns per-row succeeded/failed with Mailchimp error codes and messages

---

### `mailchimp_segments` <sub>tool</sub>

- CRUD for saved, static, and fuzzy segments; free tier supports static and basic saved segments — advanced dynamic conditions require Premium
- `list-members` pages current segment membership
- `batch-update-members` adds/removes many subscribers from a static segment in one call — not reversible in one shot
- `delete` is exposed here (unlike audiences/merge-fields), since removing a segment doesn't destroy subscriber data

---

### `mailchimp_merge_fields` <sub>tool</sub>

- `list`/`get`/`create`/`update` for custom subscriber attributes (merge tags such as `FNAME`, limited to 10 characters)
- No delete — removing a merge field drops that data column across every subscriber; do it in the Mailchimp UI
- `options` carries type-specific config: `choices` for dropdown/radio, `date_format` for date/birthday, `phone_format` for phone

---

### `mailchimp_campaigns` <sub>tool</sub>

- `list`/`get`/`create`/`update`/`replicate` for campaign records; `get-content`/`set-content` manage the HTML/plaintext payload
- `get-checklist` runs Mailchimp's send-readiness checklist without sending; `cancel-send` aborts an in-flight send
- `create-resend` builds a resend-to-non-openers draft; `pause-rss`/`resume-rss` control RSS-driven campaigns
- No `send`/`send-test`/`schedule`/`delete` — use `mailchimp_send_campaign` or `mailchimp_replicate_campaign` for dispatch (checklist-validated, gated on `confirmSend: true`); delete would destroy report history on a sent campaign
- `set-content` accepts `html`, `plainText`, `templateId` + `templateSections`, an archive payload, a fetch `url`, or `localTemplate` (mutually exclusive with `html`/`templateId`)

---

### `mailchimp_send_campaign` <sub>tool</sub>

- Chains create → set-content → checklist → optional test → send/schedule in one call
- `mode` defaults to `draft`; `send`/`schedule` require `confirmSend: true` plus a re-entrant confirmation round before any campaign mutation
- Blocking checklist errors throw `pre_send_checklist_failed` before dispatch; `cleanupOnError: true` (default) deletes the orphaned draft on any mid-flow failure
- `scheduleTime` must be at least 15 minutes in the future; `testEmails` caps at 50 recipients

---

### `mailchimp_replicate_campaign` <sub>tool</sub>

- Duplicates an existing campaign, then optionally overrides subject/previewText/fromName/replyTo/title/audience/segment/content before draft/test/send/schedule
- Same `confirmSend: true` plus re-entrant confirmation and `cleanupOnError` semantics as `mailchimp_send_campaign`
- `overridesApplied[]` in the output lists which overrides actually took effect

---

### `mailchimp_reports` <sub>tool</sub>

- `list`/`get` are report-index reads; `slice` pulls one dimension via `dimension` (abuse-reports, advice, click-details, open-details, domain-performance, eepurl, email-activity, locations, sent-to, unsubscribed)
- `click-details` drills into one URL with `linkId`; `open-details` drills into one member with `subscriberHash`
- `get`/`slice` throw `campaign_not_sent` when the campaign has no send yet
- For a full digest in one call, prefer `mailchimp_campaign_report`

---

### `mailchimp_campaign_report` <sub>tool</sub>

- One call parallelizes headline delivery/engagement metrics with top-N clicked links, top locations, and recent unsubscribes (`includeTopN`, 1–100, default 10)
- Throws `campaign_not_sent` if the campaign hasn't been dispatched yet
- Includes industry benchmarks when Mailchimp reports them for the account's declared vertical

---

### `mailchimp_templates` <sub>tool</sub>

- `list`/`get`/`get-default-content` are reads that work on free for `base`/`user` template types; `create`/`update`/`delete` are paid-tier writes regardless of type
- `gallery` (drag-and-drop) is read-gated to paid plans too
- Per-section edits aren't supported here — Mailchimp's PATCH only accepts `name`/`html`/`folderId`; per-section overrides at send time go through `mailchimp_campaigns` (`set-content`) or `mailchimp_send_campaign`'s `templateSections`
- Prefer `mailchimp_local_templates` for authoring — it works on every plan tier

---

### `mailchimp_files` <sub>tool</sub>

- `upload`/`list`/`get`/`update`/`delete` manage Mailchimp File Manager (Content Studio); works on every plan tier including free
- Size caps: 1 MB per image, 10 MB per other file; `fileData` is base64 with no `data:` prefix
- Upload response's `fullSizeUrl` is the public CDN URL to embed in campaign HTML
- `update` with `folderId: 0` moves a file to root; folder CRUD isn't exposed — use the Mailchimp UI or upload to root
- WebP/AVIF aren't in Mailchimp's allowed-extension list — convert to PNG/JPG first

---

### `mailchimp_search` <sub>tool</sub>

- `scope: members` matches across all audiences (or one via `audienceId`); `scope: campaigns` matches subject/title/preview/archive text
- Member results split into `exact` and `fuzzy` arrays with separate upstream totals
- Capped at `includeTopN` results (1–100, default 10); use `mailchimp_find_subscriber` for full subscriber detail and tags

---

### `mailchimp_assets` <sub>tool</sub>

- Conditional — registered only when `MAILCHIMP_ASSETS_DIR` is set
- `list`/`info`/`sync`/`clear-cache` inspect and pre-warm the local-assets pipeline; most workflows never call this directly
- `@assets/<path>` references in campaign HTML auto-upload via `mailchimp_send_campaign`, `mailchimp_replicate_campaign`, or `mailchimp_campaigns set-content` — hash → upload cache misses → cache `sha256 → fileId/URL` at `<assetsDir>/.mailchimp-cache.json` → rewrite to the CDN URL
- Path traversal (`..`, absolute paths) is rejected; deleting the cache file forces re-upload on next reference
- Node-only

---

### `mailchimp_local_templates` <sub>tool</sub>

- Conditional — registered only when `MAILCHIMP_TEMPLATES_DIR` is set
- `list`/`get`/`render-preview`/`seed-from-mailchimp` manage `.eta` template files (Eta v4 — partials, conditionals, loops) with optional YAML frontmatter (`subject`, `previewText`, `vars`) or a legacy `<name>.meta.yaml` sidecar
- Canonical write path for templates on free-tier Mailchimp accounts, where the upstream `/templates` API is read-only
- When a template declares `vars`, every declared name must be present in `render-preview`'s `vars` input or the render fails — undeclared lookups fall back to an empty string
- `seed-from-mailchimp` bootstraps a local template from an existing Mailchimp `base`/`user` template by ID
- Reference from any campaign tool via `content.localTemplate` + `content.localTemplateVars`; mutually exclusive with `html`/`templateId`

---

### `mailchimp_playbook` <sub>tool</sub>

- `topic` selects a procedural playbook: `send`, `post-send-review`, `deliverability`, `list-hygiene`, `onboarding`, `subscriber-triage`, `design-campaign`
- Returns markdown `instructions` tailored to live account/audience state, a `liveState` snapshot, and `nextToolSuggestions` with pre-filled arguments
- Advice-only — makes no writes; the agent executes the suggested follow-up tool calls
- `design-campaign` includes the editorial-design reference (palette, typography, layout, graphics via CDN) tailored by audience size and engagement

---

### `mailchimp://account` <sub>resource</sub>

- Account snapshot as `application/json` — profile, plan, data center, total subscribers, `fetchedAt` timestamp
- No parameters; equivalent to `mailchimp_account` `operation: info`

---

### `mailchimp://audiences/{audienceId}` <sub>resource</sub>

- Audience snapshot — name, contact, stats, campaign defaults, double opt-in status
- `audienceId` comes from `mailchimp_audiences` `operation: list`

---

### `mailchimp://campaigns/{campaignId}` <sub>resource</sub>

- Campaign snapshot — status, settings, recipients summary, tracking, report summary
- `campaignId` comes from `mailchimp_campaigns` `operation: list`

---

### `mailchimp://campaigns/{campaignId}/report` <sub>resource</sub>

- Post-send headline metrics — bounces, opens, clicks, industry stats
- Throws a validation error if the campaign hasn't been sent yet

---

### `newsletter_from_source` <sub>prompt</sub>

- Arguments: `source` (URL or free-form brief, required), `audienceId` (optional — feeds live engagement state into `design-campaign`), `seasonalContext` (optional)
- Chains into `mailchimp_playbook` (`topic: design-campaign`) for audience-aware design guidance, then walks draft → test → send via `mailchimp_send_campaign`
- Returns a single user-role message carrying the full workflow instructions

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Mailchimp-specific:

- Auto-derives the API base URL and data center from the `-dc` suffix on the API key
- Safe-by-default send workflows — re-entrant confirmation before dispatch, pending-status imports, no permanent deletes from the agent surface
- Upstream requests share a configurable concurrency limit and 429 cooldown (`MAILCHIMP_CONCURRENCY_LIMIT`)
- Local-first authoring for assets and templates — bypasses the free tier's read-only Templates API and File Manager UI friction
- Declarative tag sync computes add/remove deltas instead of requiring callers to track state

Agent-friendly output:

- Provenance and freshness — plain-language `notes`/`note` fields explain empty results (e.g. "no growth history yet" vs. zero engagement)
- Graceful partial failure — `mailchimp_import_subscribers` and `mailchimp_segments` batch operations return per-row succeeded/failed with Mailchimp error codes instead of failing the whole request
- Discriminated output contracts — `operation`/`dimension` fields on multi-operation tools tell the caller which optional fields are populated
- Typed error contracts with required recovery hints — every declared error reason carries a `recovery` string describing the caller's next move

## Getting started

Add the following to your MCP client configuration file. See [`docs/api-key.md`](./docs/api-key.md) for how to generate a Mailchimp API key.

```json
{
  "mcpServers": {
    "mailchimp-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/mailchimp-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "MAILCHIMP_API_KEY": "your-key-with-dc-suffix-e.g.-us22"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "mailchimp-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/mailchimp-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "MAILCHIMP_API_KEY": "your-key-with-dc-suffix-e.g.-us22"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "mailchimp-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "MAILCHIMP_API_KEY=your-key-with-dc-suffix-e.g.-us22",
        "ghcr.io/cyanheads/mailchimp-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 MAILCHIMP_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A Mailchimp Marketing API key — the key's `-dc` suffix (e.g. `-us22`) identifies your data center and is parsed at startup.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/mailchimp-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd mailchimp-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set MAILCHIMP_API_KEY
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MAILCHIMP_API_KEY` | **Required.** Mailchimp Marketing API key including `-dc` suffix (e.g. `abc…-us22`). | — |
| `MAILCHIMP_BASE_URL` | Override API base URL (for mock servers or tests). | `https://{dc}.api.mailchimp.com/3.0` |
| `MAILCHIMP_TIMEOUT_MS` | Per-request timeout in milliseconds. | `60000` |
| `MAILCHIMP_MAX_RETRIES` | Max retry attempts for transient upstream failures (0-10). | `3` |
| `MAILCHIMP_CONCURRENCY_LIMIT` | Max in-flight upstream requests across all tools in this process (1-10). | `4` |
| `MAILCHIMP_ASSETS_DIR` | Absolute path to a local assets directory. Enables `mailchimp_assets` and auto-upload of `@assets/<path>` references in campaign HTML. Node-only. | unset |
| `MAILCHIMP_TEMPLATES_DIR` | Absolute path to a local templates directory. Enables `mailchimp_local_templates` and `content.localTemplate` on campaign tools. Node-only. | unset |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | `auto`, `stateful`, or `stateless`; `auto` resolves to stateful. HTTP requires stateful for campaign confirmation and rejects a stateless override. Stdio is unaffected. | `stateful` |
| `MCP_HTTP_HOST` | HTTP server hostname. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Local assets (optional)

Set `MAILCHIMP_ASSETS_DIR` to enable a local-image workflow on top of Mailchimp's File Manager. Drop image files into the directory, reference them in HTML as `@assets/<relative-path>`, and the server uploads + rewrites at send time.

```sh
export MAILCHIMP_ASSETS_DIR=/Users/me/Pictures/email-assets
```

Then in a campaign:

```html
<img src="@assets/hero.png" alt="Hero">
<a href="@assets/whitepaper.pdf">Download</a>
```

When `mailchimp_send_campaign` (or `mailchimp_campaigns set-content` / `mailchimp_replicate_campaign contentOverride`) sees these references, it:

1. Hashes each referenced file (SHA-256).
2. Uploads cache misses to Mailchimp File Manager via the `mailchimp_files` tool surface.
3. Caches `sha256 → file_id + URL` at `<assetsDir>/.mailchimp-cache.json` (atomic writes; safe to delete to force re-upload).
4. Rewrites every `@assets/<path>` to the public CDN URL before passing content upstream.

The `mailchimp_assets` tool exposes `list`, `info`, `sync` (pre-warm), and `clear-cache` for direct inspection — most workflows don't need it.

**Caveats:**
- Mailchimp caps images at **1 MB** and other files at **10 MB**. Oversize files fail before upload with an actionable error.
- Allowed extensions: see the `mailchimp_files` tool description. **WebP and AVIF are NOT in the allowlist** — convert to PNG/JPG.
- Path traversal is rejected (`../` and absolute paths throw `Forbidden`).
- The `mailchimp_assets` tool is **Node-only**.

## Local templates (optional)

Set `MAILCHIMP_TEMPLATES_DIR` to enable a local-template authoring workflow on top of [Eta](https://eta.js.org/) (v4 — fast, ESM-native, supports partials/conditionals/loops). **This is the canonical write path for templates on free-tier Mailchimp accounts**, where the upstream `/templates` API is read-only.

```sh
export MAILCHIMP_TEMPLATES_DIR=/Users/me/email-templates
```

```text
email-templates/
  welcome.eta              # body + optional YAML frontmatter
  newsletter.eta
  partials/
    header.eta
    footer.eta
```

Template (`welcome.eta`) — YAML frontmatter on top, Eta body below:

```eta
---
subject: "Welcome to {{brand}}"
previewText: "Onboarding starts here"
vars:
  - firstName
  - brand
---
<%~ include('partials/header', it) %>
<h1>Hello <%= it.firstName %></h1>
<p>Welcome to <%= it.brand %>.</p>
<img src="@assets/hero.png" alt="Hero">
```

Frontmatter and its fields are optional. When `vars:` is present, every listed variable must be supplied; undeclared variable lookups render as an empty string.

> **Sidecar fallback (legacy):** prior to v0.3.1, meta lived in a separate `<name>.meta.yaml` file next to the body. That form still works for backward compatibility — if a `.eta` has no frontmatter, the loader falls back to reading the sidecar. Frontmatter takes precedence when both exist.

Reference from any campaign tool:

```jsonc
{
  "audienceId": "abc123",
  "subject": "Welcome to Acme",
  "fromName": "Casey",
  "replyTo": "casey@acme.com",
  "content": {
    "localTemplate": "welcome",
    "localTemplateVars": { "firstName": "Sam", "brand": "Acme" }
  },
  "mode": "draft"
}
```

The render pipeline:
1. Eta renders `welcome.eta` with `it = { firstName: 'Sam', brand: 'Acme' }`.
2. If L1 is configured, `@assets/hero.png` is uploaded to Mailchimp File Manager and rewritten to a CDN URL.
3. Final HTML is set on the campaign via Mailchimp's `set-content`.

The `mailchimp_local_templates` tool exposes `list`, `get`, `render-preview` (returns HTML without sending), and `seed-from-mailchimp` (reads a Mailchimp `base`/`user` template by ID and writes it to disk as a starting point — useful on free where you can read but not write upstream).

### Example templates in this repo

The [`templates/`](./templates) directory holds working examples — point `MAILCHIMP_TEMPLATES_DIR` at it directly to try them, or copy them into your own dir as a starting point:

| Template | What it shows |
|:---------|:--------------|
| [`welcome.eta`](./templates/welcome.eta) | Minimal body — frontmatter declaring `subject` / `previewText` / `vars`, `<%= it.firstName %>` interpolation, `<% if %>` conditional CTA block |
| [`redden-gardens-april-2026.eta`](./templates/redden-gardens-april-2026.eta) | Full inline-styled HTML newsletter. Demonstrates the recommended split: **Mailchimp merge tags** (`*\|FNAME\|*`) for per-recipient personalization on real list sends, **Eta vars** (volume / issue / monthYear / URLs) for list-wide constants substituted at template-render time |

**Caveats:**
- `localTemplate` is mutually exclusive with `html` and `templateId` on the same content block.
- Missing declared variables fail before rendering; extra variables are allowed.
- Path traversal is rejected.


## Running the server

### Local development

- **Watch mode** (transport via `MCP_TRANSPORT_TYPE`):

  ```sh
  bun run dev                                     # stdio (default)
  MCP_TRANSPORT_TYPE=http bun run dev             # http
  ```

- **Build and run:**

  ```sh
  bun run rebuild
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t mailchimp-mcp-server .
docker run --rm -e MAILCHIMP_API_KEY=your-key-us22 -p 3010:3010 mailchimp-mcp-server
```

The Dockerfile defaults to HTTP transport, stateful session mode, and logs to `/var/log/mailchimp-mcp-server`. Stateful HTTP preserves campaign confirmation for 2025-era clients. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Eighteen always-on tools plus two conditional local-workspace tools. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Four snapshot resources. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). Newsletter starter prompt. |
| `src/services/mailchimp` | Mailchimp client wrapper — HTTP plumbing, retries, normalization, typed surface. |
| `templates/` | Example `.eta` templates (frontmatter + Eta syntax) — point `MAILCHIMP_TEMPLATES_DIR` here to try them. |
| `tests/` | Vitest coverage for configuration, services, tool workflows, output formatting, framework contracts, and regressions. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
