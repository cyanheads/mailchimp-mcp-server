# Reference Artifacts

Large reference files used during design/implementation. Gitignored by default — fetch on demand.

## Mailchimp Marketing API spec

Bundled Swagger 2.0 spec (~10 MB), source of truth for endpoint shapes, parameters, and response schemas.

```bash
curl -sL -o docs/reference/mailchimp-openapi.json \
  https://raw.githubusercontent.com/mailchimp/mailchimp-client-lib-codegen/main/spec/marketing.json
```

The spec at `https://api.mailchimp.com/schema/3.0/Swagger.json` is a smaller index that `$ref`s 172 external per-path files — use the bundled version above for offline analysis.
