<div align="center">
  <h1>@cyanheads/mailchimp-mcp-server</h1>
  <p><b>Draft, test, and send Mailchimp campaigns straight from your MCP client — with audience management, subscriber CRUD, and post-send analytics behind safe-by-default send gates. STDIO or Streamable HTTP.</b>
  <div>18 Tools (+2 conditional) • 4 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.12-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/mailchimp-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/mailchimp-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/mailchimp-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/mailchimp-mcp-server/releases/latest/download/mailchimp-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=mailchimp-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbWFpbGNoaW1wLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7Ik1BSUxDSElNUF9BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22mailchimp-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fmailchimp-mcp-server%22%5D%2C%22env%22%3A%7B%22MAILCHIMP_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Mailchimp campaign management over the Mailchimp Marketing API v3. Draft, test, and send email campaigns, manage audiences and subscribers, and review post-send analytics from any MCP client, with optional local image and template directories for authoring. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `mailchimp_account` | Account profile, plan, data center, and the Chimp Chatter activity feed |
| `mailchimp_audiences` | Read, create, and update audiences (lists), with per-audience analytics and signup-form config |
| `mailchimp_audience_overview` | One-call audience digest: info, stats, growth history, top email clients, merge-field schema |
| `mailchimp_subscribers` | Subscriber reads, updates, archive, tags, notes, and engagement history |
| `mailchimp_upsert_subscriber` | Add or update one subscriber idempotently, with status, merge fields, tags, and a note |
| `mailchimp_find_subscriber` | Locate a subscriber by email in one audience or across the account |
| `mailchimp_import_subscribers` | Batch add or update up to 500 subscribers per call, `pending` by default |
| `mailchimp_segments` | Segment CRUD (saved, static, fuzzy), member listing, and batch add/remove |
| `mailchimp_merge_fields` | Read, create, and update custom subscriber attributes |
| `mailchimp_campaigns` | Campaign records, content, send checklist, and RSS/resend controls |
| `mailchimp_send_campaign` | Compose a campaign and leave it as a draft, test it, send it, or schedule it in one call |
| `mailchimp_replicate_campaign` | Duplicate a campaign with overrides, then draft, test, send, or schedule |
| `mailchimp_reports` | Campaign reports: the index, one report, or one of ten report dimensions |
| `mailchimp_campaign_report` | Post-send digest: headline metrics plus top links, locations, and unsubscribes |
| `mailchimp_templates` | Mailchimp-hosted templates; reads work on free plans, writes need a paid plan |
| `mailchimp_files` | File Manager uploads, listing, renames, and deletes on Mailchimp's CDN |
| `mailchimp_search` | Search members or campaigns across the account |
| `mailchimp_assets` *(conditional: `MAILCHIMP_ASSETS_DIR`)* | Inspect and pre-warm uploads for `@assets/<path>` references in campaign HTML |
| `mailchimp_local_templates` *(conditional: `MAILCHIMP_TEMPLATES_DIR`)* | Author and render local `.eta` templates, the template write path on free plans |
| `mailchimp_playbook` | Procedural playbooks merged with live account state; advice only |

### Resources

| Resource | Description |
|:---|:---|
| `mailchimp://account` | Account snapshot: profile, plan, data center, total subscribers |
| `mailchimp://audiences/{audienceId}` | Audience snapshot: name, contact, stats, double opt-in status |
| `mailchimp://campaigns/{campaignId}` | Campaign snapshot: status, settings, recipients |
| `mailchimp://campaigns/{campaignId}/report` | Post-send headline metrics for a campaign |

All resource data is also reachable through tools; audiences and campaigns are listed with each tool's `list` operation.

### Prompts

| Prompt | Description |
|:---|:---|
| `newsletter_from_source` | Compose an editorial newsletter from a URL or brief, then walk it through draft, test, and send |

Design reference: [`docs/email-design-playbook.md`](./docs/email-design-playbook.md).

## Capability reference

### `mailchimp_account` <sub>tool</sub>

