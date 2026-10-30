/**
 * @fileoverview Tests for the `mailchimp_files` tool. Covers input coercion,
 * required-field validation per operation, the upload payload shape
 * (`file_data` snake_case mapping), and `format()` surfacing of `fullSizeUrl`
 * for HTML embedding. Stubs `fetch` for end-to-end coverage of every operation.
 * @module tests/tools/mailchimp-files.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpFilesTool } from '@/mcp-server/tools/definitions/mailchimp-files.tool.js';
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

const createToolContext = () => createMockContext({ errors: mailchimpFilesTool.errors });
const formatTool = mailchimpFilesTool.format;
if (!formatTool) throw new Error('mailchimpFilesTool must define format().');

/** A 204 carries a null body, which Node's `Response` requires. */
function fakeResponse(status: number, body: unknown = ''): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(status === 204 ? null : text, {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' },
  });
}

const FILE_FIXTURE = {
  id: 2641183,
  folder_id: 0,
  type: 'image' as const,
  name: 'hero.png',
  full_size_url: 'https://mcusercontent.com/abc/images/xxx.png',
  thumbnail_url: 'https://mcusercontent.com/abc/_thumbs/xxx.png',
  size: 68,
  width: 1,
  height: 1,
  created_at: '2026-04-24T23:38:09+00:00',
  created_by: 'Casey',
};

const FOLDER_FIXTURE = {
  id: 42,
  name: 'Brand assets',
  file_count: 3,
  created_at: '2026-04-20T10:00:00+00:00',
  created_by: 'Casey',
};

describe('mailchimpFilesTool — input schema coercion', () => {
  it('coerces string fileId to number (operation: get)', () => {
    const parsed = mailchimpFilesTool.input.parse({ operation: 'get', fileId: '2641183' });
    expect(parsed.fileId).toBe(2641183);
  });

  it('coerces string folderId to number (operation: get-folder)', () => {
    const parsed = mailchimpFilesTool.input.parse({ operation: 'get-folder', folderId: '42' });
    expect(parsed.folderId).toBe(42);
  });

  it('coerces string count and offset (operation: list)', () => {
    const parsed = mailchimpFilesTool.input.parse({
      operation: 'list',
      count: '50',
      offset: '100',
    });
    expect(parsed.count).toBe(50);
    expect(parsed.offset).toBe(100);
  });

  it('applies defaults for count/offset when omitted', () => {
    const parsed = mailchimpFilesTool.input.parse({ operation: 'list' });
    expect(parsed.count).toBe(10);
    expect(parsed.offset).toBe(0);
  });

  it('rejects count above the 1000 max even when passed as string', () => {
    expect(() => mailchimpFilesTool.input.parse({ operation: 'list', count: '9999' })).toThrow();
  });
});

