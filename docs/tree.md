# mailchimp-mcp-server - Directory Structure

Generated on: 2026-05-05 10:15:33

```text
mailchimp-mcp-server/
├── .claude/
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── assets/
├── docs/
│   ├── reference/
│   │   └── README.md
│   ├── api-key.md
│   ├── design.md
│   ├── email-design-playbook.md
│   └── plan-local-authoring.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       └── newsletter-from-source.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       ├── mailchimp-account.resource.ts
│   │   │       ├── mailchimp-audience.resource.ts
│   │   │       ├── mailchimp-campaign-report.resource.ts
│   │   │       └── mailchimp-campaign.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── index.ts
│   │       │   ├── mailchimp-account.tool.ts
│   │       │   ├── mailchimp-assets.tool.ts
│   │       │   ├── mailchimp-audience-overview.tool.ts
│   │       │   ├── mailchimp-audiences.tool.ts
│   │       │   ├── mailchimp-campaign-report.tool.ts
│   │       │   ├── mailchimp-campaigns.tool.ts
│   │       │   ├── mailchimp-files.tool.ts
│   │       │   ├── mailchimp-find-subscriber.tool.ts
│   │       │   ├── mailchimp-import-subscribers.tool.ts
│   │       │   ├── mailchimp-local-templates.tool.ts
│   │       │   ├── mailchimp-merge-fields.tool.ts
│   │       │   ├── mailchimp-playbook.tool.ts
│   │       │   ├── mailchimp-replicate-campaign.tool.ts
│   │       │   ├── mailchimp-reports.tool.ts
│   │       │   ├── mailchimp-search.tool.ts
│   │       │   ├── mailchimp-segments.tool.ts
│   │       │   ├── mailchimp-send-campaign.tool.ts
│   │       │   ├── mailchimp-subscribers.tool.ts
│   │       │   ├── mailchimp-templates.tool.ts
│   │       │   └── mailchimp-upsert-subscriber.tool.ts
│   │       └── shared/
│   │           ├── asset-rewrite.ts
│   │           ├── resolve-local-template.ts
│   │           └── template-sections-doc.ts
│   ├── services/
│   │   ├── assets/
│   │   │   ├── asset-cache.ts
│   │   │   ├── asset-service.ts
│   │   │   └── rewrite.ts
│   │   ├── mailchimp/
│   │   │   ├── mailchimp-service.ts
│   │   │   ├── normalize.ts
│   │   │   └── types.ts
│   │   └── templates/
│   │       └── template-service.ts
│   └── index.ts
├── templates/
│   ├── redden-gardens-april-2026.eta
│   └── welcome.eta
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       └── shared/
│   │           └── resolve-local-template.test.ts
│   ├── prompts/
│   │   └── newsletter-from-source.test.ts
│   ├── resources/
│   ├── services/
│   │   ├── assets/
│   │   │   ├── asset-service.test.ts
│   │   │   └── rewrite.test.ts
│   │   ├── mailchimp/
│   │   │   ├── mailchimp-service.test.ts
│   │   │   └── normalize.test.ts
│   │   └── templates/
│   │       └── template-service.test.ts
│   └── tools/
│       ├── input-coercion.test.ts
│       ├── mailchimp-assets.test.ts
│       ├── mailchimp-campaign-report.test.ts
│       ├── mailchimp-files.test.ts
│       ├── mailchimp-local-templates.test.ts
│       ├── mailchimp-playbook.test.ts
│       ├── mailchimp-templates.test.ts
│       └── template-sections-doc.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
