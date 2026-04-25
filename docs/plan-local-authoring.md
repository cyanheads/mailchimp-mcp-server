# Plan: Local Authoring (Files + Assets + Templates)

Forward-looking design for image handling and local templating. Folds into [`design.md`](./design.md) once Phase 3 ships.

---

## Problem

Two gaps on the current surface:

1. **No way to include images in campaigns from a local source.** HTML bodies can reference external URLs, but there is no tool to upload an image file. Users have to host images externally and paste URLs.
2. **Free-tier users cannot write templates via the API.** Reads (`list`/`get`/`get-default-content`) work for `base` and `user` types on free. All writes (`create`/`update`/`delete`) return `Forbidden` with `requiresPlan: 'standard'` regardless of `type`. Free users have no programmatic path to reusable templates.

## Goal

Three independent layers. Each useful standalone; later layers compose with earlier ones.

| Layer | Scope | Status |
|:---|:---|:---|
| **L0** `mailchimp_files` | Wrap Mailchimp File Manager API | **Shipped 0.2.10 + polish in 0.3.0 (`update` op, size/type docs)** |
| **L1** Local assets | `<MAILCHIMP_ASSETS_DIR>` + auto-upload on send | **Shipped 0.3.0** |
| **L2** Local templates | `<MAILCHIMP_TEMPLATES_DIR>` + render pipeline | **Shipped 0.3.0** |

All three layers shipped. Ready to fold this plan into `design.md` as the canonical record (was task 10 in the original implementation order).

---

## Free-tier probe (2026-04-24)

All four File Manager operations verified working on the free plan:

| Endpoint | Result |
|:---|:---|
| `GET /file-manager/files` | Returns empty list + create link |
| `POST /file-manager/files` | Returns `{ id, full_size_url, thumbnail_url, size, width, height, ... }` |
| `DELETE /file-manager/files/{id}` | 204 No Content |
| `GET /file-manager/folders` | Returns empty list + create link |

Upload payload: `{ name: string, file_data: string (base64), folder_id?: number }`. Response includes `full_size_url` — this is the Mailchimp-hosted CDN URL for HTML embedding.

**Conclusion:** L0 is viable on any plan tier. No external-CDN fallback needed.

---

## Layer 0 — `mailchimp_files`

Always registered. No filesystem dependency. Workers-safe.

### Service

Add a `files` namespace to `mailchimp-service.ts`:

```ts
svc.files.list(ctx, { count?, offset?, type?, folderId?, beforeDate?, sinceDate? })
svc.files.get(ctx, fileId)
svc.files.upload(ctx, { name, fileDataBase64, folderId? })
svc.files.delete(ctx, fileId)
svc.files.listFolders(ctx, { count?, offset? })
svc.files.getFolder(ctx, folderId)
```

### Tool

One primitive tool grouped by noun, `operation` enum:

| Operation | Purpose |
|:---|:---|
| `list` | Paginated file listing, filterable by `type` (`image` / `file`) / folder / date window |
| `get` | Fetch a single file by ID |
| `upload` | Upload base64 file data, returns `id` + `full_size_url` |
| `delete` | Delete by ID |
| `list-folders` | Paginated folder listing |
| `get-folder` | Fetch single folder by ID |

Input includes `fileData: string` (base64) on `upload`. Output surfaces `fullSizeUrl` and `thumbnailUrl` prominently — that's what the LLM puts into HTML.

**Not exposed:** `create-folder` / `update-folder` / `delete-folder`. Punt until we see a use case; L1 doesn't need folders.

### Description hints for the LLM

- "Upload an image here, then reference `fullSizeUrl` in your campaign HTML `<img src>`."
- "On free plan, File Manager works normally — no plan gating."
- "For recurring workflows with many local images, use `mailchimp_assets` (if configured) — it handles discovery, hashing, and auto-upload."

---

## Layer 1 — Local assets

Conditional. Registered iff `MAILCHIMP_ASSETS_DIR` is set AND filesystem is available.

### Env

```env
MAILCHIMP_ASSETS_DIR=/absolute/path/to/assets
```

### Service

New module `src/services/assets/asset-service.ts`:

