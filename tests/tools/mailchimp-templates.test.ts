/**
 * @fileoverview Tests for the `mailchimp_templates` tool. Covers the three
 * regressions users surfaced during field testing:
 *   1. Numeric input coercion (`templateId`, `count`, `offset` accepted as strings).
 *   2. The update handler's actionable "at least one of …" validation error.
 *   3. The `get-default-content` format hint when Mailchimp returns an empty
 *      sections map (classic user-uploaded HTML templates using `mc:edit`).
 * Plus end-to-end happy/edge paths for every operation with a stubbed fetch.
 * @module tests/tools/mailchimp-templates.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpTemplatesTool } from '@/mcp-server/tools/definitions/mailchimp-templates.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';

const BASE_CONFIG: ServerConfig = {
  apiKey: 'abcdef0123456789abcdef0123456789-us22',
  baseUrl: 'https://us22.api.mailchimp.com/3.0',
  timeoutMs: 1_000,
  maxRetries: 0,
  concurrencyLimit: 4,
  dataCenter: 'us22',
};

const createToolContext = () => createMockContext({ errors: mailchimpTemplatesTool.errors });
const formatTool = mailchimpTemplatesTool.format;
if (!formatTool) throw new Error('mailchimpTemplatesTool must define format().');

/** A 204 carries a null body, which Node's `Response` requires. */
function fakeResponse(status: number, body: unknown = ''): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(status === 204 ? null : text, {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' },
  });
}

const TEMPLATE_FIXTURE = {
  id: 10012367,
  name: 'Newsletter — Spring',
  type: 'user',
  created_by: 'tester',
  date_created: '2026-04-21T21:31:30+00:00',
  date_edited: '2026-04-21T21:31:30+00:00',
  active: true,
  drag_and_drop: false,
  responsive: true,
} as const;

describe('mailchimpTemplatesTool — input schema coercion', () => {
  it('coerces string templateId to number (operation: get)', () => {
    const parsed = mailchimpTemplatesTool.input.parse({
      operation: 'get',
      templateId: '10012367',
    });
    expect(parsed.templateId).toBe(10012367);
    expect(typeof parsed.templateId).toBe('number');
  });

  it('coerces string count and offset (operation: list)', () => {
    const parsed = mailchimpTemplatesTool.input.parse({
      operation: 'list',
      count: '50',
      offset: '100',
    });
    expect(parsed.count).toBe(50);
    expect(parsed.offset).toBe(100);
  });

  it('applies defaults for count/offset when omitted', () => {
    const parsed = mailchimpTemplatesTool.input.parse({ operation: 'list' });
    expect(parsed.count).toBe(20);
    expect(parsed.offset).toBe(0);
  });

  it('rejects non-numeric templateId strings', () => {
    expect(() =>
      mailchimpTemplatesTool.input.parse({ operation: 'get', templateId: 'not-a-number' }),
    ).toThrow();
  });

  it('rejects count above the 1000 max even when passed as string', () => {
    expect(() =>
      mailchimpTemplatesTool.input.parse({ operation: 'list', count: '9999' }),
    ).toThrow();
  });

  it('rejects negative offsets', () => {
    expect(() => mailchimpTemplatesTool.input.parse({ operation: 'list', offset: '-1' })).toThrow();
  });
});

