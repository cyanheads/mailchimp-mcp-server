# Changelog

All notable changes to `mailchimp-mcp-server` are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.4 — 2026-05-10

Structural `confirmSend` gate on send-capable workflow tools, framework refresh to `@cyanheads/mcp-ts-core` `^0.8.20`, Node engine bump to `≥24`, and a skills sync from upstream (12 updated, 1 new).

### Added

- **`confirmSend: boolean` input on `mailchimp_send_campaign` and `mailchimp_replicate_campaign`.** Defaults `false`. The handler now rejects `mode: 'send' | 'schedule'` calls when `confirmSend !== true` with a `validationError` whose message tells the agent to surface a one-line summary (subject + audience + recipient count + send time) and re-invoke after explicit user authorization. This is a structural defense-in-depth gate that lives in the input schema — orthogonal to the runtime `ctx.elicit` confirmation prompt, which still fires when the client supports MCP elicitation. Tool / mode descriptions also rewritten to make the "default to `draft`" expectation explicit, with examples of phrasings that don't authorize a send (`"set up next week's newsletter"`, `"clone this and update the audience"`).
- **`security: true` frontmatter flag in `scripts/build-changelog.ts`.** Paired with the existing `breaking: true` flag, renders a 🛡️ Security badge on the rollup index entry (order: ⚠️ Breaking before 🛡️ Security when both set). Boolean parsing factored to a shared inner helper to keep the two flags symmetric.
- **`skills/api-telemetry/`** — new reference skill for the OTel catalog (spans, metrics, completion logs, env config, cardinality rules) synced from framework 0.8.20. Added to the `CLAUDE.md` skills table.

### Changed

- **Bumped `@cyanheads/mcp-ts-core` `^0.8.15` → `^0.8.20`.** Five upstream patches; behavior compatible. Skills synced from the upstream mirror: `api-auth`, `api-config`, `api-context`, `api-utils`, `maintenance`, `report-issue-framework`, `report-issue-local`, `security-pass`, `setup`, `tool-defs-analysis`. Agent mirror `.claude/skills/` refreshed (Phase B).
- **Bumped `@biomejs/biome` `^2.4.14` → `^2.4.15`** and **`@types/node` `^25.6.0` → `^25.6.2`.** Pure patch bumps.
- **Engines: Node `≥22` → `≥24`.** Required by the framework after the 0.8.x line. README prerequisite text and `CLAUDE.md` agent-protocol header updated to match; `Engines:` line added to the protocol header.
- **Dockerfile base image pinned to `oven/bun:1.3` (and `oven/bun:1.3-slim` for the production stage).** Was unpinned `oven/bun:1` — pinning to the minor stops a future Bun 2.x base from quietly drifting in.
- **`mailchimp_campaigns` operation/tool descriptions** updated to point send-flow callers at `confirmSend: true` instead of "elicit confirmation" — keeps the language consistent with what `mailchimp_send_campaign` / `mailchimp_replicate_campaign` actually require now.

## 0.3.3 — 2026-05-05

LLM-facing language audit across the tool surface, per-tool error contracts replacing the shared service-errors set, and self-documenting conditional tools.

### Added

- **`disabledTool()` wrappers for `mailchimp_assets` / `mailchimp_local_templates`.** On Node, the tools now appear in the manifest with a `reason` and `hint` even when their env var isn't set — operators reading `/.well-known/mcp.json` and the landing page see what's gated and how to enable it. LLM clients still can't invoke them via `tools/list`. Cloudflare Workers behavior unchanged (no Node FS, both tools absent).
- **`tool-defs-analysis` skill** at `skills/tool-defs-analysis/` — read-only audit pass over LLM-facing definition language: voice & tense, internal leaks, audience leaks, defaults, recovery hints, output descriptions, cross-references, sparsity, examples, structure.

### Changed

