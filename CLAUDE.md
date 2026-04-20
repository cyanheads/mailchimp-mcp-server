# Agent Protocol

**Server:** mailchimp-mcp-server
**Version:** 0.2.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
**Surface:** 17 tools · 4 resources · 1 prompt · 1 service (`mailchimp`)

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
8. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
9. **Run the `maintenance` skill** — sync skills and dependencies after framework updates

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
// src/config/server-config.ts — lazy-parsed, with derived data-center field
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
```

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

Handlers throw — the framework catches, classifies, and formats. Three escalation levels:

```ts
// 1. Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// 2. Error factories — explicit code, concise
import { notFound, validationError, forbidden, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// 3. McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Plain `Error` is fine for most cases. Use factories when the error code matters. See framework CLAUDE.md for the full auto-classification table and all available factories.

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
  mcp-server/
    tools/definitions/
      index.ts                          # allToolDefinitions barrel
      mailchimp-account.tool.ts
      mailchimp-audience-overview.tool.ts
      mailchimp-audiences.tool.ts
      mailchimp-campaign-report.tool.ts
      mailchimp-campaigns.tool.ts
      mailchimp-find-subscriber.tool.ts
      mailchimp-import-subscribers.tool.ts
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
      index.ts                          # empty — no prompts in v1
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

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, re-copy to pick up changes.

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
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Sync skills and dependencies after updates |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
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
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun test` | Run tests |
| `bun run dev:stdio` | Dev mode (stdio) |
| `bun run dev:http` | Dev mode (HTTP) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Publishing

After a version bump and final commit, publish to both npm and GHCR:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/mailchimp-mcp-server:<version> \
  -t ghcr.io/cyanheads/mailchimp-mcp-server:latest \
  --push .
```

Remind the user to run these after completing a release flow.

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

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, etc.)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging — no `console`
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch (except workflow tools that need to clean up drafts on failure)
- [ ] `format()` renders all data the LLM needs — `content[]` is the only field most clients forward to the model
- [ ] Mailchimp raw/domain/output schemas reviewed against real upstream sparsity/nullability (many fields are `null` or absent on free-tier accounts)
- [ ] Normalization and `format()` preserve uncertainty — never fabricate metrics, counts, or timestamps from missing upstream data
- [ ] Tests include at least one sparse payload case (empty audience, un-sent campaign, missing `industry_stats`, etc.)
- [ ] Destructive writes (`send`, `schedule`, batch member delete) elicit confirmation via `ctx.elicit` when available
- [ ] New primitive tools grouped by noun via `operation` enum — don't add a new top-level tool per verb
- [ ] Registered in `src/mcp-server/*/definitions/index.ts` barrel
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` and `bun run test` pass