describe('mailchimpTemplatesTool — handler', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('list: returns summarized templates and totalItems', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse(200, {
          templates: [TEMPLATE_FIXTURE],
          total_items: 1,
        }),
      ),
    );
    const input = mailchimpTemplatesTool.input.parse({ operation: 'list' });
    const result = await mailchimpTemplatesTool.handler(input, createToolContext());
    expect(result.operation).toBe('list');
    expect(result.totalItems).toBe(1);
    expect(result.templates).toHaveLength(1);
    expect(result.templates?.[0]?.id).toBe(10012367);
    expect(result.templates?.[0]?.name).toBe('Newsletter — Spring');
  });

  it('list: forwards type and category filters to the upstream query', async () => {
    const stub = vi.fn(async (_input: Parameters<typeof fetch>[0]) =>
      fakeResponse(200, { templates: [], total_items: 0 }),
    );
    vi.stubGlobal('fetch', stub);
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'list',
      type: 'user',
      category: 'promos',
    });
    await mailchimpTemplatesTool.handler(input, createToolContext());
    const url = String(stub.mock.calls[0]?.[0]);
    expect(url).toContain('type=user');
    expect(url).toContain('category=promos');
  });

  it('get: calls GET /templates/{id} and returns a summarized template', async () => {
    const stub = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toContain('/templates/10012367');
      return fakeResponse(200, TEMPLATE_FIXTURE);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'get',
      templateId: '10012367', // string — regression guard
    });
    const result = await mailchimpTemplatesTool.handler(input, createToolContext());
    expect(stub).toHaveBeenCalledOnce();
    expect(result.operation).toBe('get');
    expect(result.template?.id).toBe(10012367);
  });

  it('create: requires name', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'create',
      html: '<h1>x</h1>',
    });
    await expect(mailchimpTemplatesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'name' is required"),
    });
  });

  it('create: requires html', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'create',
      name: 'New Template',
    });
    await expect(mailchimpTemplatesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'html' is required"),
    });
  });

  it('create: POSTs to /templates and surfaces the returned template', async () => {
    const stub = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toMatch(/\/templates$/);
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: 'New Template', html: '<h1>x</h1>' });
      return fakeResponse(200, { ...TEMPLATE_FIXTURE, id: 2222222, name: 'New Template' });
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'create',
      name: 'New Template',
      html: '<h1>x</h1>',
    });
    const result = await mailchimpTemplatesTool.handler(input, createToolContext());
    expect(result.template?.id).toBe(2222222);
  });

  it('update with just name: sends PATCH with only { name }', async () => {
    const stub = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: 'Renamed' });
      return fakeResponse(200, { ...TEMPLATE_FIXTURE, name: 'Renamed' });
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'update',
      templateId: '10012367',
      name: 'Renamed',
    });
    const result = await mailchimpTemplatesTool.handler(input, createToolContext());
    expect(result.operation).toBe('update');
    expect(result.template?.name).toBe('Renamed');
  });

  it('update with just html: sends PATCH with only { html }', async () => {
    const stub = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ html: '<h1>new</h1>' });
      return fakeResponse(200, TEMPLATE_FIXTURE);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'update',
      templateId: '10012367',
      html: '<h1>new</h1>',
    });
    await mailchimpTemplatesTool.handler(input, createToolContext());
    expect(stub).toHaveBeenCalledOnce();
  });

  it('update with all three fields: forwards each as Mailchimp expects (folder_id snake_case)', async () => {
    const stub = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: 'n', html: '<h1>h</h1>', folder_id: 'f123' });
      return fakeResponse(200, TEMPLATE_FIXTURE);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'update',
      templateId: '10012367',
      name: 'n',
      html: '<h1>h</h1>',
      folderId: 'f123',
    });
    await mailchimpTemplatesTool.handler(input, createToolContext());
  });

  it('update with no name/html/folderId: throws a descriptive validation error and does NOT call upstream', async () => {
    const stub = vi.fn();
    vi.stubGlobal('fetch', stub);
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'update',
      templateId: '10012367',
    });
    await expect(mailchimpTemplatesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Per-section overrides live on campaigns'),
    });
    // `GET /templates/{id}` carries no HTML, so the hint must not send callers there for it.
    await expect(mailchimpTemplatesTool.handler(input, createToolContext())).rejects.toMatchObject({
      message: expect.not.stringContaining('GET the template'),
    });
    await expect(mailchimpTemplatesTool.handler(input, createToolContext())).rejects.toMatchObject({
      message: expect.stringContaining('`get` returns metadata only, not HTML'),
    });
    expect(stub).not.toHaveBeenCalled();
  });

  it('update without templateId: throws the templateId-required validation error', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'update',
      name: 'Renamed',
    });
    await expect(mailchimpTemplatesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'templateId' is required"),
    });
  });

  it('delete: issues DELETE and sets deleted=true', async () => {
    const stub = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.method).toBe('DELETE');
      return fakeResponse(204, '');
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'delete',
      templateId: '10012367',
    });
    const result = await mailchimpTemplatesTool.handler(input, createToolContext());
    expect(result.deleted).toBe(true);
  });

  it('get-default-content: returns sections map when Mailchimp provides one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse(200, {
          sections: { headline: '<h1>Welcome</h1>', body: '<p>Hi</p>' },
        }),
      ),
    );
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'get-default-content',
      templateId: '10012367',
    });
    const result = await mailchimpTemplatesTool.handler(input, createToolContext());
    expect(result.defaultContent?.sections).toEqual({
      headline: '<h1>Welcome</h1>',
      body: '<p>Hi</p>',
    });
  });

  it('get-default-content: returns empty defaultContent object when Mailchimp returns no sections', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(200, { sections: {} })),
    );
    const input = mailchimpTemplatesTool.input.parse({
      operation: 'get-default-content',
      templateId: '10012367',
    });
    const result = await mailchimpTemplatesTool.handler(input, createToolContext());
    // Empty object sections is truthy → forwarded; format handles the hint.
    expect(result.defaultContent).toEqual({ sections: {} });
  });
});