- **Per-tool error contracts replaced the shared `MAILCHIMP_SERVICE_ERRORS`.** Each tool's `errors[]` is now tailored — recovery hints reference the specific surface ("scope for sending campaigns" vs "scope for member search" vs "scope for this account-level read"), 404 entries name the right discovery tool, and `ctx.recoveryFor()` flows the tailored hint onto the wire. `src/mcp-server/tools/definitions/_error-contracts.ts` removed.
- **Tool-defs language audit applied across all 25 definitions:**
  - Internal leaks removed: `ctx.elicit` references in `mailchimp_send_campaign` / `mailchimp_replicate_campaign` replaced with "prompts the user for confirmation when the client supports MCP elicitation"; HTTP-method mapping in `mailchimp_upsert_subscriber` ("PUT /members/{hash}…PATCH") replaced with the user-visible behavior; subscriber-hash internal-terminology mention removed from `mailchimp_subscribers`.
  - Audience leaks removed: "the agent fetches…", "Treat the returned ID as the canonical Y" replaced with neutral framing across the `newsletter-from-source` prompt and `mailchimp_playbook` description.
  - Per-variant glosses added to enum fields: `mailchimp_reports.dimension` (10 variants), `mailchimp_templates.operation`, `mailchimp_subscribers.status`.
  - Per-key shape hints added for dynamic-record fields: `mailchimp_audiences.signupFormConfig.header/contents/styles`, `mailchimp_merge_fields.options`, subscriber activity / events / goals row schemas.
  - Factual corrections: `mailchimp_campaigns.archiveType` was incorrectly labeled "MIME type" (it accepts archive format names — `zip`, `tar`, `tar.gz`, `tar.bz2`); `.avif` extension typo in `mailchimp_files.fileData`; formula-style describes (`recipientsCount minus bounce categories`, `exactMatches + fuzzyMatches`) rewritten in plain English.
- **Code dedup in `mailchimp_search`** — exact/fuzzy member mapping consolidated through a single `summarizeMember()` helper, replacing two identical 9-line `.map()` blocks.

## 0.3.2 — 2026-04-29

Adopted typed error contracts from `@cyanheads/mcp-ts-core` 0.8.x and tightened how the server handles upstream sparsity, missing data, and small-sample sends. Every Mailchimp-touching tool now advertises a declarative `errors[]` surface, the service stamps a matching `data.reason` on classified failures, and 404s carry a path-derived `data.recovery.hint` (e.g. "verify the subscriber email with mailchimp_find_subscriber, then retry"). Empty results no longer look like regressions — search / activity-feed / audience-overview now return a plain-language `note` that distinguishes "free-tier limit", "brand-new audience", and "no campaigns sent yet" from genuine zero.

### Added

