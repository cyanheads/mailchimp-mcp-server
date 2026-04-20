<div align="center">
  <h1>@cyanheads/mailchimp-mcp-server</h1>
  <p><b>Draft, test, and send Mailchimp campaigns straight from your MCP client — with audience management, subscriber CRUD, and post-send analytics behind safe-by-default send gates. STDIO or Streamable HTTP.</b>
  <div>17 Tools • 4 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/mailchimp-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/mailchimp-mcp-server) [![Version](https://img.shields.io/badge/Version-0.2.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) 

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

---

## Tools

Seventeen tools grouped by shape — workflow helpers orchestrate common flows end-to-end, primitive tools expose fine-grained CRUD, and the instruction tool returns procedural guidance merged with live account state.

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
| `mailchimp_templates` | Email template CRUD (base, user; `gallery` requires a paid plan). |
| `mailchimp_search` | Global search across members or campaigns. Lightweight discovery — use `find_subscriber` for detail. |
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
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP server hostname. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Hot-reload dev mode:**

  ```sh
  bun run dev:stdio
  bun run dev:http
  ```

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
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
