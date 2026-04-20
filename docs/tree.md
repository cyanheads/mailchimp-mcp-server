# mailchimp-mcp-server - Directory Structure

Generated on: 2026-04-20 15:47:10

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
├── docs/
│   ├── reference/
│   │   └── README.md
│   ├── api-key.md
│   ├── design.md
│   └── email-design-playbook.md
├── scripts/
│   ├── build.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
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
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
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
│   ├── devcheck/
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
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   └── setup/
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
│   │       └── definitions/
│   │           ├── index.ts
│   │           ├── mailchimp-account.tool.ts
│   │           ├── mailchimp-audience-overview.tool.ts
│   │           ├── mailchimp-audiences.tool.ts
│   │           ├── mailchimp-campaign-report.tool.ts
│   │           ├── mailchimp-campaigns.tool.ts
│   │           ├── mailchimp-find-subscriber.tool.ts
│   │           ├── mailchimp-import-subscribers.tool.ts
│   │           ├── mailchimp-merge-fields.tool.ts
│   │           ├── mailchimp-playbook.tool.ts
│   │           ├── mailchimp-replicate-campaign.tool.ts
│   │           ├── mailchimp-reports.tool.ts
│   │           ├── mailchimp-search.tool.ts
│   │           ├── mailchimp-segments.tool.ts
│   │           ├── mailchimp-send-campaign.tool.ts
│   │           ├── mailchimp-subscribers.tool.ts
│   │           ├── mailchimp-templates.tool.ts
│   │           └── mailchimp-upsert-subscriber.tool.ts
│   ├── services/
│   │   └── mailchimp/
│   │       ├── mailchimp-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── prompts/
│   │   └── newsletter-from-source.test.ts
│   ├── resources/
│   ├── services/
│   │   └── mailchimp/
│   │       └── mailchimp-service.test.ts
│   └── tools/
│       └── mailchimp-playbook.test.ts
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
