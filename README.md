<div align="center">
  <h1>@cyanheads/mailchimp-mcp-server</h1>
  <p><b>Draft, test, and send Mailchimp campaigns straight from your MCP client — with audience management, subscriber CRUD, and post-send analytics behind safe-by-default send gates. STDIO or Streamable HTTP.</b>
  <div>18 Tools (+2 conditional) • 4 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/mailchimp-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/mailchimp-mcp-server) [![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) 

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

---

## Tools

Eighteen always-on tools plus two conditional ones — `mailchimp_assets` (when `MAILCHIMP_ASSETS_DIR` is set) and `mailchimp_local_templates` (when `MAILCHIMP_TEMPLATES_DIR` is set). Workflow helpers orchestrate common flows end-to-end, primitive tools expose fine-grained CRUD, and the instruction tool returns procedural guidance merged with live account state.

| Tool Name | Description |
|:----------|:------------|
| `mailchimp_account` | Account profile, plan, data center, total subscribers, and the Chimp Chatter activity feed. |
| `mailchimp_audiences` | Manage audiences (lists) — read, create/update, per-audience analytics, signup-form config. No delete. |
| `mailchimp_audience_overview` | One-call audience health digest: info, stats, growth history, top email clients, merge-field schema. |
| `mailchimp_subscribers` | Subscriber CRUD + tags/notes/activity. `archive` is the strongest delete available. |
| `mailchimp_upsert_subscriber` | Add or update a subscriber idempotently with status, merge fields, tags, and optional note. |
| `mailchimp_find_subscriber` | Locate a subscriber by email in one audience or across the account. |
| `mailchimp_import_subscribers` | Batch add/update subscribers (capped at 500/call). Status defaults to `pending` (double-opt-in). |
| `mailchimp_segments` | CRUD for audience segments (saved, static, fuzzy) plus member listing and batch add/remove. |
| `mailchimp_merge_fields` | Read + create/update custom subscriber attributes. No delete — drops data across all subscribers. |
| `mailchimp_campaigns` | Campaign record management: list/get/create/update, replicate, content, checklist, RSS/resend controls. |
| `mailchimp_send_campaign` | Compose and send (or schedule/test) a campaign in one call. Elicits human confirmation on send/schedule. |
| `mailchimp_replicate_campaign` | Duplicate a campaign with optional overrides, then draft/test/send/schedule. Same elicit + cleanup semantics. |
| `mailchimp_reports` | Campaign reports — generic slicer across ten dimensions (clicks, opens, locations, etc.). |
| `mailchimp_campaign_report` | Post-send analytics digest — headline metrics + top 5 slices in one response. |
| `mailchimp_templates` | Email template read/write — reads (`list`/`get`) work on free for `base`/`user` types; writes (`create`/`update`/`delete`) and `gallery` require a paid plan. |
| `mailchimp_files` | File Manager (Content Studio) — upload, list, fetch, rename, delete files on Mailchimp's CDN. Embed the returned `fullSizeUrl` in campaign HTML. Works on free; 1 MB per image / 10 MB per other file. |
| `mailchimp_search` | Global search across members or campaigns. Lightweight discovery — use `find_subscriber` for detail. |
| `mailchimp_assets` *(conditional — set `MAILCHIMP_ASSETS_DIR`)* | Local-assets surface. List your assets dir, inspect cache state, pre-warm uploads ahead of a send. Most workflows don't call this directly — `@assets/<path>` references in campaign HTML auto-upload via `mailchimp_send_campaign` and `mailchimp_campaigns set-content`. |
| `mailchimp_local_templates` *(conditional — set `MAILCHIMP_TEMPLATES_DIR`)* | Local-template authoring surface. List/get/render-preview your `.eta` templates with optional `<name>.meta.yaml` sidecars. `seed-from-mailchimp` bootstraps a local template from a Mailchimp `base`/`user` starter. Use `content.localTemplate` on campaign tools to render at send time. **Canonical write path on free-tier Mailchimp**, where the upstream templates API is read-only. |
| `mailchimp_playbook` | Returns a structured procedural playbook merged with live account state. Advice-only, no writes. |

---

### `mailchimp_send_campaign`

Compose and send (or schedule/test) a campaign in one call.

- Chains create → content → checklist → optional test → send/schedule
- Requests human confirmation via `ctx.elicit` when `mode: 'send' | 'schedule'` and the client supports elicitation
- Auto-deletes aborted or failed drafts when `cleanupOnError: true` (default)
- Supports `html`, `plaintext`, and `templateId + mergeData` content forms

---

### `mailchimp_replicate_campaign`

Duplicate an existing campaign with optional overrides, then send/schedule/test or leave as draft.

- Overrides: subject, from name, reply-to, audience, segment, content
- Same elicit confirmation + cleanup semantics as `mailchimp_send_campaign`
- Tuned for the common "send v2 of last week's newsletter with an updated intro" pattern

---

### `mailchimp_upsert_subscriber`

Add or update a subscriber in one idempotent call.

- Declarative tag sync — pass the desired active set and the tool computes the add/remove delta
- `preserveTags` protects named segment memberships (Mailchimp stores static-segment membership as tags)
- `status: 'pending'` triggers Mailchimp's double-opt-in email; `'subscribed'` requires documented consent
- PUT `/members/{hash}` for create path, PATCH for update to skip re-validating pre-existing merge fields

---

### `mailchimp_import_subscribers`

Batch add (and optionally update) subscribers in one call.

- Capped at 500 rows per call — chunk larger imports client-side
- Status defaults to `pending` (double-opt-in) to prevent accidental mass-sends
- Returns per-row succeeded/failed with error reasons

---

### `mailchimp_campaign_report`

Aggregated post-send analytics for a campaign.

- Headline delivery metrics: sent, bounces, abuse reports
- Engagement: opens, clicks, unsubscribes
- Top-N clicked links, locations, recent unsubscribes
- Industry benchmarks when available
- Use `mailchimp_reports` with `operation: 'slice'` for a single dimension in detail

---

### `mailchimp_audience_overview`

Single-call audience health digest — answers "what does this audience look like?" in one request.

- Audience info + live stats
- Configurable months of growth history
- Top email clients
- Full merge-field schema
- Recent activity

---

### `mailchimp_playbook`

Returns a structured procedural playbook merged with live account state. Advice-only — the agent executes subsequent steps with other tools.

- Topics: `send`, `post-send-review`, `deliverability`, `list-hygiene`, `onboarding`, `subscriber-triage`, `design-campaign`
- Returns markdown instructions + a live-state snapshot
- `nextToolSuggestions` pre-fills arguments for the next likely tool call

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `mailchimp://account` | Account info snapshot — profile, plan, data center, total subscribers. |
| Resource | `mailchimp://audiences/{audienceId}` | Audience snapshot — name, contact, stats, double-opt-in status. |
| Resource | `mailchimp://campaigns/{campaignId}` | Campaign snapshot — status, settings, recipients summary. |
| Resource | `mailchimp://campaigns/{campaignId}/report` | Post-send campaign report headline metrics. |
| Prompt | `newsletter_from_source` | User-invokable starter — compose a monthly editorial newsletter from a URL or brief. Chains into `mailchimp_playbook` (`topic: design-campaign`) and walks the draft → test → send flow. |

All resource data is also reachable via tools. Large collections (`audiences`, `campaigns`) are not exposed as resources — use the `list` operation on the corresponding tool instead. Design reference for the prompt: [`docs/email-design-playbook.md`](./docs/email-design-playbook.md).

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Mailchimp-specific:

- Auto-derives the API base URL from the `-dc` suffix on the API key
- Safe-by-default send workflows — elicit confirmation, pending-status imports, no permanent deletes from agent surface
- Workflow tools parallelize related sub-requests under a configurable concurrency limit
- Domain normalization shapes sparse upstream payloads into compact, LLM-friendly output without fabricating values

## Getting started

Add the following to your MCP client configuration file. See [`docs/api-key.md`](./docs/api-key.md) for how to generate a Mailchimp API key.

```json
{
  "mcpServers": {
    "mailchimp": {
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
    "mailchimp": {
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
    "mailchimp": {
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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v22+).
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
| `MAILCHIMP_CONCURRENCY_LIMIT` | Max in-flight upstream requests per workflow tool (1-10). | `4` |
| `MAILCHIMP_ASSETS_DIR` | Absolute path to a local assets directory. When set (Node-only), enables the `mailchimp_assets` tool and auto-uploads `@assets/<path>` references in campaign HTML to Mailchimp File Manager. Cache at `<dir>/.mailchimp-cache.json`. | unset |
| `MAILCHIMP_TEMPLATES_DIR` | Absolute path to a local templates directory. When set (Node-only), enables the `mailchimp_local_templates` tool and support for `content.localTemplate` on campaign tools. Templates are `.eta` files with optional `<name>.meta.yaml` sidecars. | unset |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
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
- The `mailchimp_assets` tool is **Node-only**; on Cloudflare Workers it isn't registered.

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

Frontmatter is optional — a body with no `---` block is treated as a meta-less template. All meta fields are optional too. The `vars:` list is informational only (declared variables aren't schema-enforced).

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
- Var validation isn't enforced by the schema — missing/extra vars surface as Eta render errors at send time.
- Path traversal is rejected.
- Node-only; not available on Workers.

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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/mailchimp-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seventeen Mailchimp tools. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Four snapshot resources. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). Newsletter starter prompt. |
| `src/services/mailchimp` | Mailchimp client wrapper — HTTP plumbing, retries, normalization, typed surface. |
| `tests/` | Vitest tests mirroring `src/`. Currently only `config/` is covered; other subdirs are scaffolded for expansion. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```


## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