describe('mailchimpTemplatesTool — metadata', () => {
  it('tool description calls out that per-section patching is not supported here', () => {
    expect(mailchimpTemplatesTool.description).toContain('Per-section editing is not supported');
    // Directs callers to the correct workflow for per-section edits.
    expect(mailchimpTemplatesTool.description).toContain('mailchimp_campaigns');
    expect(mailchimpTemplatesTool.description).toContain('templateSections');
  });

  it('tool description does not claim `get` returns template HTML', () => {
    expect(mailchimpTemplatesTool.description).not.toContain('GET the template');
    expect(mailchimpTemplatesTool.description).toContain('`get` returns metadata only, not HTML');
  });
});

describe('mailchimpTemplatesTool — format', () => {
  it('renders a list with counts', () => {
    const text = formatTool({
      operation: 'list',
      totalItems: 3,
      templates: [
        {
          id: 1,
          name: 'A',
          type: 'user',
          dateCreated: '2026-01-01T00:00:00+00:00',
          active: true,
        },
      ],
    });
    const block = text[0];
    if (block?.type !== 'text') throw new Error('expected text block');
    expect(block.text).toContain('# Templates (1 of 3)');
    expect(block.text).toContain('**A**');
  });

  it('renders a detail with metadata and flags', () => {
    const text = formatTool({
      operation: 'get',
      template: {
        id: 10012367,
        name: 'Renamed',
        type: 'user',
        createdBy: 'tester',
        dateCreated: '2026-04-21T21:31:30+00:00',
        active: true,
        dragAndDrop: false,
        responsive: true,
      },
    });
    const block = text[0];
    if (block?.type !== 'text') throw new Error('expected text block');
    expect(block.text).toContain('# Renamed');
    expect(block.text).toContain('10012367');
    expect(block.text).toContain('dragAndDrop false');
    expect(block.text).toContain('responsive true');
  });

  it('default-content: shows the hint when sections map is empty', () => {
    const text = formatTool({
      operation: 'get-default-content',
      defaultContent: { sections: {} },
    });
    const block = text[0];
    if (block?.type !== 'text') throw new Error('expected text block');
    expect(block.text).toContain('Default content sections (0)');
    expect(block.text).toContain('Mailchimp only populates this map for drag-and-drop templates');
    expect(block.text).toContain('`mc:edit="…"`');
    expect(block.text).toContain('templateSections');
    expect(block.text).not.toContain('read the HTML directly');
    expect(block.text).toContain('`get` returns metadata only, not HTML');
  });

  it('default-content: shows sections as JSON when populated', () => {
    const text = formatTool({
      operation: 'get-default-content',
      defaultContent: {
        sections: { headline: '<h1>Welcome</h1>' },
      },
    });
    const block = text[0];
    if (block?.type !== 'text') throw new Error('expected text block');
    expect(block.text).toContain('Default content sections (1)');
    expect(block.text).toContain('```json');
    expect(block.text).toContain('"headline"');
    expect(block.text).toContain('<h1>Welcome</h1>');
  });

  it('delete: shows deleted marker', () => {
    const text = formatTool({ operation: 'delete', deleted: true });
    const block = text[0];
    if (block?.type !== 'text') throw new Error('expected text block');
    expect(block.text).toContain('Deleted: true');
  });
});

