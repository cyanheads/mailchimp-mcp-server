# Agent Protocol

**Server:** mailchimp-mcp-server
**Version:** 0.3.5
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
**Engines:** Bun ≥1.3.2, Node ≥24.0.0
**Surface:** 18 tools always-on · 2 conditional (`mailchimp_assets` when `MAILCHIMP_ASSETS_DIR` set, `mailchimp_local_templates` when `MAILCHIMP_TEMPLATES_DIR` set) · 4 resources · 1 prompt · 3 services (`mailchimp`, `assets`, `templates`)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`
11. **Run the `release-and-publish` skill** — post-wrapup ship workflow: verification gate, push, publish to npm + GHCR

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

---

## Patterns

### Tool (primitive — noun grouped by `operation`)

```ts
// src/mcp-server/tools/definitions/mailchimp-search.tool.ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

const InputSchema = z.object({
  scope: z.enum(['members', 'campaigns']).describe('What to search.'),
  query: z.string().min(1).describe('Search terms.'),
  audienceId: z.string().optional().describe('Restrict member search to one audience.'),
});

export const mailchimpSearchTool = tool('mailchimp_search', {
  description: 'Global search. Use `scope: members` to find subscribers; `scope: campaigns` for campaigns.',
  annotations: { readOnlyHint: true },
  input: InputSchema,
  output: OutputSchema,
  async handler(input, ctx) {
    const svc = getMailchimpService();
    return input.scope === 'members'
      ? svc.search.members(ctx, input.query, input.audienceId)
      : svc.search.campaigns(ctx, input.query);
  },
  format: (result) => [{ type: 'text', text: renderSearchHits(result) }],
});
```

### Tool (workflow — orchestrates multi-step flows, elicits confirmation)

```ts
// src/mcp-server/tools/definitions/mailchimp-send-campaign.tool.ts
export const mailchimpSendCampaignTool = tool('mailchimp_send_campaign', {
  description: 'Compose and send (or schedule/test) a campaign in one call.',
  annotations: { destructiveHint: true, openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,
  async handler(input, ctx) {
    const svc = getMailchimpService();
    const draftId = await svc.campaigns.create(ctx, input);
    try {
      if (input.mode === 'send' && ctx.elicit) {
        const ok = await ctx.elicit('Confirm send?', z.object({ confirm: z.boolean() }));
        if (ok.action !== 'accept' || !ok.data.confirm) throw new Error('Send cancelled by user.');
      }
      return await svc.campaigns.finalize(ctx, draftId, input);
    } catch (err) {
      if (input.cleanupOnError !== false) await svc.campaigns.deleteDraft(ctx, draftId).catch(() => {});
      throw err;
    }
  },
});
```

### Resource

```ts
// src/mcp-server/resources/definitions/mailchimp-audience.resource.ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

export const mailchimpAudienceResource = resource('mailchimp://audiences/{audienceId}', {
  name: 'mailchimp-audience',
  description: 'Audience (list) snapshot — name, contact, stats, double-opt-in status.',
  mimeType: 'application/json',
  params: z.object({ audienceId: z.string().describe('Audience ID.') }),
  async handler(params, ctx) {
    const svc = getMailchimpService();
    return svc.audiences.getSnapshot(ctx, params.audienceId);
  },
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed via parseEnvConfig for env-var-aware errors
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const API_KEY_PATTERN = /^[a-f0-9]{32}-(?<dc>[a-z]+\d+)$/i;

const ServerConfigSchema = z.object({
  apiKey: z.string().min(1).regex(API_KEY_PATTERN),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.coerce.number().int().positive().default(60_000),
  maxRetries: z.coerce.number().int().min(0).max(10).default(3),
  concurrencyLimit: z.coerce.number().int().min(1).max(10).default(4),
}).transform((raw) => {
  const dc = API_KEY_PATTERN.exec(raw.apiKey)?.groups?.['dc'] ?? '';
  return { ...raw, dataCenter: dc, baseUrl: raw.baseUrl ?? `https://${dc}.api.mailchimp.com/3.0` };
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'MAILCHIMP_API_KEY',
    baseUrl: 'MAILCHIMP_BASE_URL',
    timeoutMs: 'MAILCHIMP_TIMEOUT_MS',
    maxRetries: 'MAILCHIMP_MAX_RETRIES',
    concurrencyLimit: 'MAILCHIMP_CONCURRENCY_LIMIT',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod paths → env-var names so a missing `MAILCHIMP_API_KEY` surfaces as `MAILCHIMP_API_KEY (apiKey): ...` instead of a raw Zod path. It throws a `ConfigurationError` which the framework catches at startup and prints as a clean banner.

---

## Context

Handlers receive a unified `ctx` object. Used in this server:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.elicit` | Used by `mailchimp_send_campaign` / `mailchimp_replicate_campaign` to request human confirmation on destructive sends. **Check for presence first.** |
| `ctx.signal` | Forwarded to the `fetch` call inside `mailchimp-service.ts` so cancellation propagates upstream. |
| `ctx.requestId` / `ctx.traceId` | Appended to the `X-Request-Id` header for correlation with Mailchimp support cases. |

Not currently used: `ctx.state` (no tenant-scoped caching needed — upstream is already fast + cheap), `ctx.sample` (no model-calling tools), `ctx.progress` (no task tools).

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to get a typed `ctx.fail(reason, …)` keyed by the declared reason union (TS catches `ctx.fail('typo')` at compile time), auto-populated `data.reason` for observability, and lint-enforced conformance against the handler body. The `recovery` field is required (≥5 words, lint-validated) — single source of truth for the agent's next move. Spread `ctx.recoveryFor('reason')` to flow the contract recovery onto the wire (mirrored into `content[]` text); override with explicit `{ recovery: { hint: '...' } }` when runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'audience_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'Audience ID does not exist',
    recovery: 'List audiences via mailchimp_audiences and copy a valid ID.' },
  { reason: 'send_cancelled', code: JsonRpcErrorCode.InvalidRequest,
    when: 'User declined the send confirmation',
    recovery: 'Re-invoke and confirm at the elicit prompt to send.' },
],
async handler(input, ctx) {
  if (!found) throw ctx.fail('audience_not_found', `No audience ${input.id}`,
    { ...ctx.recoveryFor('audience_not_found') });
}
```

**Fallback (no contract entry fits):** error factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Tool errors mirror the success-path `format-parity` invariant — both `content[]` and `structuredContent.error` carry the same payload (code, message, data, recovery hint). See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, contract reference, and factory list.

---

## Structure

```text
src/
  index.ts                              # createApp() — registers tools/resources/prompts, inits mailchimp service
  config/
    server-config.ts                    # MAILCHIMP_* env vars, API-key regex, derived data-center
  services/
    mailchimp/
      mailchimp-service.ts              # HTTP client, retries, normalization, typed endpoint methods
      types.ts                          # Raw + domain types shared across tools
    assets/                             # L1 — Node-only, conditional on MAILCHIMP_ASSETS_DIR
      asset-service.ts                  # Discovery, hashing, upload-via-mailchimp, rewrite
      asset-cache.ts                    # SHA-256 → upload metadata, atomic JSON file
      rewrite.ts                        # Pure HTML scan + URL rewrite for @assets/* refs
    templates/                          # L2 — Node-only, conditional on MAILCHIMP_TEMPLATES_DIR
      template-service.ts               # Eta render, sidecar parsing, seed-from-mailchimp
  mcp-server/
    tools/
      shared/
        asset-rewrite.ts                # Helper used by send-campaign / campaigns / replicate to rewrite @assets/* before set-content
        resolve-local-template.ts       # Helper that resolves content.localTemplate → rendered HTML before asset rewrite
        template-sections-doc.ts        # Shared description for the templateSections field
      definitions/
        index.ts                        # allToolDefinitions barrel (alwaysOn + conditional)
        mailchimp-account.tool.ts
        mailchimp-assets.tool.ts        # Conditional (L1)
        mailchimp-audience-overview.tool.ts
        mailchimp-audiences.tool.ts
        mailchimp-campaign-report.tool.ts
        mailchimp-campaigns.tool.ts
        mailchimp-files.tool.ts
        mailchimp-find-subscriber.tool.ts
        mailchimp-import-subscribers.tool.ts
        mailchimp-local-templates.tool.ts # Conditional (L2)
        mailchimp-merge-fields.tool.ts
        mailchimp-playbook.tool.ts
        mailchimp-replicate-campaign.tool.ts
        mailchimp-reports.tool.ts
        mailchimp-search.tool.ts
        mailchimp-segments.tool.ts
        mailchimp-send-campaign.tool.ts
        mailchimp-subscribers.tool.ts
        mailchimp-templates.tool.ts
        mailchimp-upsert-subscriber.tool.ts
    resources/definitions/
      index.ts                          # allResourceDefinitions barrel
      mailchimp-account.resource.ts
      mailchimp-audience.resource.ts
      mailchimp-campaign.resource.ts
      mailchimp-campaign-report.resource.ts
    prompts/definitions/
      index.ts                          # allPromptDefinitions barrel
      newsletter-from-source.prompt.ts
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of LLM-facing definition language across tools/resources/prompts |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `release-and-publish` | Post-wrapup ship workflow: verification gate, push, publish to npm / MCP Registry / GHCR |
| `migrate-mcp-ts-template` | Migrate a legacy mcp-ts-template fork to use `@cyanheads/mcp-ts-core` as a package |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in (not used by this server) |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | MCP definition lint rules — every `format-parity`, `schema-*`, `name-*`, `server-json-*` rule ID the linter emits |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + docs/skills sync checks |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run lint:packaging` | Validate env-var alignment between `manifest.json` and `server.json` |
| `bun run list-skills` | Print available skills index |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun test` | Run tests |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run dev` | Watch mode (transport via `MCP_TRANSPORT_TYPE`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

---

## Publishing

Run the `release-and-publish` skill — it runs the verification gate (`devcheck`, `rebuild`, `test`), pushes commits and tags, and publishes to every applicable destination with transient-failure retries. Reference commands:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/mailchimp-mcp-server:<version> \
  -t ghcr.io/cyanheads/mailchimp-mcp-server:latest \
  --push .
```

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`) on **tool/resource input/output**. Server config may use `.transform()`.
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When schema-level regex/length matters, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging — no `console`
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch (except workflow tools that need to clean up drafts on failure)
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Mailchimp raw/domain/output schemas reviewed against real upstream sparsity/nullability (many fields are `null` or absent on free-tier accounts)
- [ ] Normalization and `format()` preserve uncertainty — never fabricate metrics, counts, or timestamps from missing upstream data
- [ ] Tests include at least one sparse payload case (empty audience, un-sent campaign, missing `industry_stats`, etc.)
- [ ] Destructive writes (`send`, `schedule`, batch member delete) elicit confirmation via `ctx.elicit` when available
- [ ] New primitive tools grouped by noun via `operation` enum — don't add a new top-level tool per verb
- [ ] Registered in `src/mcp-server/*/definitions/index.ts` barrel
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` and `bun run test` pass