- **`MAILCHIMP_SERVICE_ERRORS` shared contract** in `src/mcp-server/tools/definitions/_error-contracts.ts` — one source of truth for the seven cross-tool failure reasons (`mailchimp_unauthorized`, `mailchimp_forbidden`, `mailchimp_not_found`, `mailchimp_validation_failed`, `mailchimp_rate_limited`, `mailchimp_unavailable`, `mailchimp_timeout`). Spread into `tool()`'s `errors[]` alongside any tool-specific entries; the service layer (`mailchimp-service.ts`) stamps `data.reason` to match, so every clients-visible failure carries a machine-readable reason without per-call wiring. Tool-specific entries: `assets_not_configured`, `templates_not_configured`, `pre_send_checklist_failed` (send + replicate), `subscriber_search_no_usable_match` (playbook).
- **Path-based recovery hints in `mailchimp-service.ts`.** 404 on `/lists/{id}/members/{hash}` → "verify with mailchimp_find_subscriber"; 404 on `/lists/{id}/segments/{id}` → "list segments via mailchimp_segments"; 429/401/5xx all carry tailored hints. Lives on `data.recovery.hint` and (per framework 0.8.3) mirrors into `content[]` text so all clients see the same recovery surface.
- **Empty-result notes** on `mailchimp_search`, `mailchimp_account` `activity-feed`, and `mailchimp_audience_overview`. The note distinguishes "audience created this month, growth bucketed at month-end" from "no members yet" from "no opens recorded yet" — agents previously had to infer cause from absence and frequently inferred wrongly. Surfaced in both `structuredContent.note` / `notes[]` and rendered in the `format()` text block.
- **Sample-too-small guard on `mailchimp_playbook` `post-send-review`.** When `emails_sent < 50`, suppresses open/click rate benchmarking (rates are not meaningful at that volume) and pivots the next-step instructions toward raw event-timeline drilldown via `mailchimp_reports` `slice` `dimension: email-activity` / `click-details`. Threshold lives in the handler with a comment explaining the ±5pp confidence reasoning.
- **Template var validation** in `TemplateService.render()`. When a template's meta declares `vars: [...]`, every declared name must be present in the render call or the render fails with a `validationError` listing which are missing. Catches the worst-case bug where a missing variable renders as the literal string `undefined` in outgoing email HTML. Undeclared keys (or templates without a vars list) fall back to `''` via a small `Proxy` wrapper — safer than Eta's raw `undefined` for ad-hoc accesses inside template logic.

### Changed

- **Bumped `@cyanheads/mcp-ts-core` `^0.7.3` → `^0.8.6`.** Seven upstream releases. Highlights: typed error contracts ([0.8.0](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.8.x/0.8.0.md) — `errors[]` declaration, typed `ctx.fail(reason)`, conformance lint, advertised in `tools/list`), service-thrown `data.reason` pattern ([0.8.1](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.8.x/0.8.1.md)), `structuredContent.error` parity with `content[]` and recovery-hint mirroring ([0.8.3](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.8.x/0.8.3.md), breaking — adopted), required `recovery` field on contract entries ([0.8.4](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.8.x/0.8.4.md), breaking — every `errors[]` entry in this server now carries a ≥5-word recovery), `ctx.recoveryFor()` opt-in resolver that flows the contract recovery onto the wire ([0.8.5](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.8.x/0.8.5.md)), and `dev:stdio`/`dev:http` script removal in templates ([0.8.6](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.8.x/0.8.6.md)). Full per-version notes in `node_modules/@cyanheads/mcp-ts-core/changelog/0.7.x/` and `0.8.x/`.
- **Bumped `eta` `^4.5.1` → `^4.6.0`.** Pure minor bump.
- **Adopted error factories over `new McpError()` inline.** `mailchimp-assets`, `mailchimp-local-templates`, and `resolve-local-template` switched to `configurationError(...)` / `validationError(...)` factories from `@cyanheads/mcp-ts-core/errors`; cleaner call sites and consistent with the rest of the surface.
- **Mailchimp upstream-error message no longer leaks the data-center hostname.** Was `Mailchimp GET https://us22.api.mailchimp.com/3.0/lists/abc failed (...)`, now `Mailchimp returned 404 ... for /lists/abc: ...`. Full URL stays in `data.url` for telemetry; the user-facing message uses path only. Reduces low-signal noise in tool output and avoids the data-center detail showing up in agent-displayed errors.
- **Scripts collapsed and reordered:** `dev:stdio` + `dev:http` → single `dev` (transport switched via `MCP_TRANSPORT_TYPE`); added `start` script (matches `start:stdio` default invocation). Aligns with the upstream template after framework 0.8.6. README and CLAUDE.md commands table updated to match.
- **Skills synced from `@cyanheads/mcp-ts-core` 0.8.6:** `add-service` 1.3→1.5, `add-tool` 1.8→2.4, `api-context` 1.1→1.2, `api-errors` 1.0→1.4, `api-linter` 1.1→1.2, `design-mcp-server` 2.7→2.8, `field-test` 2.0→2.2, `maintenance` 1.5→2.0, `release-and-publish` 2.1→2.2, `report-issue-framework` 1.3→1.4, `security-pass` 1.1→1.2, `setup` 1.5→1.6. Major edits land in `api-errors` (typed-contract reference), `add-tool` (contract scaffolding), and `maintenance` (v2.0 framework-adoption hard rule). Agent mirror `.claude/skills/` refreshed (Phase B).
- **`CLAUDE.md` Errors section** rewritten to lead with the typed-contract pattern (declarative `errors[]` + `ctx.fail` + `ctx.recoveryFor`) and demote plain `Error` / factories / `McpError` to fallback. Commands table updated for the `dev` script collapse.