describe('mailchimpFilesTool — handler', () => {
  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('list: returns summarized files, totalItems, totalFileSizeInBytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse(200, {
          files: [FILE_FIXTURE],
          total_file_size: 68,
          total_items: 1,
        }),
      ),
    );
    const input = mailchimpFilesTool.input.parse({ operation: 'list' });
    const result = await mailchimpFilesTool.handler(input, createToolContext());
    expect(result.operation).toBe('list');
    expect(result.totalItems).toBe(1);
    expect(result.totalFileSizeInBytes).toBe(68);
    expect(result.files).toHaveLength(1);
    expect(result.files?.[0]?.id).toBe(2641183);
    expect(result.files?.[0]?.fullSizeUrl).toBe('https://mcusercontent.com/abc/images/xxx.png');
  });

  it('list: forwards type and folder filter to the upstream query', async () => {
    const stub = vi.fn(async (_input: Parameters<typeof fetch>[0]) =>
      fakeResponse(200, { files: [], total_file_size: 0, total_items: 0 }),
    );
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({
      operation: 'list',
      type: 'image',
      folderId: '42',
      sinceCreatedAt: '2026-01-01',
    });
    await mailchimpFilesTool.handler(input, createToolContext());
    const url = String(stub.mock.calls[0]?.[0]);
    expect(url).toContain('type=image');
    expect(url).toContain('folder_id=42');
    expect(url).toContain('since_created_at=2026-01-01');
  });

  it('get: requires fileId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'get' });
    await expect(mailchimpFilesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'fileId' is required"),
    });
  });

  it('get: calls GET /file-manager/files/{id}', async () => {
    const stub = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toContain('/file-manager/files/2641183');
      return fakeResponse(200, FILE_FIXTURE);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({ operation: 'get', fileId: '2641183' });
    const result = await mailchimpFilesTool.handler(input, createToolContext());
    expect(stub).toHaveBeenCalledOnce();
    expect(result.file?.id).toBe(2641183);
    expect(result.file?.fullSizeUrl).toBe('https://mcusercontent.com/abc/images/xxx.png');
  });

  it('upload: requires name', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'upload', fileData: 'AAAA' });
    await expect(mailchimpFilesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'name' is required"),
    });
  });

  it('upload: requires fileData', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'upload', name: 'logo.png' });
    await expect(mailchimpFilesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'fileData' is required"),
    });
  });

  it('upload: POSTs to /file-manager/files with file_data (snake_case) and folder_id', async () => {
    const stub = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toMatch(/\/file-manager\/files$/);
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        name: 'hero.png',
        file_data: 'iVBORw0KGgo=',
        folder_id: 42,
      });
      return fakeResponse(200, FILE_FIXTURE);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({
      operation: 'upload',
      name: 'hero.png',
      fileData: 'iVBORw0KGgo=',
      folderId: '42',
    });
    const result = await mailchimpFilesTool.handler(input, createToolContext());
    expect(result.file?.id).toBe(2641183);
  });

  it('upload: omits folder_id from payload when not provided', async () => {
    const stub = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty('folder_id');
      return fakeResponse(200, FILE_FIXTURE);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({
      operation: 'upload',
      name: 'hero.png',
      fileData: 'iVBORw0KGgo=',
    });
    await mailchimpFilesTool.handler(input, createToolContext());
    expect(stub).toHaveBeenCalledOnce();
  });

  it('update: requires fileId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'update', name: 'x.png' });
    await expect(mailchimpFilesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'fileId' is required"),
    });
  });

  it('update: requires at least one of name/folderId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'update', fileId: '2641183' });
    await expect(mailchimpFilesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('at least one of'),
    });
  });

  it('update: PATCHes /file-manager/files/{id} with snake_case folder_id', async () => {
    const stub = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toContain('/file-manager/files/2641183');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: 'renamed.png', folder_id: 0 });
      return fakeResponse(200, { ...FILE_FIXTURE, name: 'renamed.png' });
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({
      operation: 'update',
      fileId: '2641183',
      name: 'renamed.png',
      folderId: '0',
    });
    const result = await mailchimpFilesTool.handler(input, createToolContext());
    expect(stub).toHaveBeenCalledOnce();
    expect(result.file?.name).toBe('renamed.png');
  });

  it('update: name-only PATCH omits folder_id from payload', async () => {
    const stub = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: 'renamed.png' });
      return fakeResponse(200, { ...FILE_FIXTURE, name: 'renamed.png' });
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({
      operation: 'update',
      fileId: '2641183',
      name: 'renamed.png',
    });
    await mailchimpFilesTool.handler(input, createToolContext());
    expect(stub).toHaveBeenCalledOnce();
  });

  it('delete: requires fileId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'delete' });
    await expect(mailchimpFilesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'fileId' is required"),
    });
  });

  it('delete: DELETEs /file-manager/files/{id} and returns deleted: true on 204', async () => {
    const stub = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toContain('/file-manager/files/2641183');
      expect(init?.method).toBe('DELETE');
      return fakeResponse(204);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({ operation: 'delete', fileId: '2641183' });
    const result = await mailchimpFilesTool.handler(input, createToolContext());
    expect(result.deleted).toBe(true);
  });

  it('list-folders: returns summarized folders and totalItems', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(200, { folders: [FOLDER_FIXTURE], total_items: 1 })),
    );
    const input = mailchimpFilesTool.input.parse({ operation: 'list-folders' });
    const result = await mailchimpFilesTool.handler(input, createToolContext());
    expect(result.operation).toBe('list-folders');
    expect(result.totalItems).toBe(1);
    expect(result.folders).toHaveLength(1);
    expect(result.folders?.[0]?.fileCount).toBe(3);
  });

  it('get-folder: requires folderId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'get-folder' });
    await expect(mailchimpFilesTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'folderId' is required"),
    });
  });

  it('get-folder: GETs /file-manager/folders/{id}', async () => {
    const stub = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toContain('/file-manager/folders/42');
      return fakeResponse(200, FOLDER_FIXTURE);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({ operation: 'get-folder', folderId: '42' });
    const result = await mailchimpFilesTool.handler(input, createToolContext());
    expect(stub).toHaveBeenCalledOnce();
    expect(result.folder?.id).toBe(42);
  });
});

