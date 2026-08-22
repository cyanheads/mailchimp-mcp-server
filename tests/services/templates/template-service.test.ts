/**
 * @fileoverview Tests for TemplateService — discovery, render with vars, partial
 * inclusion, optional meta.yaml sidecar parsing, path-traversal guard, and
 * seed-from-mailchimp via a mocked Mailchimp service. Uses real tmp-dir
 * fixtures so the I/O paths are exercised.
 * @module tests/services/templates/template-service.test
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';
import { TemplateService } from '@/services/templates/template-service.js';

const BASE_CONFIG: ServerConfig = {
  apiKey: 'abcdef0123456789abcdef0123456789-us22',
  baseUrl: 'https://us22.api.mailchimp.com/3.0',
  timeoutMs: 1_000,
  maxRetries: 0,
  concurrencyLimit: 4,
  dataCenter: 'us22',
};

function fakeJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function setupTmpTemplates(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mailchimp-templates-'));
  await writeFile(
    join(dir, 'welcome.eta'),
    `<h1>Hello <%= it.firstName %></h1>\n<p>Welcome to <%= it.brand %>.</p>\n`,
    'utf8',
  );
  await writeFile(
    join(dir, 'welcome.meta.yaml'),
    `subject: "Welcome to {{brand}}"\npreviewText: Onboarding\nvars:\n  - firstName\n  - brand\n`,
    'utf8',
  );
  await mkdir(join(dir, 'partials'));
  await writeFile(join(dir, 'partials', 'header.eta'), `<header>HEADER</header>`, 'utf8');
  await writeFile(
    join(dir, 'newsletter.eta'),
    `<%~ include('partials/header', it) %>\n<main>Hello <%= it.firstName %></main>`,
    'utf8',
  );
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('TemplateService — list & get', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setupTmpTemplates());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('list returns one entry per .eta file with hasMeta correctly set', async () => {
    const svc = new TemplateService(dir);
    const list = await svc.list();
    const names = list.map((t) => t.name);
    expect(names).toContain('welcome');
    expect(names).toContain('newsletter');
    expect(names).toContain('partials/header');
    const welcome = list.find((t) => t.name === 'welcome');
    const newsletter = list.find((t) => t.name === 'newsletter');
    expect(welcome?.hasMeta).toBe(true);
    expect(newsletter?.hasMeta).toBe(false);
  });

  it('get returns source + parsed meta', async () => {
    const svc = new TemplateService(dir);
    const detail = await svc.get('welcome');
    expect(detail.source).toContain('Hello <%= it.firstName %>');
    expect(detail.meta?.subject).toBe('Welcome to {{brand}}');
    expect(detail.meta?.previewText).toBe('Onboarding');
    expect(detail.meta?.vars).toEqual(['firstName', 'brand']);
  });

  it('get returns no meta when sidecar is absent', async () => {
    const svc = new TemplateService(dir);
    const detail = await svc.get('newsletter');
    expect(detail.hasMeta).toBe(false);
    expect(detail.meta).toBeUndefined();
  });

  it('get throws notFound for a missing template', async () => {
    const svc = new TemplateService(dir);
    await expect(svc.get('does-not-exist')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('rejects names with .eta extension', async () => {
    const svc = new TemplateService(dir);
    await expect(svc.get('welcome.eta')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('rejects path traversal', async () => {
    const svc = new TemplateService(dir);
    await expect(svc.get('../escape')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
  });

  it('rejects absolute paths', async () => {
    const svc = new TemplateService(dir);
    await expect(svc.get('/etc/passwd')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
  });
});

describe('TemplateService — frontmatter', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setupTmpTemplates());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('parses YAML frontmatter and strips it from source', async () => {
    await writeFile(
      join(dir, 'fm.eta'),
      `---\nsubject: "Frontmatter Subject"\npreviewText: "Preview"\nvars:\n  - foo\n---\n<h1>Hi <%= it.foo %></h1>\n`,
      'utf8',
    );
    const svc = new TemplateService(dir);
    const detail = await svc.get('fm');
    expect(detail.hasMeta).toBe(true);
    expect(detail.meta?.subject).toBe('Frontmatter Subject');
    expect(detail.meta?.previewText).toBe('Preview');
    expect(detail.meta?.vars).toEqual(['foo']);
    expect(detail.source.startsWith('---')).toBe(false);
    expect(detail.source).toContain('<h1>Hi <%= it.foo %></h1>');
  });

  it('renders correctly after stripping frontmatter', async () => {
    await writeFile(
      join(dir, 'fm.eta'),
      `---\nsubject: "X"\n---\n<h1>Hi <%= it.name %></h1>\n`,
      'utf8',
    );
    const svc = new TemplateService(dir);
    const result = await svc.render('fm', { name: 'Casey' });
    expect(result.html).toContain('<h1>Hi Casey</h1>');
    expect(result.html).not.toContain('---');
    expect(result.subject).toBe('X');
  });

  it('frontmatter takes precedence over sidecar when both exist', async () => {
    await writeFile(
      join(dir, 'both.eta'),
      `---\nsubject: "From Frontmatter"\n---\n<p>Body</p>\n`,
      'utf8',
    );
    await writeFile(join(dir, 'both.meta.yaml'), `subject: "From Sidecar"\n`, 'utf8');
    const svc = new TemplateService(dir);
    const detail = await svc.get('both');
    expect(detail.meta?.subject).toBe('From Frontmatter');
  });

  it('throws ValidationError on unterminated frontmatter', async () => {
    await writeFile(join(dir, 'broken-fm.eta'), `---\nsubject: "no closer"\n<p>body</p>\n`, 'utf8');
    const svc = new TemplateService(dir);
    await expect(svc.get('broken-fm')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("missing the closing '---'"),
    });
  });

  it('throws ValidationError on malformed frontmatter YAML', async () => {
    await writeFile(join(dir, 'bad-yaml.eta'), `---\n: : :\n---\n<p>body</p>\n`, 'utf8');
    const svc = new TemplateService(dir);
    await expect(svc.get('bad-yaml')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Failed to parse frontmatter'),
    });
  });

  it('list reports hasMeta=true for frontmatter-only templates', async () => {
    await writeFile(join(dir, 'fm-only.eta'), `---\nsubject: "X"\n---\n<p>body</p>\n`, 'utf8');
    const svc = new TemplateService(dir);
    const list = await svc.list();
    const fmOnly = list.find((t) => t.name === 'fm-only');
    expect(fmOnly?.hasMeta).toBe(true);
  });

  it('treats a body that just happens to start with `---` but has no terminator as malformed', async () => {
    await writeFile(join(dir, 'three-dash.eta'), `---\nthis is not yaml\nstill body\n`, 'utf8');
    const svc = new TemplateService(dir);
    await expect(svc.get('three-dash')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
  });
});

describe('TemplateService — render', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setupTmpTemplates());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('renders variables via Eta', async () => {
    const svc = new TemplateService(dir);
    const result = await svc.render('welcome', { firstName: 'Casey', brand: 'Acme' });
    expect(result.html).toContain('Hello Casey');
    expect(result.html).toContain('Welcome to Acme');
  });

  it('renders partials via include()', async () => {
    const svc = new TemplateService(dir);
    const result = await svc.render('newsletter', { firstName: 'Casey' });
    expect(result.html).toContain('<header>HEADER</header>');
    expect(result.html).toContain('Hello Casey');
  });

  it('returns subject and previewText from meta when present', async () => {
    const svc = new TemplateService(dir);
    const result = await svc.render('welcome', { firstName: 'A', brand: 'B' });
    expect(result.subject).toBe('Welcome to {{brand}}');
    expect(result.previewText).toBe('Onboarding');
  });

  it('throws validationError when render fails', async () => {
    await writeFile(join(dir, 'broken.eta'), '<% throw new Error("oops") %>', 'utf8');
    const svc = new TemplateService(dir);
    await expect(svc.render('broken', {})).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Failed to render'),
    });
  });
});

describe('TemplateService — seedFromMailchimp', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setupTmpTemplates());
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(async () => {
    await cleanup();
    setMailchimpServiceForTesting(undefined);
    vi.unstubAllGlobals();
  });

  it('writes a stub when Mailchimp returns an empty default-content map', async () => {
    const fetchStub = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/templates/9999')) {
        return fakeJson(200, { id: 9999, name: 'Starter', type: 'base' });
      }
      if (url.includes('/default-content')) {
        return fakeJson(200, { sections: {} });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchStub);

    const svc = new TemplateService(dir);
    const result = await svc.seedFromMailchimp(createMockContext(), 9999, 'seeded');
    expect(result.relPath).toBe('seeded.eta');
    expect(result.bytes).toBeGreaterThan(0);

    const detail = await svc.get('seeded');
    expect(detail.source).toContain('Seeded from Mailchimp template 9999');
    expect(detail.meta?.subject).toBe('Starter');

    /** Stub must be valid Eta — pre-fix regression: `<%# %>` bombed at render. */
    const rendered = await svc.render('seeded', { title: 'Hi', body: 'Body' });
    expect(rendered.html).toContain('<h1>Hi</h1>');
    expect(rendered.html).toContain('<p>Body</p>');
  });

  it('writes section fragments when Mailchimp returns a populated map', async () => {
    const fetchStub = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/templates/8888')) {
        return fakeJson(200, { id: 8888, name: 'D&D', type: 'gallery' });
      }
      if (url.includes('/default-content')) {
        return fakeJson(200, {
          sections: {
            header: '<h1>Header</h1>',
            body: '<p>Body</p>',
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchStub);

    const svc = new TemplateService(dir);
    await svc.seedFromMailchimp(createMockContext(), 8888, 'dnd-seed');
    const detail = await svc.get('dnd-seed');
    expect(detail.source).toContain('section: header');
    expect(detail.source).toContain('<h1>Header</h1>');
    expect(detail.source).toContain('section: body');
    expect(detail.source).toContain('<p>Body</p>');

    /** Section markers must be valid Eta — pre-fix regression: `<%# %>` bombed at render. */
    const rendered = await svc.render('dnd-seed', {});
    expect(rendered.html).toContain('<h1>Header</h1>');
    expect(rendered.html).toContain('<p>Body</p>');
    expect(rendered.html).not.toContain('<%');
  });
});