### Fixed

- **README badge bumped from `0.3.0` → `0.3.2`.** The badge had drifted on the 0.3.1 release; corrected here in lockstep.

## 0.3.1 — 2026-04-25

Single-file template format. Templates can now embed YAML frontmatter at the top of the `.eta` body instead of requiring a separate `<name>.meta.yaml` sidecar. Sidecars remain supported for backward compatibility — frontmatter takes precedence when both are present.

### Added

- **Frontmatter parsing in `TemplateService.get()`.** A `.eta` body that opens with `---\n` followed by YAML and a closing `---\n` now has the YAML parsed into the `meta` field and the source returned with the frontmatter block stripped (so it can be passed straight to Eta with no extra step). Same `subject` / `previewText` / `vars` shape as the sidecar.
- **`peekFrontmatter()` probe in `TemplateService.list()`.** Reads the first 4 bytes of each `.eta` (parallel with `Promise.all`) so `hasMeta` reports correctly on frontmatter-only templates without reading every body in full.
- **7 new tests** in `tests/services/templates/template-service.test.ts` covering frontmatter parsing, render-after-strip, frontmatter-wins-over-sidecar precedence, unterminated frontmatter, malformed YAML, list reporting `hasMeta` on frontmatter-only templates, and a body that opens with `---` but has no terminator (treated as malformed). Total now 198/198 across 16 files.

### Changed

- **`seedFromMailchimp` now emits a single file with frontmatter** (`---\nsubject: …\n---\n\n<body>`) instead of writing a `.eta` body plus a parallel `.meta.yaml` sidecar. Existing seed tests still pass — they assert on parsed `meta.subject`, which is plumbed identically through the new code path.
- **Example templates migrated to single-file form.** `templates/welcome.eta` and `templates/redden-gardens-april-2026.eta` now embed their `subject` / `previewText` / `vars` as frontmatter; the corresponding `.meta.yaml` sidecars have been removed.
- **README's Local templates section** updated to show frontmatter as the preferred form, with a note that the legacy sidecar still works.

## 0.3.0 — 2026-04-24

Big release: full local-authoring stack landed in three layers — `mailchimp_files` polish (L0), local-assets auto-upload pipeline (L1), and local-templates Eta-based authoring with `localTemplate` campaign integration (L2). Designed and probed against a free-tier account; all three layers verified working without paid plan.

### Added

#### L1 — Local assets

- **`mailchimp_assets` tool (conditional)** and full local-asset auto-upload pipeline. Set `MAILCHIMP_ASSETS_DIR` to an absolute directory path on the server and `@assets/<relative-path>` references in campaign HTML are auto-uploaded to Mailchimp File Manager and rewritten to public CDN URLs at send time (covers `mailchimp_send_campaign`, `mailchimp_campaigns set-content`, and `mailchimp_replicate_campaign contentOverride`). Cache lives at `<assetsDir>/.mailchimp-cache.json`, keyed by SHA-256 — content change ⇒ new key, no invalidation needed. Tool exposes `list`, `info`, `sync` (pre-warm), and `clear-cache`.
- **`src/services/assets/`** — `asset-service.ts` (orchestrator), `asset-cache.ts` (atomic JSON cache with unique tmp filenames to handle concurrent saves), `rewrite.ts` (pure HTML scan + URL rewrite). Path-traversal guard (`..` and absolute paths throw `Forbidden`); client-side size validation against Mailchimp's 1 MB image / 10 MB other caps before round-tripping; concurrency dedup on identical content hashes so parallel campaign sends don't double-upload.
- **`src/mcp-server/tools/shared/asset-rewrite.ts`** — single helper that all three campaign-content paths call before passing to Mailchimp. No-op when the assets service is not configured.

