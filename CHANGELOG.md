# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.12](changelog/0.3.x/0.3.12.md) — 2026-10-10 · 🛡️ Security

Bind campaign dispatch to single-use consent and adopt mcp-ts-core 0.13.14.

## [0.3.11](changelog/0.3.x/0.3.11.md) — 2026-09-26

Run guarded Docker dependency installation on the native build platform.

## [0.3.10](changelog/0.3.x/0.3.10.md) — 2026-09-26 · ⚠️ Breaking

Framework maintenance updates client error handling and input repair, with optional Mailchimp settings available through both plugins.

## [0.3.9](changelog/0.3.x/0.3.9.md) — 2026-09-19 · 🛡️ Security

Stateful HTTP confirmation, safer upstream request handling, and framework tooling updates.

## [0.3.8](changelog/0.3.x/0.3.8.md) — 2026-08-22

Campaign send and replicate now use re-entrant confirmation before mutation, with MCP SDK v2 wire behavior and a framework/toolchain refresh.

## [0.3.7](changelog/0.3.x/0.3.7.md) — 2026-06-15

Server-level instructions wired into createApp() to orient clients on auth, the audience/list model, and the playbook-first workflow; plugin display-identity fields unscoped to the bare server name while install commands stay on the scoped npm package.

## [0.3.6](changelog/0.3.x/0.3.6.md) — 2026-06-11

Framework refresh to @cyanheads/mcp-ts-core ^0.10.6, server identity fields (name/title) wired into createApp(), Claude Code + Codex plugin manifests scaffolded, manifest.json gains repository/homepage/license, .mcpbignore re-anchored with post-pack bundle cleaner.

## [0.3.5](changelog/0.3.x/0.3.5.md) — 2026-05-23

Framework refresh to @cyanheads/mcp-ts-core ^0.9.6, numeric fields renamed to carry units (sizeInBytes, widthInPixels, heightInPixels, totalFileSizeInBytes), manifest.json + .mcpbignore scaffolded for MCPB bundle support, install badges added to README.

## [0.3.4](changelog/0.3.x/0.3.4.md) — 2026-05-10

Structural confirmSend gate on send-capable workflow tools, framework refresh to @cyanheads/mcp-ts-core ^0.8.20, Node engine bump to >=24, skills sync (12 updated, 1 new).