```ts
assets.list(): Promise<AssetEntry[]>                   // walks dir, returns {relPath, size, mime, sha256}
assets.info(relPath): Promise<AssetEntry>
assets.getCached(sha256): CachedUpload | undefined
assets.upload(ctx, relPath): Promise<CachedUpload>     // reads file, uploads via L0, caches by sha256
assets.rewriteHtml(ctx, html): Promise<string>         // scans @assets/* refs, uploads missing, rewrites URLs
assets.clearCache(): void
```

### Cache

Location: `<MAILCHIMP_ASSETS_DIR>/.mailchimp-cache.json`

```json
{
  "version": 1,
  "entries": {
    "<sha256>": {
      "fileId": 2641183,
      "fullSizeUrl": "https://mcusercontent.com/.../images/xxx.png",
      "thumbnailUrl": "https://mcusercontent.com/.../_thumbs/xxx.png",
      "uploadedAt": "2026-04-24T23:38:09Z",
      "sourceRelPath": "hero.png"
    }
  }
}
```

- Keyed by sha256 → content change = new key = fresh upload. No invalidation.
- `sourceRelPath` is informational only (last known path for the hash).
- Cache writes are atomic (write to `.tmp` + rename).

### Reference syntax

In campaign HTML, local images are referenced as `@assets/<relative-path>`:

```html
<img src="@assets/hero.png" alt="Hero">
<img src="@assets/brand/logo.svg" alt="Logo">
```

At send time, the asset pipeline:
1. Regex-scans the HTML for `@assets/...` in `src=`, `href=`, `background=`, and CSS `url(...)`.
2. For each unique reference, resolves to an absolute path under `MAILCHIMP_ASSETS_DIR`.
3. Rejects paths that escape the dir (no `..` traversal).
4. Hashes each file (sha256, streaming).
5. For cache-misses, uploads via L0 with concurrency capped at `MAILCHIMP_CONCURRENCY_LIMIT`.
6. Rewrites each reference to the Mailchimp `fullSizeUrl`.
7. Returns the rewritten HTML.

### Tool

`mailchimp_assets` — conditionally registered:

| Operation | Purpose |
|:---|:---|
| `list` | Walk `MAILCHIMP_ASSETS_DIR`, return `{relPath, size, mime, sha256, uploaded?}` per file |
| `info` | Single-file detail |
| `sync` | Pre-warm the cache — upload any uncached files ahead of a send |
| `clear-cache` | Delete `.mailchimp-cache.json`; next send re-uploads everything |

### Integration points

Both campaign tools gain optional auto-rewrite when assets service is configured:

- `mailchimp_send_campaign` — before setting content, run `assets.rewriteHtml()` on `content.html` (and template section overrides).
- `mailchimp_campaigns` (`set-content`) — same.

If L1 is not configured, `@assets/*` references pass through unchanged (Mailchimp will 404 them in the preview; intentional — forces configuration).

---

## Layer 2 — Local templates

Conditional. Registered iff `MAILCHIMP_TEMPLATES_DIR` is set AND filesystem is available.

### Env

```env
MAILCHIMP_TEMPLATES_DIR=/absolute/path/to/templates
```

### File format

One `.eta` file per template, optional `.meta.yaml` sidecar:

```
templates/
  welcome.eta              # body
  welcome.meta.yaml        # optional metadata (subject, preview, var schema)
  newsletter.eta
  partials/
    header.eta
    footer.eta
```

`welcome.meta.yaml`:

```yaml
subject: "Welcome to {{brand}}"
previewText: "Let's get started"
vars:
  brand: { type: string, required: true }
  firstName: { type: string, default: "there" }
```

### Engine

**Eta** (v3). Zero-dep, ESM-native, ~25 KB. Supports partials via `<%~ include('partials/header', it) %>`, conditionals, loops, layouts. Pick over Handlebars because it's actively maintained and ESM-first. Pick over MJML because MJML is a heavier investment we can add later if email-client quirks bite.

### Service

`src/services/templates/template-service.ts`:

```ts
templates.list(): Promise<TemplateSummary[]>
templates.get(name): Promise<Template>
templates.render(name, vars): Promise<{ subject?, previewText?, html }>
templates.validateVars(name, vars): Promise<void>  // throws validationError on mismatch
templates.seedFromMailchimp(ctx, mailchimpTemplateId, localName): Promise<void>  // GETs, writes to disk
```