#### L2 — Local templates

- **`mailchimp_local_templates` tool (conditional)** and full Eta-based template-rendering pipeline. Set `MAILCHIMP_TEMPLATES_DIR` to an absolute directory path on the server. Templates are `.eta` files (Eta v4 — partials, conditionals, loops, includes), with optional `<name>.meta.yaml` sidecars for `subject` / `previewText` defaults plus declared `vars`. Tool exposes `list`, `get`, `render-preview` (no send), and `seed-from-mailchimp` (read a Mailchimp `base`/`user` template and write it to disk as a starting point — bridges the read-only Mailchimp templates API on free).
- **`content.localTemplate` + `content.localTemplateVars`** on `mailchimp_send_campaign`, `mailchimp_campaigns set-content`, and `mailchimp_replicate_campaign contentOverride`. Mutually exclusive with `html` and `templateId`. Templates can reference `@assets/<path>` — render runs first, then L1's asset rewrite runs over the rendered HTML, so the two layers compose cleanly.
- **`src/services/templates/template-service.ts`** — Eta wrapper, sidecar parsing via `@cyanheads/mcp-ts-core`'s `yamlParser`, traversal guard, `seed-from-mailchimp` that writes upstream `default-content` sections as `<%# section: name %>` fragments (or a stub for empty maps).
- **`src/mcp-server/tools/shared/resolve-local-template.ts`** — single helper that all three campaign tools call to resolve `localTemplate` to rendered HTML before the asset rewrite runs. Mutual-exclusion validation lives here.
- **`eta` ^4.5.1** dependency.

#### L0 polish — `mailchimp_files`

- **`update` operation.** PATCH-renames a file and/or moves it between folders. Pass `folderId: 0` to move to root. Verified working on free.

#### Configuration

- **`MAILCHIMP_ASSETS_DIR` and `MAILCHIMP_TEMPLATES_DIR`** env vars wired through `src/config/server-config.ts`, `.env.example`, `server.json` (both stdio + http packages), and `setup()` in `src/index.ts`. Both are optional; tools register conditionally when set.

#### Documentation

- **README "Local assets" section** documenting the L1 workflow, caps, allowed extensions, traversal guard, and Workers caveat.
- **README "Local templates" section** documenting the L2 workflow, Eta syntax, sidecar format, and `seed-from-mailchimp` bootstrapping.
- **`docs/plan-local-authoring.md`** updated to mark L0/L1/L2 status.

#### Tests

- **75 new tests** (191 total across 16 files; was 116/10):
  - `tests/services/assets/rewrite.test.ts` (15) — pure HTML scan + URL rewrite.
  - `tests/services/assets/asset-service.test.ts` (16) — tmp-dir fixtures, cache hit/miss, concurrent-upload dedup, oversize rejection, traversal guard.
  - `tests/tools/mailchimp-assets.test.ts` (15) — every operation against the live AssetService + mocked fetch.
  - `tests/services/templates/template-service.test.ts` (13) — discovery, render with vars, partials, meta sidecar parsing, traversal guard, seed-from-mailchimp.
  - `tests/tools/mailchimp-local-templates.test.ts` (10) — every operation end-to-end.
  - `tests/mcp-server/tools/shared/resolve-local-template.test.ts` (6) — pass-through, mutual exclusion, render integration.

### Changed