- `operation: info` returns profile, plan, data center, total subscribers, and industry benchmarks; `operation: activity-feed` returns Chimp Chatter events, paged by `count` (max 100, default 20) and `offset`
- An empty activity feed carries a `note` naming the likely causes

---

### `mailchimp_audiences` <sub>tool</sub>

- Operations: `list`, `get`, `create`, `update`, the analytics reads `list-activity`, `list-growth`, `list-clients`, `list-abuse-reports`, `list-locations`, and `get-signup-forms` / `customize-signup-forms` (takes `signupFormConfig`); every operation except `list` and `create` needs `audienceId`
- `create` requires `name`, `contact` (`company`, `address1`, `city`, `state`, `zip`, `country`), `permissionReminder`, and `campaignDefaults` (`fromName`, `fromEmail`, `language`)

---

### `mailchimp_audience_overview` <sub>tool</sub>

- `audienceId` plus `growthMonths` (1–36, default 12); returns info, stats, contact, campaign defaults, growth history, top email clients, and the merge-field schema
- `notes[]` explains empty growth or email-client arrays, separating "no data yet" from zero engagement

---

### `mailchimp_subscribers` <sub>tool</sub>

- `audienceId` on every call and `email` on every operation except `list` (filterable by `status`); operations: `list`, `get`, `update`, `archive`, `list-tags`, `set-tags`, `list-notes` / `add-note` / `update-note` / `delete-note` (by `noteId`), and `list-activity` / `list-events` / `list-goals`
- `set-tags` is declarative: `tags` becomes the full active set and every other tag is removed unless named in `preserveTags`. Mailchimp stores static-segment membership as a tag, so an unguarded sync drops it. Returns `tagsAdded`, `tagsRemoved`, and `tagsActive`

---

### `mailchimp_upsert_subscriber` <sub>tool</sub>

- `audienceId`, `email`, and `status` required; optional `mergeFields`, `tags` + `preserveTags` (same declarative sync as `set-tags`), `note`, `vip`, `language`; `updateExistingStatus: false` applies `status` to new records only
- Returns `isNew`, the resulting `status`, `tagsAdded` / `tagsRemoved` / `tagsFinal`, `noteAttached`, and `webUrl`
- `status: "pending"` sends Mailchimp's double opt-in email; `"subscribed"` needs documented consent

---

### `mailchimp_find_subscriber` <sub>tool</sub>

- `email`, scoped to one `audienceId` or, when omitted, every audience on the account (echoed as `searchedAcross`)
- Returns `exactMatches` and `fuzzyMatches` with merge fields and stats; `includeTags` (default `true`) adds each match's tags at one extra call per match

---

### `mailchimp_import_subscribers` <sub>tool</sub>

- `audienceId` and 1–500 `subscribers` rows per call; `status` defaults to `pending` (double opt-in) and a per-row `status` overrides it; `updateExisting` defaults to `false`, so existing records are skipped
- Returns `totalCreated`, `totalUpdated`, `errorCount`, and per-row `succeeded` and `failed` entries, failures carrying Mailchimp's `errorCode`

---

### `mailchimp_segments` <sub>tool</sub>

- `audienceId` on every call and `segmentId` on every operation except `list` (filterable by `type`: `saved`, `static`, `fuzzy`) and `create`; `create` / `update` take `name`, `staticEmails`, or saved-segment `options`
- `batch-update-members` applies `membersToAdd` / `membersToRemove` to a static segment and returns `added`, `removed`, and per-email `errors`
- Free plans get static and basic saved segments; advanced conditions need Premium and fail as `mailchimp_forbidden`

---

### `mailchimp_merge_fields` <sub>tool</sub>

- `list`, `get`, `create`, `update`; `create` requires `name`, `tag` (10 characters max), and `type`; `get` / `update` take `mergeId`
- `options` carries type-specific config: `choices` for `dropdown` / `radio`, `date_format` for `date` / `birthday`, `phone_format` for `phone`

---

### `mailchimp_campaigns` <sub>tool</sub>

