/**
 * @fileoverview `mailchimp_local_templates` — local-templates surface (L2).
 * Conditionally registered when `MAILCHIMP_TEMPLATES_DIR` is set. **This is the
 * canonical write path for templates on free-tier Mailchimp accounts**, where
 * the upstream `/templates` endpoint is read-only. Templates are `.eta` files
 * with optional `<name>.meta.yaml` sidecars. Use `seed-from-mailchimp` to
 * bootstrap a local template from a Mailchimp `base` or `user` template.
 * @module mcp-server/tools/definitions/mailchimp-local-templates.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  JsonRpcErrorCode,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { getTemplateService } from '@/services/templates/template-service.js';

const OperationSchema = z
  .enum(['list', 'get', 'render-preview', 'seed-from-mailchimp'])
  .describe(
    "Which local-templates operation to run. `list` walks the templates dir; `get` returns one template's source + metadata; `render-preview` renders with vars and returns the HTML (no send); `seed-from-mailchimp` reads a Mailchimp template by ID and writes it to disk as a starting point.",
  );

const InputSchema = z.object({
  operation: OperationSchema,
  name: z
    .string()
    .optional()
    .describe(
      'Local template name without the `.eta` extension. Required for `get`/`render-preview`. For `seed-from-mailchimp`, this is the *destination* name (where to save the seed).',
    ),
  vars: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Variables passed to Eta during `render-preview`. Reference inside the template via `<%= it.varName %>` (Eta's default scope). When the template's meta declares a `vars` list, every declared name must be present here or the render fails with a validation error (so you never silently emit `undefined` into outgoing email). Undeclared lookups inside the template body fall back to an empty string.",
    ),
  mailchimpTemplateId: z.coerce
    .number()
    .int()
    .optional()
    .describe('Source Mailchimp template ID. Required for `seed-from-mailchimp`.'),
});

const TemplateSummarySchema = z
  .object({
    name: z.string().describe('Template name without extension.'),
    relPath: z.string().describe('Path relative to MAILCHIMP_TEMPLATES_DIR (with `.eta`).'),
    size: z.number().describe('Body file size in bytes.'),
    hasMeta: z.boolean().describe('Whether a `<name>.meta.yaml` sidecar was found.'),
  })
  .describe('Local template summary.');

const TemplateMetaSchema = z
  .object({
    subject: z.string().optional().describe('Default subject from sidecar metadata.'),
    previewText: z.string().optional().describe('Default preview text from sidecar metadata.'),
    vars: z
      .array(z.string())
      .optional()
      .describe('Declared variable names (informational; not schema-enforced).'),
  })
  .describe('Parsed sidecar metadata.');

const TemplateDetailSchema = z
  .object({
    name: z.string().describe('Template name without extension.'),
    relPath: z.string().describe('Path relative to MAILCHIMP_TEMPLATES_DIR.'),
    size: z.number().describe('Body file size in bytes.'),
    hasMeta: z.boolean().describe('Whether a sidecar was found.'),
    source: z.string().describe('Raw `.eta` template source.'),
    meta: TemplateMetaSchema.optional().describe('Parsed sidecar metadata, if present.'),
  })
  .describe('Local template detail returned by `get`.');

const RenderResultSchema = z
  .object({
    name: z.string().describe('Template name that was rendered.'),
    html: z.string().describe('Rendered HTML body.'),
    subject: z.string().optional().describe('Subject from sidecar metadata, if any.'),
    previewText: z.string().optional().describe('Preview text from sidecar metadata, if any.'),
  })
  .describe('Result of `render-preview`.');

const SeedResultSchema = z
  .object({
    relPath: z.string().describe('Where the seed was written (relative to templates dir).'),
    bytes: z.number().describe('Bytes written.'),
    mailchimpTemplateId: z.number().describe('Source Mailchimp template ID.'),
  })
  .describe('Result of `seed-from-mailchimp`.');

const OutputSchema = z.object({
  operation: OperationSchema,
  templatesDir: z.string().describe('Resolved absolute path of MAILCHIMP_TEMPLATES_DIR.'),
  templates: z.array(TemplateSummarySchema).optional().describe('Populated for `list`.'),
  template: TemplateDetailSchema.optional().describe('Populated for `get`.'),
  rendered: RenderResultSchema.optional().describe('Populated for `render-preview`.'),
  seeded: SeedResultSchema.optional().describe('Populated for `seed-from-mailchimp`.'),
});

type Output = z.infer<typeof OutputSchema>;

function requireService(): NonNullable<ReturnType<typeof getTemplateService>> {
  const svc = getTemplateService();
  if (!svc) {
    throw configurationError(
      'Local-templates service is not initialized. Set MAILCHIMP_TEMPLATES_DIR and restart the server to enable local-template authoring.',
      { reason: 'templates_not_configured' },
    );
  }
  return svc;
}

export const mailchimpLocalTemplatesTool = tool('mailchimp_local_templates', {
  description:
    "Author and render local email templates. **Canonical write path for templates on free-tier Mailchimp accounts** — Mailchimp's upstream `/templates` API is read-only on free, so this tool is how you create reusable templates programmatically. Templates are `.eta` files in `MAILCHIMP_TEMPLATES_DIR`, with optional `<name>.meta.yaml` sidecars (subject, previewText, vars). Eta supports partials via `<%~ include('partials/header', it) %>`, conditionals (`<% if (it.x) { %>`), and loops. Use `seed-from-mailchimp` to bootstrap a template from a Mailchimp `base` or `user` starter. Once authored, reference a template from any campaign tool via `content.localTemplate: '<name>'` and `content.localTemplateVars: { … }`.",
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,
  errors: [
    {
      reason: 'mailchimp_unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'Mailchimp returned 401 — only fires on seed-from-mailchimp, which reads the upstream template.',
      recovery:
        'Verify MAILCHIMP_API_KEY in env; rotate via Mailchimp → Account → Extras → API keys.',
    },
    {
      reason: 'mailchimp_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Mailchimp returned 403 on seed-from-mailchimp — gallery templates and certain user templates are paid-only reads.',
      recovery:
        'Use a base or user template instead of a gallery template, or upgrade the Mailchimp plan.',
    },
    {
      reason: 'mailchimp_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 on seed-from-mailchimp — mailchimpTemplateId points at a template that does not exist.',
      recovery: 'Run mailchimp_templates operation:list to discover valid IDs.',
    },
    {
      reason: 'mailchimp_validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp returned 400 or 422 on seed-from-mailchimp.',
      recovery: 'Inspect data.upstream.errors[] for field-level reasons.',
    },
    {
      reason: 'mailchimp_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Mailchimp returned 429 on seed-from-mailchimp — too many concurrent requests.',
      recovery: 'Retry after a brief delay.',
      retryable: true,
    },
    {
      reason: 'templates_not_configured',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'MAILCHIMP_TEMPLATES_DIR was not set on the server.',
      recovery:
        'Set MAILCHIMP_TEMPLATES_DIR to a writable directory and restart the server to enable local-template authoring.',
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = requireService();

    switch (input.operation) {
      case 'list': {
        const templates = await svc.list();
        return {
          operation: 'list',
          templatesDir: svc.directory,
          templates,
        };
      }
      case 'get': {
        if (!input.name) throw validationError("'name' is required for 'get'.");
        const detail = await svc.get(input.name);
        return {
          operation: 'get',
          templatesDir: svc.directory,
          template: {
            name: detail.name,
            relPath: detail.relPath,
            size: detail.size,
            hasMeta: detail.hasMeta,
            source: detail.source,
            ...(detail.meta ? { meta: detail.meta } : {}),
          },
        };
      }
      case 'render-preview': {
        if (!input.name) throw validationError("'name' is required for 'render-preview'.");
        const result = await svc.render(input.name, input.vars ?? {});
        return {
          operation: 'render-preview',
          templatesDir: svc.directory,
          rendered: {
            name: input.name,
            html: result.html,
            ...(result.subject !== undefined ? { subject: result.subject } : {}),
            ...(result.previewText !== undefined ? { previewText: result.previewText } : {}),
          },
        };
      }
      case 'seed-from-mailchimp': {
        if (!input.name)
          throw validationError(
            "'name' is required for 'seed-from-mailchimp' (the destination template name).",
          );
        if (input.mailchimpTemplateId === undefined)
          throw validationError("'mailchimpTemplateId' is required for 'seed-from-mailchimp'.");
        const result = await svc.seedFromMailchimp(ctx, input.mailchimpTemplateId, input.name);
        return {
          operation: 'seed-from-mailchimp',
          templatesDir: svc.directory,
          seeded: {
            relPath: result.relPath,
            bytes: result.bytes,
            mailchimpTemplateId: input.mailchimpTemplateId,
          },
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [
      `_Operation: ${result.operation}_`,
      `_Templates dir: ${result.templatesDir}_`,
      '',
    ];

    if (result.templates) {
      lines.push(`# Local templates (${result.templates.length})`, '');
      if (result.templates.length === 0) {
        lines.push(
          '_No `.eta` files found. Create `<name>.eta` in the templates dir, optionally with a `<name>.meta.yaml` sidecar for subject/preview defaults._',
        );
      } else {
        for (const t of result.templates) {
          const sizeLabel =
            t.size < 1024 ? `${t.size} B` : `${(t.size / 1024).toFixed(1)} KB (${t.size} B)`;
          lines.push(
            `- **${t.name}** — \`${t.relPath}\` · ${sizeLabel}${t.hasMeta ? ' · meta' : ''}`,
          );
        }
      }
    }

    if (result.template) {
      const t = result.template;
      lines.push(`# ${t.name}`, '');
      lines.push(`- relPath: \`${t.relPath}\``);
      lines.push(`- size: ${t.size} bytes`);
      lines.push(`- hasMeta: ${t.hasMeta}`);
      if (t.meta) {
        lines.push('', '## Meta', '');
        if (t.meta.subject) lines.push(`- subject: ${JSON.stringify(t.meta.subject)}`);
        if (t.meta.previewText) lines.push(`- previewText: ${JSON.stringify(t.meta.previewText)}`);
        if (t.meta.vars && t.meta.vars.length > 0)
          lines.push(`- vars: ${t.meta.vars.map((v) => `\`${v}\``).join(', ')}`);
      }
      lines.push('', '## Source', '', '```eta', t.source, '```');
    }

    if (result.rendered) {
      const r = result.rendered;
      lines.push(`# Rendered \`${r.name}\``, '');
      if (r.subject) lines.push(`- subject: ${JSON.stringify(r.subject)}`);
      if (r.previewText) lines.push(`- previewText: ${JSON.stringify(r.previewText)}`);
      lines.push('', '## HTML', '', '```html', r.html, '```');
    }

    if (result.seeded) {
      const s = result.seeded;
      lines.push(
        `# Seeded from Mailchimp template \`${s.mailchimpTemplateId}\``,
        '',
        `- relPath: \`${s.relPath}\``,
        `- bytes: ${s.bytes}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