### Tool

`mailchimp_local_templates` — conditionally registered:

| Operation | Purpose |
|:---|:---|
| `list` | List all local templates with metadata |
| `get` | Return one template's raw source + metadata |
| `render-preview` | Render with supplied vars, return HTML (no send) |
| `seed-from-mailchimp` | Read a Mailchimp `base`/`user` template via L0-era tool, save to disk as starting point |

### Integration points

`mailchimp_send_campaign` and `mailchimp_campaigns` (`set-content`) gain:

```ts
content: {
  // ... existing fields ...
  localTemplate?: string                    // template name (without .eta)
  localTemplateVars?: Record<string, unknown>
}
```

Render order at send time:

1. Eta render with vars → intermediate HTML.
2. If L1 is configured, run `assets.rewriteHtml()` on the output.
3. Final HTML passed to Mailchimp via `set-content`.

If `localTemplate` and `html` / `templateId` are both provided → `validationError` (ambiguous).

### `mailchimp_templates` description rewrite

When L2 ships, rewrite the `mailchimp_templates` tool description to point at L2 as the canonical write path:

> "Read-only surface for Mailchimp-hosted templates (`list`, `get`, `get-default-content`). Writes (`create`, `update`, `delete`) require a paid plan. **For authoring new templates, prefer `mailchimp_local_templates`** — works on any plan, git-versionable, composable via partials, and LLM-friendly to edit as files."

---

## Conditional registration

Implemented in `src/mcp-server/tools/definitions/index.ts`:

```ts
const alwaysOn: AnyToolDefinition[] = [
  /* existing 17 tools */,
  mailchimpFilesTool,
];

const conditional: AnyToolDefinition[] = [];
if (hasAssetsDir() && hasFilesystem()) conditional.push(mailchimpAssetsTool);
if (hasTemplatesDir() && hasFilesystem()) conditional.push(mailchimpLocalTemplatesTool);

export const allToolDefinitions = [...alwaysOn, ...conditional];
```

`hasFilesystem()` checks `typeof process !== 'undefined' && !!process.versions?.node`. Cloudflare Workers gets `false`. The `node:fs` import lives behind a lazy load inside the asset/template services so the module tree doesn't crash at import on Workers.

`hasAssetsDir()` / `hasTemplatesDir()` read `process.env.MAILCHIMP_ASSETS_DIR` / `MAILCHIMP_TEMPLATES_DIR` directly (not via `parseEnvConfig`) since registration happens before `setup()`.

---

## Locked decisions

| # | Decision | Choice |
|:--|:---|:---|
| 1 | Asset reference syntax | `@assets/<relative-path>` |
| 2 | Template engine | Eta v3 |
| 3 | Cache location | `<MAILCHIMP_ASSETS_DIR>/.mailchimp-cache.json` |
| 4 | Template composition | Eta partials via `<%~ include('partials/foo', it) %>` |
| 5 | Var schema sidecar | Optional `<name>.meta.yaml` with `vars:` map (name → type + default/required) |
| 6 | Workers story for L1/L2 | Node-only. R2-backed variant is future work. |

---

## Workers compatibility

| Layer | Workers | Notes |
|:---|:---|:---|
| L0 `mailchimp_files` | ✓ Yes | No fs; pure HTTP |
| L1 `mailchimp_assets` | ✗ No | Gated out by `hasFilesystem()` |
| L2 `mailchimp_local_templates` | ✗ No | Same |

No bifurcation — Workers users just don't see L1/L2 tools. Future enhancement: R2-backed asset/template sources wired through `core.storage` bindings.

---

## File structure deltas