- Operations: `list` (filter by `status`, `listId`, `sinceSendTime` / `beforeSendTime`), `get`, `create` (`type` of `regular` / `plaintext` / `rss`, plus `recipients` and `settings`), `update`, `replicate`, `get-content`, `set-content`, `get-checklist`, `cancel-send`, `create-resend`, `pause-rss`, `resume-rss`; all but `list` and `create` take `campaignId`
- `set-content` accepts `html`, `plainText`, `templateId` + `templateSections`, `archiveContent`, `url`, or `localTemplate` (exclusive with `html` and `templateId`); `get-checklist` returns `isReady` and typed items
- No send, test, schedule, or delete here; dispatch goes through `mailchimp_send_campaign` or `mailchimp_replicate_campaign`

---

### `mailchimp_send_campaign` <sub>tool</sub>

- `audienceId`, `subject`, `fromName`, `replyTo`, and `content` (at least one of `html`, `plainText`, `templateId`, `localTemplate`) required; `mode` is `draft` (default), `test` (needs `testEmails`, max 50), `send`, or `schedule` (needs `scheduleTime` at least 15 minutes out)
- Returns `campaignId`, the effective `mode`, `status`, `recipientCount`, `webUrl`, and non-blocking `checklistWarnings`; blocking checklist errors throw `pre_send_checklist_failed` outside `draft`, and `cleanupOnError` (default `true`) deletes the draft after a mid-flow failure
- `send` and `schedule` require `confirmSend: true`, then a confirmation prompt before any campaign is created; declining leaves a draft and sets `cancelledByUser`
- Confirmation is single-use and bound to the caller, audience, mode, and resolved content. Changed content or a replay requests fresh confirmation; campaign creation and replication are never automatically retried after an ambiguous upstream failure.

---

### `mailchimp_replicate_campaign` <sub>tool</sub>

- `sourceCampaignId` plus optional `subjectOverride`, `previewTextOverride`, `fromNameOverride`, `replyToOverride`, `titleOverride`, `audienceOverride`, `segmentOverride`, and `contentOverride`; `mode`, `testEmails`, `scheduleTime`, and `cleanupOnError` work as in `mailchimp_send_campaign`
- Returns the new `campaignId`, `overridesApplied[]`, and the same status, checklist, and `cancelledByUser` fields
- Same `confirmSend: true` plus confirmation-prompt gate for `send` and `schedule`

---

### `mailchimp_reports` <sub>tool</sub>

- `list` (filter by `type`, `sinceSendTime` / `beforeSendTime`), `get`, or `slice` with a `campaignId` and a `dimension`: `abuse-reports`, `advice`, `click-details` (one URL via `linkId`), `open-details` (one member via `subscriberHash`), `domain-performance`, `eepurl`, `email-activity`, `locations`, `sent-to`, `unsubscribed`
- `slice` returns `rows` shaped by the dimension plus `totalItems`; `get` throws `campaign_not_sent` for a campaign with no send

---

### `mailchimp_campaign_report` <sub>tool</sub>

- `campaignId` plus `includeTopN` (1–100, default 10) rows per slice
- Returns `delivery` (delivered, bounces by type, abuse reports), `engagement` (opens, clicks, unsubscribes), `topClickedLinks`, `topLocations`, `recentUnsubscribes`, and `industryBenchmarks` when Mailchimp has them; throws `campaign_not_sent` for a campaign with no send

---

### `mailchimp_templates` <sub>tool</sub>

- `list` (filter by `type` of `user` / `base` / `gallery`, `category`, `folderId`), `get`, `get-default-content`, `create`, `update`, and `delete`; `update` accepts only `name`, `html`, and `folderId`, so per-section edits go through a campaign's `templateSections`
- Reads of `base` and `user` templates work on free plans; writes and `gallery` reads need a paid plan and fail as `mailchimp_forbidden`. `mailchimp_local_templates` is the authoring path on every plan

---

### `mailchimp_files` <sub>tool</sub>