describe('mailchimpTemplatesTool — list enrichment (structuredContent + content[] trailer)', () => {
  const NO_MATCH =
    'No templates matched. Widen or drop `type`, `category`, and `folderId`; to author a template on any plan, use `mailchimp_local_templates`.';
  const PAST_END =
    'No templates on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.';

  let urls: string[];
  const stubList = (body: unknown) => {
    urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        urls.push(String(input));
        return fakeResponse(200, body);
      }),
    );
  };
  const trailerOf = (result: Awaited<ReturnType<typeof runToolContract>>) => {
    const block = result.content[1];
    return block?.type === 'text' ? block.text : undefined;
  };

  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('non-empty page: filters equal the defaulted query sent upstream; no notice', async () => {
    stubList({ templates: [TEMPLATE_FIXTURE], total_items: 7 });
    const result = await runToolContract(mailchimpTemplatesTool, { operation: 'list' });
    expect(Object.fromEntries(new URL(urls[0] ?? '').searchParams)).toEqual({
      count: '20',
      offset: '0',
    });
    expect(result.structuredContent).toMatchObject({
      totalItems: 7,
      filters: { count: 20, offset: 0 },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(trailerOf(result)).toBe('\n\n**Filters:** count `20` · offset `0`');
  });

  it('empty filtered page: every sent filter is echoed and the no-match notice renders as a blockquote', async () => {
    stubList({ templates: [], total_items: 0 });
    const result = await runToolContract(mailchimpTemplatesTool, {
      operation: 'list',
      type: 'user',
      category: 'promos',
      folderId: 'f9',
      count: 5,
    });
    expect(Object.fromEntries(new URL(urls[0] ?? '').searchParams)).toEqual({
      count: '5',
      offset: '0',
      type: 'user',
      category: 'promos',
      folder_id: 'f9',
    });
    expect(result.structuredContent).toMatchObject({
      totalItems: 0,
      templates: [],
      filters: { count: 5, offset: 0, type: 'user', category: 'promos', folderId: 'f9' },
      notice: NO_MATCH,
    });
    expect(trailerOf(result)).toBe(
      `\n\n**Filters:** count \`5\` · offset \`0\` · type \`user\` · category \`promos\` · folderId \`f9\`\n> ${NO_MATCH}`,
    );
  });

  it('empty page at or past a nonzero totalItems gets the past-end notice', async () => {
    stubList({ templates: [], total_items: 3 });
    const result = await runToolContract(mailchimpTemplatesTool, { operation: 'list', offset: 3 });
    expect(result.structuredContent).toMatchObject({ totalItems: 3, notice: PAST_END });
  });

  it('non-list operations carry neither field', async () => {
    stubList(TEMPLATE_FIXTURE);
    const result = await runToolContract(mailchimpTemplatesTool, {
      operation: 'get',
      templateId: 10012367,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('filters');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.content).toHaveLength(1);
  });
});