- **`mailchimp_files` description and `@fileoverview`** rewritten to reflect actual Mailchimp constraints discovered during free-tier probing: **images are capped at 1 MB**, other files at 10 MB. Allowed-extension list now embedded in `fileData` field description so the LLM doesn't try to upload `.webp`/`.avif`/`.exe`. Documented that image URLs use a hash (filename not preserved) while non-image URLs preserve the filename for sensible downloads. Added `update` to the operation enum and clarified `folderId`'s role on `update` (rename / move semantics).
- **`mailchimp_templates` tool description and `@fileoverview`** rewritten to point at `mailchimp_local_templates` as the canonical write path on every plan tier. The Mailchimp-side templates tool is now framed as read + paid-only sync, with explicit cross-references to L2 for authoring and `seed-from-mailchimp` for bootstrapping.
- **Conditional tool registration** in `src/mcp-server/tools/definitions/index.ts` — `alwaysOn` array plus a filtered `conditional` array gated on `hasFilesystem() && hasAssetsDir()` for L1 and `hasFilesystem() && hasTemplatesDir()` for L2. No framework support needed; just runtime checks.

### Fixed

- **`seed-from-mailchimp` produced un-renderable templates.** The seeded body used `<%# section: name %>` markers, but Eta v4 doesn't accept `<%# %>` for comments — it parses the contents as JS and bombs on the leading `#`. Switched to `<% /* section: name */ %>` (JS block comment inside an Eta code tag) so the markers survive in the seeded source as authoring breadcrumbs but render to nothing. Existing seed tests only asserted the source string contained `section: <key>`, which is why the regression slipped — added render-time assertions to both seed tests so the seeded output is exercised end-to-end.
- **Concurrent cache writes** in the assets service — multiple parallel uploads previously raced on a shared `<dir>/.mailchimp-cache.json.tmp` filename, causing one rename to ENOENT and silently dropping that asset from the rewrite map. `AssetCache.save()` now uses a unique tmp filename per call.
- **Double-read in asset upload pipeline** — `info()` and `ensureUploaded()` previously read+hashed the same file independently, then `doUpload()` re-read it a third time before base64-encoding. Factored a private `_readWithHash` helper shared by both public methods; `doUpload()` now consumes the already-read buffer. Cuts disk reads + SHA-256 compute by ~3× per non-cached upload.
- **Two-pass tree walk in `TemplateService.list()`** — previously walked the templates directory once via `collectMetaPaths()` to build a meta-sidecar set, then walked it again to enumerate `.eta` files. Collapsed into a single recursive walk that collects both bodies and sidecars in one pass.
- **Dead filter in `AssetService.list()`** — `.filter((e) => !e.relPath.startsWith('.mailchimp-cache'))` was unreachable; the directory walker already skips dotfiles. Removed.

## 0.2.10 — 2026-04-24

### Added

- **`mailchimp_files` tool** — wraps Mailchimp's File Manager (Content Studio) API. Operations: `list`, `get`, `upload`, `delete`, `list-folders`, `get-folder`. The `upload` response surfaces `fullSizeUrl` — the public CDN URL to drop into campaign HTML `<img src="…">`. **Verified working on the free plan**, so this unblocks image embedding in campaigns regardless of plan tier. Service additions: `svc.files.*` namespace and `File`/`FileFolder`/`FileType` domain types. Tool surface goes from 17 → 18 tools.
- **`tests/tools/mailchimp-files.test.ts`** — 21 tests covering input coercion, per-operation validation, the `file_data` (snake_case) upload payload mapping, the 204-on-delete service path, and `format()` surfacing of `fullSizeUrl` for HTML embedding.
- **`docs/plan-local-authoring.md`** — forward-looking design for the three-layer local-authoring system (L0 `mailchimp_files` shipped here; L1 local assets dir + auto-upload; L2 local templates with Eta render). Includes free-tier probe findings, conditional-registration approach, and the locked decisions on reference syntax / engine / cache strategy / Workers compatibility.

### Changed