- `list` (filter by `type`, `folderId`, `sinceCreatedAt` / `beforeCreatedAt`), `get`, `upload` (`name` with extension plus base64 `fileData`, no `data:` prefix), `update` (rename, or move with `folderId`, `0` for root), `delete`, and read-only `list-folders` / `get-folder`; uploads cap at 1 MB per image and 10 MB per other file, and `.webp` / `.avif` are not accepted
- `upload` and `get` return `fullSizeUrl`, the public CDN URL to embed in campaign HTML; `list` adds `totalFileSizeInBytes`

---

### `mailchimp_search` <sub>tool</sub>

- `scope` (`members` or `campaigns`) and `query`; `audienceId` narrows a member search; `includeTopN` (1–100, default 10) caps each result array
- Members return as `exact` and `fuzzy` with upstream `totalExact` / `totalFuzzy`; campaigns as `matches` with a `snippet` and `totalMatches`; an empty result carries a `note`

---

### `mailchimp_assets` <sub>tool</sub>

- `list`, `info` (by `relPath`; returns `sha256` and any `cached` upload), `sync` (uploads uncached files ahead of a send; returns `uploaded`, `cached`, and `skipped` with reasons), and `clear-cache`
- `@assets/<path>` references in content passed to `mailchimp_send_campaign`, `mailchimp_replicate_campaign`, or `mailchimp_campaigns` `set-content` upload to File Manager and are rewritten to CDN URLs. Uploads are cached by SHA-256 in `<assetsDir>/.mailchimp-cache.json`; oversize files and paths outside the directory are rejected before upload
- Listed only when `MAILCHIMP_ASSETS_DIR` is set

---

### `mailchimp_local_templates` <sub>tool</sub>

- `list`, `get` (source plus parsed metadata), `render-preview` (`name` plus `vars`; returns HTML, sends nothing), and `seed-from-mailchimp` (writes Mailchimp template `mailchimpTemplateId` to disk as `name`)
- Templates are `.eta` files with optional YAML frontmatter for `subject`, `previewText`, and `vars`; a declared var left unsupplied fails the render. Campaign tools render one via `content.localTemplate` + `content.localTemplateVars`, exclusive with `html` and `templateId`. [Example templates](./templates)
- Listed only when `MAILCHIMP_TEMPLATES_DIR` is set

---

### `mailchimp_playbook` <sub>tool</sub>

- `topic`: `send`, `post-send-review`, `deliverability`, `list-hygiene`, `onboarding`, `subscriber-triage`, or `design-campaign`; `audienceId` for `send` / `list-hygiene` / `design-campaign`, `campaignId` for `post-send-review`, `email` for `subscriber-triage`
- Returns markdown `instructions` tuned to live numbers, a `liveState` snapshot, and `nextToolSuggestions` with pre-filled inputs; makes no writes

---

### `mailchimp://account` <sub>resource</sub>

- No parameters; `application/json` with profile, plan, data center, total subscribers, and `fetchedAt`
- Same data as `mailchimp_account` `operation: info`

---

### `mailchimp://audiences/{audienceId}` <sub>resource</sub>

- Name, contact, stats, campaign defaults, permission reminder, double opt-in status, and subscribe URL
- `audienceId` comes from `mailchimp_audiences` `operation: list`

---

### `mailchimp://campaigns/{campaignId}` <sub>resource</sub>

- Status, settings, recipients, tracking, and report summary
- `campaignId` comes from `mailchimp_campaigns` `operation: list`

---

### `mailchimp://campaigns/{campaignId}/report` <sub>resource</sub>

- Emails sent, bounces, opens, clicks, unsubscribes, abuse reports, and industry stats
- Fails with a validation error until the campaign has been sent

---

### `newsletter_from_source` <sub>prompt</sub>

- Arguments: `source` (URL or free-form brief) required; `audienceId` and `seasonalContext` optional
- Returns one user message that chains `mailchimp_playbook` (`topic: design-campaign`) into an HTML draft, then draft, test, and send via `mailchimp_send_campaign`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Mailchimp-specific:

- Marketing API v3 client that derives the API host and data center from the key's `-<dc>` suffix, with retries, a process-wide concurrency limit (`MAILCHIMP_CONCURRENCY_LIMIT`), and a cooldown after a 429
- Send gates: campaign workflows default to `draft`, `send` / `schedule` need `confirmSend: true` plus a confirmation prompt, and bulk imports default to `pending`
- No irreversible deletes: removing audiences, merge fields, or campaigns, and permanently deleting subscribers, stay in the Mailchimp UI; `archive` is the strongest subscriber removal
- Local authoring: `@assets/<path>` files upload and rewrite at send time, and `.eta` templates render locally, which covers free plans where the Templates API is read-only
- List operations page with `count` (max 1000) and `offset`

Agent-friendly output:

- Explained empties: `note` / `notes[]` on empty activity feeds, audience overviews, and searches say whether data is missing or genuinely zero
- Partial failure: `mailchimp_import_subscribers` and `mailchimp_segments` `batch-update-members` return per-row successes and errors instead of failing the batch
- Discriminated outputs: `operation`, `dimension`, and `mode` say which fields are populated; `isNew` and `cancelledByUser` report what actually happened
- Typed errors: every declared reason (`campaign_not_sent`, `pre_send_checklist_failed`, `mailchimp_forbidden`, …) carries a recovery hint for the caller's next move

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
- A Mailchimp Marketing API key. Its `-dc` suffix (e.g. `-us22`) identifies your data center and is parsed at startup.

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
|:---|:---|:---|
| `MAILCHIMP_API_KEY` | **Required.** Marketing API key, including the `-dc` suffix (e.g. `abc…-us22`). | none |
| `MAILCHIMP_BASE_URL` | API base URL override, for mock servers or tests. | `https://{dc}.api.mailchimp.com/3.0` |
| `MAILCHIMP_TIMEOUT_MS` | Per-request timeout, in ms. | `60000` |
| `MAILCHIMP_MAX_RETRIES` | Retry attempts for transient upstream failures (0–10). | `3` |
| `MAILCHIMP_CONCURRENCY_LIMIT` | Max in-flight upstream requests across the process (1–10). | `4` |
| `MAILCHIMP_ASSETS_DIR` | Absolute path to a local assets directory. Enables `mailchimp_assets` and `@assets/<path>` uploads in campaign HTML. | none |
| `MAILCHIMP_TEMPLATES_DIR` | Absolute path to a local templates directory. Enables `mailchimp_local_templates` and `content.localTemplate` on campaign tools. | none |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | Explicitly `stateful` for campaign confirmation. The framework schema default, `auto`, resolves to stateful. `stateless` refuses HTTP startup; stdio is unaffected. | `stateful` |
| `MCP_REQUEST_STATE_KEY` | Optional sealing key of at least 32 bytes. Consent records remain single-use and process-bound; a restart or a retry reaching another instance requires fresh confirmation. | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL for traces and metrics; appends `/v1/traces` and `/v1/metrics`. Signal-specific endpoint overrides are listed in `.env.example`. | none |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log endpoint, used as-is. The base endpoint does not enable log export. | none |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed-call arguments and results, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). Secrets inside free-form values remain visible. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Watch mode** (transport via `MCP_TRANSPORT_TYPE`):

  ```sh
  bun run dev                           # stdio (default)
  MCP_TRANSPORT_TYPE=http bun run dev   # http
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

The Dockerfile defaults to HTTP transport, stateful session mode, and logs to `/var/log/mailchimp-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers tools, resources, and the prompt, and initializes services. |
| `src/config` | `MAILCHIMP_*` environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) plus shared helpers for template rendering, asset rewriting, and send confirmation. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). |
| `src/services/mailchimp` | Mailchimp API client: HTTP, request pacing, retries, response normalization. |
| `src/services/assets` | Local assets: discovery, hashing, upload cache, `@assets/` rewriting. |
| `src/services/templates` | Local templates: Eta rendering, frontmatter parsing, seeding from Mailchimp. |
| `templates/` | Example `.eta` templates; point `MAILCHIMP_TEMPLATES_DIR` here to try them. |
| `docs/` | API key guide and the email design playbook. |
| `tests/` | Vitest suites for config, services, tools, and the prompt. |

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
