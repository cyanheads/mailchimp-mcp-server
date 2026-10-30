/**
 * @fileoverview Tests for the `mailchimp_local_templates` tool. Wires the tool
 * against a real TemplateService backed by a tmp-dir fixture. Covers each
 * operation end-to-end and the configuration-error path.
 * @module tests/tools/mailchimp-local-templates.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpLocalTemplatesTool } from '@/mcp-server/tools/definitions/mailchimp-local-templates.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';
import {
  setTemplateServiceForTesting,
  TemplateService,
} from '@/services/templates/template-service.js';

const BASE_CONFIG: ServerConfig = {
  apiKey: 'abcdef0123456789abcdef0123456789-us22',
  baseUrl: 'https://us22.api.mailchimp.com/3.0',
  timeoutMs: 1_000,
  maxRetries: 0,
  concurrencyLimit: 4,
  dataCenter: 'us22',
};

const createToolContext = () => createMockContext({ errors: mailchimpLocalTemplatesTool.errors });
const formatTool = mailchimpLocalTemplatesTool.format;
if (!formatTool) throw new Error('mailchimpLocalTemplatesTool must define format().');

function fakeJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function setup(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mailchimp-local-templates-tool-'));
  await writeFile(join(dir, 'welcome.eta'), `<h1>Hello <%= it.firstName %></h1>`, 'utf8');
  await writeFile(
    join(dir, 'welcome.meta.yaml'),
    `subject: "Welcome"\npreviewText: "Onboard"\n`,
    'utf8',
  );
  setTemplateServiceForTesting(new TemplateService(dir));
  setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      setTemplateServiceForTesting(undefined);
      setMailchimpServiceForTesting(undefined);
      vi.unstubAllGlobals();
    },
  };
}

describe('mailchimpLocalTemplatesTool — config error path', () => {
  it('throws ConfigurationError when template service is not initialized', async () => {
    setTemplateServiceForTesting(undefined);
    const input = mailchimpLocalTemplatesTool.input.parse({ operation: 'list' });
    await expect(
      mailchimpLocalTemplatesTool.handler(input, createToolContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining('MAILCHIMP_TEMPLATES_DIR'),
    });
  });
});

describe('mailchimpLocalTemplatesTool — operations', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setup());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('list: returns the welcome template with hasMeta: true', async () => {
    const input = mailchimpLocalTemplatesTool.input.parse({ operation: 'list' });
    const result = await mailchimpLocalTemplatesTool.handler(input, createToolContext());
    expect(result.templatesDir).toBe(dir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates?.[0]?.name).toBe('welcome');
    expect(result.templates?.[0]?.hasMeta).toBe(true);
  });

  it('get: returns source + parsed meta', async () => {
    const input = mailchimpLocalTemplatesTool.input.parse({
      operation: 'get',
      name: 'welcome',
    });
    const result = await mailchimpLocalTemplatesTool.handler(input, createToolContext());
    expect(result.template?.source).toContain('<%= it.firstName %>');
    expect(result.template?.meta?.subject).toBe('Welcome');
  });

  it('get: requires name', async () => {
    const input = mailchimpLocalTemplatesTool.input.parse({ operation: 'get' });
    await expect(
      mailchimpLocalTemplatesTool.handler(input, createToolContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'name' is required"),
    });
  });

  it('render-preview: renders with vars and returns subject from meta', async () => {
    const input = mailchimpLocalTemplatesTool.input.parse({
      operation: 'render-preview',
      name: 'welcome',
      vars: { firstName: 'Casey' },
    });
    const result = await mailchimpLocalTemplatesTool.handler(input, createToolContext());
    expect(result.rendered?.html).toContain('Hello Casey');
    expect(result.rendered?.subject).toBe('Welcome');
    expect(result.rendered?.previewText).toBe('Onboard');
  });

  it('render-preview: requires name', async () => {
    const input = mailchimpLocalTemplatesTool.input.parse({ operation: 'render-preview' });
    await expect(
      mailchimpLocalTemplatesTool.handler(input, createToolContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'name' is required"),
    });
  });

  it('seed-from-mailchimp: requires both name and mailchimpTemplateId', async () => {
    const noName = mailchimpLocalTemplatesTool.input.parse({
      operation: 'seed-from-mailchimp',
      mailchimpTemplateId: '9999',
    });
    await expect(
      mailchimpLocalTemplatesTool.handler(noName, createToolContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'name' is required"),
    });
    const noId = mailchimpLocalTemplatesTool.input.parse({
      operation: 'seed-from-mailchimp',
      name: 'starter',
    });
    await expect(
      mailchimpLocalTemplatesTool.handler(noId, createToolContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'mailchimpTemplateId' is required"),
    });
  });

  it('seed-from-mailchimp: writes a seed file from upstream metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith('/templates/9999'))
          return fakeJson(200, { id: 9999, name: 'Starter', type: 'base' });
        if (url.includes('/default-content')) return fakeJson(200, { sections: {} });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const input = mailchimpLocalTemplatesTool.input.parse({
      operation: 'seed-from-mailchimp',
      name: 'starter',
      mailchimpTemplateId: '9999',
    });
    const result = await mailchimpLocalTemplatesTool.handler(input, createToolContext());
    expect(result.seeded?.relPath).toBe('starter.eta');
    expect(result.seeded?.mailchimpTemplateId).toBe(9999);
  });
});

describe('mailchimpLocalTemplatesTool — list notice (structuredContent + content[] trailer)', () => {
  const EMPTY_NOTICE =
    'No `.eta` files found. Create `<name>.eta` in the templates dir, optionally with YAML frontmatter for subject/preview defaults, or bootstrap one with `operation: seed-from-mailchimp`.';

  let emptyDir: string;

  beforeEach(async () => {
    emptyDir = await mkdtemp(join(tmpdir(), 'mailchimp-local-templates-empty-'));
    setTemplateServiceForTesting(new TemplateService(emptyDir));
  });

  afterEach(async () => {
    await rm(emptyDir, { recursive: true, force: true });
    setTemplateServiceForTesting(undefined);
  });

  it('empty templates dir: one notice, rendered once as a blockquote trailer; no filters', async () => {
    const result = await runToolContract(mailchimpLocalTemplatesTool, { operation: 'list' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      templatesDir: emptyDir,
      templates: [],
      notice: EMPTY_NOTICE,
    });
    expect(result.structuredContent).not.toHaveProperty('filters');
    const [body, trailer] = result.content.map((b) => (b.type === 'text' ? b.text : ''));
    expect(body).toBe(`Operation: list\n_Templates dir: ${emptyDir}_\n\n# Local templates (0)`);
    expect(trailer).toBe(`\n\n> ${EMPTY_NOTICE}`);
    expect(result.content).toHaveLength(2);
  });

  it('non-empty templates dir: no notice', async () => {
    await writeFile(join(emptyDir, 'welcome.eta'), '<p>hi</p>', 'utf8');
    const result = await runToolContract(mailchimpLocalTemplatesTool, { operation: 'list' });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.content).toHaveLength(1);
  });
});

describe('mailchimpLocalTemplatesTool — format()', () => {
  it('render-preview output includes html in a code fence', () => {
    const out = formatTool({
      operation: 'render-preview',
      templatesDir: '/tmp/t',
      rendered: {
        name: 'welcome',
        html: '<h1>x</h1>',
        subject: 'Welcome',
      },
    });
    const text = out[0]?.type === 'text' ? out[0].text : '';
    expect(text).toContain('## HTML');
    expect(text).toContain('<h1>x</h1>');
    expect(text).toContain('Welcome');
  });
});