```text
src/
  config/
    server-config.ts                            # MODIFY — add optional assetsDir, templatesDir
  services/
    mailchimp/
      mailchimp-service.ts                      # MODIFY — add files namespace
      types.ts                                  # MODIFY — add File, FileFolder types
    assets/                                     # NEW (L1)
      asset-service.ts
      asset-cache.ts
      rewrite.ts
    templates/                                  # NEW (L2)
      template-service.ts
      render.ts
  mcp-server/
    tools/
      definitions/
        mailchimp-files.tool.ts                 # NEW (L0)
        mailchimp-assets.tool.ts                # NEW (L1)
        mailchimp-local-templates.tool.ts       # NEW (L2)
        mailchimp-send-campaign.tool.ts         # MODIFY — localTemplate + asset rewrite
        mailchimp-campaigns.tool.ts             # MODIFY — same on set-content
        mailchimp-templates.tool.ts             # MODIFY — rewrite description in Phase 3
        index.ts                                # MODIFY — conditional registration
tests/
  services/
    mailchimp/files.test.ts                     # NEW (L0)
    assets/asset-service.test.ts                # NEW (L1)
    templates/template-service.test.ts          # NEW (L2)
  mcp-server/tools/
    mailchimp-files.tool.test.ts                # NEW (L0)
    mailchimp-assets.tool.test.ts               # NEW (L1)
    mailchimp-local-templates.tool.test.ts      # NEW (L2)
docs/
  plan-local-authoring.md                       # THIS FILE
  design.md                                     # MODIFY — fold plan in once Phase 3 lands
```

---

## Risks and mitigations

| Risk | Mitigation |
|:---|:---|
| Cache invalidation bugs | Content-hash keys — content change = new key, stale reads impossible |
| First-send latency with many uncached assets | Log per-file progress via `ctx.log.info`; expose `mailchimp_assets sync` for pre-warming |
| Path-traversal via `@assets/../../etc/passwd` | Resolve under `MAILCHIMP_ASSETS_DIR` and reject paths whose real path escapes |
| Two sources of truth for templates (Mailchimp vs local) | Local-first narrative; `seed-from-mailchimp` is one-way; upstream sync deferred |
| Eta dep adds weight | ~25 KB + zero deps — acceptable |
| `.mailchimp-cache.json` committed to git by accident | README warns; recommend `.gitignore` entry; consider `.cache/` subdir with auto-gitignore |
| Base64 upload payload size | Mailchimp's upload limit is 10 MB; reject oversized files client-side with a clear error |
| Concurrent cache writes on parallel uploads | Single-flight per sha256 + atomic rename on write |

---

## Implementation order

### Phase 1 — L0

1. Add `File`, `FileFolder` types to `services/mailchimp/types.ts`.
2. Add `files` namespace to `mailchimp-service.ts`.
3. Create `mailchimp-files.tool.ts` (list / get / upload / delete / list-folders / get-folder).
4. Register in `definitions/index.ts`.
5. Tests: `tests/services/mailchimp/files.test.ts` + `tests/mcp-server/tools/mailchimp-files.tool.test.ts`.
6. Update README feature counts (17 → 18 tools), CLAUDE.md surface line, `docs/tree.md`.
7. `bun run devcheck` + `bun test`. Version bump + CHANGELOG. Commit.

### Phase 2 — L1

1. Add `assetsDir` to `server-config.ts` (optional).
2. Build `services/assets/` (service, cache, rewrite).
3. `mailchimp-assets.tool.ts` + conditional registration.
4. Wire `assets.rewriteHtml()` into `mailchimp_send_campaign` and `mailchimp_campaigns set-content`.
5. Tests with tmp dir fixtures.
6. Docs (README L1 section, `.env.example`, CLAUDE.md).
7. `devcheck` + test + version + CHANGELOG + commit.

### Phase 3 — L2

1. Add `templatesDir` to `server-config.ts` (optional).
2. Build `services/templates/` (service, render, var validation).
3. `mailchimp-local-templates.tool.ts` + conditional registration.
4. Add `localTemplate` + `localTemplateVars` to campaign tool schemas.
5. Implement `seed-from-mailchimp` operation.
6. Rewrite `mailchimp_templates` tool description (L2 is canonical).
7. Tests with tmp dir fixtures.
8. Docs (README L2 section, `.env.example`, CLAUDE.md, rewrite free-tier section of README).
9. `devcheck` + test + version + CHANGELOG + commit.
10. Fold this plan doc into `design.md`; delete `plan-local-authoring.md`.

Estimated total effort: ~25–30 new files + ~6 modified. 3 focused sessions.