describe('mailchimpFilesTool — format()', () => {
  it('upload result surfaces the embed hint and fullSizeUrl', () => {
    const out = formatTool({
      operation: 'upload',
      file: {
        id: 1,
        name: 'hero.png',
        fullSizeUrl: 'https://example/x.png',
        thumbnailUrl: 'https://example/_t.png',
        type: 'image',
        sizeInBytes: 68,
        widthInPixels: 1,
        heightInPixels: 1,
      },
    });
    const text = out[0]?.type === 'text' ? out[0].text : '';
    expect(text).toContain('Embed `fullSizeUrl`');
    expect(text).toContain('https://example/x.png');
    expect(text).toContain('1×1');
  });

  it('list result with empty files renders only the header — the next step lives in the notice', () => {
    const out = formatTool({
      operation: 'list',
      files: [],
      totalItems: 0,
      totalFileSizeInBytes: 0,
    });
    const text = out[0]?.type === 'text' ? out[0].text : '';
    expect(text).toBe('Operation: list\n\n# Files (0 of 0, total 0 B)');
  });

  it('delete result reports deleted: true', () => {
    const out = formatTool({ operation: 'delete', deleted: true });
    const text = out[0]?.type === 'text' ? out[0].text : '';
    expect(text).toContain('Deleted: true');
  });
});