- **`mailchimp_templates` tool description and `@fileoverview`** tightened to reflect that *all writes* (`create`/`update`/`delete`) require a paid plan regardless of `type` — not just `gallery`. Reads (`list`/`get`/`get-default-content`) work for `base` and `user` on free. The previous wording understated the gating and an LLM reading it would have assumed `create`/`update` worked for `user` templates on free, then 403'd. Stopgap fix; will be rewritten again when L2 (local templates) lands and becomes the canonical write path.



### Changed

- **Bumped `@cyanheads/mcp-ts-core` `^0.7.0` → `^0.7.3`.** Three non-breaking patch releases. Highlights: HTTP Origin guard now fails closed for remote browser origins (loopback-only default when `MCP_ALLOWED_ORIGINS` is unset, [0.7.1](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.7.x/0.7.1.md)); landing-page `requireAuth` validates the bearer token; default logs no longer persist raw caller payloads; new opt-in `LOG_LLM_INTERACTIONS` env var. `vitest.config` subpath export shipped as `.mjs` to unblock Node ≥22.7 type-stripping under `node_modules/` ([0.7.2](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.7.x/0.7.2.md)). `format-parity` numeric normalization tightened to reject lossy decimal-shift transforms while preserving en-US/de-DE/fr-FR/etc. locale grouping ([0.7.3](https://github.com/cyanheads/mcp-ts-core/blob/main/changelog/0.7.x/0.7.3.md)). Full per-version notes in `node_modules/@cyanheads/mcp-ts-core/changelog/0.7.x/`.
- **Synced framework scripts.** `scripts/devcheck.ts` updated from the package; `scripts/check-framework-antipatterns.ts` added (new in 0.7.2 — guards the framework's tools/list schema advertising path against three SDK-coupling shortcuts; no-op on consumer code which doesn't call `server.registerTool()` directly). `devcheck` now runs Framework Antipatterns alongside MCP Definitions and Docs Sync.
- **Synced `skills/api-utils/SKILL.md`** to pick up the 0.7.3 SSRF caveat clarification on `fetchWithTimeout`/`assertNotPrivateUrl`/`assertDnsNotPrivate` — the pre-validation DNS lookup is documented as best-effort with a DNS-rebinding/TOCTOU window, not strong isolation. Agent mirror `.claude/skills/` refreshed.

### Added

- **`MCP_PUBLIC_URL` and `MCP_ALLOWED_ORIGINS` documented in `.env.example`.** The Origin guard's behavior change in framework 0.7.1 — unset now means loopback-only — was material for HTTP-mode operators; explicit comments now surface the default and the `'*'` opt-out. `MCP_PUBLIC_URL` matches the upstream template's transport block.

## 0.2.8 — 2026-04-24

### Changed

- **Bumped `@cyanheads/mcp-ts-core` to `^0.7.0`.** Issue-cleanup release with no runtime breaking changes. Flattened `ZodError` message shape, structured `issues` on `McpError.data`, locale-aware digit-group separators in the `format-parity` linter, and a `devcheck` changelog guard. See upstream `0.7.0.md` for detail.
- **Synced framework scripts.** `scripts/devcheck.ts` and `scripts/tree.ts` updated from the package; `scripts/build-changelog.ts`, `scripts/check-docs-sync.ts`, and `scripts/check-skills-sync.ts` added. `devcheck` now runs Docs Sync + Skills Sync + Changelog Sync steps alongside the existing checks.
- **Synced project skills** from the package: `add-tool` 1.7→1.8, `api-linter` 1.0→1.1, `design-mcp-server` 2.5→2.7, `field-test` 1.2→2.0, `maintenance` 1.4→1.5, `polish-docs-meta` 1.6→1.7, `report-issue-framework` 1.1→1.3, `report-issue-local` 1.1→1.3, `setup` 1.4→1.5. Added `security-pass` (1.1) and `release-and-publish` (2.1). Agent mirror `.claude/skills/` refreshed.
- **Agent protocol (`CLAUDE.md`)**: added `security-pass` and `release-and-publish` entries to the skills table and "What's Next?" list; Publishing section now points at the `release-and-publish` skill; `devcheck` command description updated.

### Fixed

- **Cleared 380 `describe-on-fields` linter warnings** across all 16 tool definitions. Every nested object element, array element, and previously-undocumented field now carries a `.describe()` — this ships to the MCP client as JSON Schema, so both `structuredContent` and `content[]` surfaces explain every field to the LLM. No runtime behavior change; tool I/O shapes are identical.

## 0.2.7 — 2026-04-21

### Fixed

- **Numeric tool inputs no longer reject string-encoded integers.** Every input-side `z.number().int()` is now `z.coerce.number().int()` across the ten tools that take numeric IDs, page counts, or offsets (`mailchimp_templates`, `mailchimp_merge_fields`, `mailchimp_segments`, `mailchimp_subscribers`, `mailchimp_reports`, `mailchimp_audiences`, `mailchimp_campaigns`, `mailchimp_send_campaign`, `mailchimp_replicate_campaign`, `mailchimp_search`). Clients that marshal integers as JSON strings (Claude Desktop and some bridges do this for int-shaped fields) previously hit `expected: "number", received: "string"` before the handler ran; now the value is coerced and validated normally. Output schemas are unchanged. ([#3](https://github.com/cyanheads/mailchimp-mcp-server/issues/3))
- **`mailchimp_templates` (`operation: update`) now returns an actionable validation error** when no `name`/`html`/`folderId` is supplied. The previous message was a generic "At least one of …"; the new message explains the full-HTML-replacement model and points users to the `mailchimp_campaigns` / `mailchimp_send_campaign` `templateSections` workflow for per-section edits. ([#5](https://github.com/cyanheads/mailchimp-mcp-server/issues/5))

### Changed

- **`templateSections` field on the three campaign-content tools** (`mailchimp_send_campaign`, `mailchimp_campaigns` `set-content`, `mailchimp_replicate_campaign` `contentOverride`) now carries a single shared description that documents: keys (edit-region IDs from `mc:edit="…"` in the template HTML, or section IDs from `mailchimp_templates get-default-content`), values (HTML strings), applicability (`templateId` must also be set), a concrete example, and the "non-drag-and-drop templates often return an empty sections map — read the template HTML directly in that case" caveat. `mailchimp_replicate_campaign`'s `templateSections` previously had no `.describe()` at all. Extracted into `src/mcp-server/tools/shared/template-sections-doc.ts` so the three tools cannot drift. ([#4](https://github.com/cyanheads/mailchimp-mcp-server/issues/4))
- **`mailchimp_templates` tool description** now explicitly states "Per-section editing is not supported here", explains the full-HTML replacement model, and cross-references the campaign workflow for per-section overrides. ([#5](https://github.com/cyanheads/mailchimp-mcp-server/issues/5))
- **`mailchimp_templates get-default-content` `format()` output** now notes when the sections map is empty (common for user-uploaded HTML templates using `mc:edit`) and points the agent to read the template HTML directly. ([#5](https://github.com/cyanheads/mailchimp-mcp-server/issues/5))

### Added

- `tests/tools/mailchimp-templates.test.ts` — full handler + format + metadata coverage for the templates tool, including string-id coercion regression, name-only / html-only / empty-update paths, and the empty-sections format hint.
- `tests/tools/input-coercion.test.ts` — pins `z.coerce.number()` behavior across every tool that was changed, so a future edit dropping the `.coerce` gets caught immediately.
- `tests/tools/template-sections-doc.test.ts` — asserts the shared `TEMPLATE_SECTIONS_DOC` content (mc:edit, get-default-content, example, drag-and-drop caveat) and that all three campaign-content tools surface it in their emitted JSON Schema. 95 tests total (up from 50).

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