describe('mailchimpFilesTool — list enrichment (structuredContent + content[] trailer)', () => {
  const FILES_NO_MATCH =
    'No files matched. Widen or drop `type`, `folderId`, `beforeCreatedAt`, and `sinceCreatedAt`; with none set, File Manager is empty — add a file with `operation: upload`.';
  const FILES_PAST_END =
    'No files on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.';
  const FOLDERS_NO_MATCH =
    'No folders matched. Drop `createdBy` to list every folder; with it unset, there are no folders — files upload to the root folder when `folderId` is omitted.';
  const FOLDERS_PAST_END =
    'No folders on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.';

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
  const sentQuery = () => Object.fromEntries(new URL(urls[0] ?? '').searchParams);
  const texts = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => (block.type === 'text' ? block.text : ''));

  beforeEach(() => {
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('list: non-empty page echoes the defaulted query; no notice', async () => {
    stubList({ files: [FILE_FIXTURE], total_file_size: 68, total_items: 12 });
    const result = await runToolContract(mailchimpFilesTool, { operation: 'list' });
    expect(sentQuery()).toEqual({ count: '10', offset: '0' });
    expect(result.structuredContent).toMatchObject({
      totalItems: 12,
      totalFileSizeInBytes: 68,
      filters: { count: 10, offset: 0 },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(texts(result)[1]).toBe('\n\n**Filters:** count `10` · offset `0`');
  });

  it('list: empty filtered page echoes every filter (folderId 0 included) and renders the notice once', async () => {
    stubList({ files: [], total_file_size: 0, total_items: 0 });
    const result = await runToolContract(mailchimpFilesTool, {
      operation: 'list',
      type: 'image',
      folderId: 0,
      beforeCreatedAt: '2026-02-01',
      sinceCreatedAt: '2026-01-01',
    });
    expect(sentQuery()).toEqual({
      count: '10',
      offset: '0',
      type: 'image',
      folder_id: '0',
      before_created_at: '2026-02-01',
      since_created_at: '2026-01-01',
    });
    expect(result.structuredContent).toMatchObject({
      totalItems: 0,
      files: [],
      filters: {
        count: 10,
        offset: 0,
        type: 'image',
        folderId: 0,
        beforeCreatedAt: '2026-02-01',
        sinceCreatedAt: '2026-01-01',
      },
      notice: FILES_NO_MATCH,
    });
    const [body, trailer] = texts(result);
    expect(body).toBe('Operation: list\n\n# Files (0 of 0, total 0 B)');
    expect(trailer).toBe(
      `\n\n**Filters:** count \`10\` · offset \`0\` · type \`image\` · folderId \`0\` · beforeCreatedAt \`2026-02-01\` · sinceCreatedAt \`2026-01-01\`\n> ${FILES_NO_MATCH}`,
    );
    expect(result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')).not.toContain(
      '_No files',
    );
  });

  it('list: offset past a nonzero totalItems gets the past-end notice', async () => {
    stubList({ files: [], total_file_size: 680, total_items: 12 });
    const result = await runToolContract(mailchimpFilesTool, { operation: 'list', offset: 20 });
    expect(result.structuredContent).toMatchObject({ totalItems: 12, notice: FILES_PAST_END });
  });

  it('list-folders: non-empty page echoes the defaulted query; no notice', async () => {
    stubList({ folders: [FOLDER_FIXTURE], total_items: 1 });
    const result = await runToolContract(mailchimpFilesTool, { operation: 'list-folders' });
    expect(sentQuery()).toEqual({ count: '10', offset: '0' });
    expect(result.structuredContent).toMatchObject({
      totalItems: 1,
      filters: { count: 10, offset: 0 },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(texts(result)[0]).toContain('- **Brand assets** (`42`) — 3 files');
  });

  it('list-folders: empty page with createdBy echoes it; the notice replaces the format() prose', async () => {
    stubList({ folders: [], total_items: 0 });
    const result = await runToolContract(mailchimpFilesTool, {
      operation: 'list-folders',
      createdBy: 'Casey',
    });
    expect(sentQuery()).toEqual({ count: '10', offset: '0', created_by: 'Casey' });
    expect(result.structuredContent).toMatchObject({
      folders: [],
      filters: { count: 10, offset: 0, createdBy: 'Casey' },
      notice: FOLDERS_NO_MATCH,
    });
    const [body, trailer] = texts(result);
    expect(body).toBe('Operation: list-folders\n\n# Folders (0 of 0)');
    expect(trailer).toBe(
      `\n\n**Filters:** count \`10\` · offset \`0\` · createdBy \`Casey\`\n> ${FOLDERS_NO_MATCH}`,
    );
  });

  it('list-folders: offset past a nonzero totalItems gets the past-end notice', async () => {
    stubList({ folders: [], total_items: 4 });
    const result = await runToolContract(mailchimpFilesTool, {
      operation: 'list-folders',
      offset: 4,
    });
    expect(result.structuredContent).toMatchObject({ totalItems: 4, notice: FOLDERS_PAST_END });
  });

  it('non-list operations carry neither field', async () => {
    stubList(FOLDER_FIXTURE);
    const result = await runToolContract(mailchimpFilesTool, {
      operation: 'get-folder',
      folderId: 42,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('filters');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.content).toHaveLength(1);
  });
});
