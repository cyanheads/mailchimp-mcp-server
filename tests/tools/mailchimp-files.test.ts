/**
 * @fileoverview Tests for the `mailchimp_files` tool. Covers input coercion,
 * required-field validation per operation, the upload payload shape
 * (`file_data` snake_case mapping), and `format()` surfacing of `fullSizeUrl`
 * for HTML embedding. Stubs `fetch` for end-to-end coverage of every operation.
 * @module tests/tools/mailchimp-files.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

function fakeResponse(status: number, body: unknown = ''): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
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
    const result = await mailchimpFilesTool.handler(input, createMockContext());
    expect(result.operation).toBe('list');
    expect(result.totalItems).toBe(1);
    expect(result.totalFileSizeInBytes).toBe(68);
    expect(result.files).toHaveLength(1);
    expect(result.files?.[0]?.id).toBe(2641183);
    expect(result.files?.[0]?.fullSizeUrl).toBe('https://mcusercontent.com/abc/images/xxx.png');
  });

  it('list: forwards type and folder filter to the upstream query', async () => {
    const stub = vi.fn(async () =>
      fakeResponse(200, { files: [], total_file_size: 0, total_items: 0 }),
    );
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({
      operation: 'list',
      type: 'image',
      folderId: '42',
      sinceCreatedAt: '2026-01-01',
    });
    await mailchimpFilesTool.handler(input, createMockContext());
    const url = String(stub.mock.calls[0]?.[0]);
    expect(url).toContain('type=image');
    expect(url).toContain('folder_id=42');
    expect(url).toContain('since_created_at=2026-01-01');
  });

  it('get: requires fileId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'get' });
    await expect(mailchimpFilesTool.handler(input, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'fileId' is required"),
    });
  });

  it('get: calls GET /file-manager/files/{id}', async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/file-manager/files/2641183');
      return fakeResponse(200, FILE_FIXTURE);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({ operation: 'get', fileId: '2641183' });
    const result = await mailchimpFilesTool.handler(input, createMockContext());
    expect(stub).toHaveBeenCalledOnce();
    expect(result.file?.id).toBe(2641183);
    expect(result.file?.fullSizeUrl).toBe('https://mcusercontent.com/abc/images/xxx.png');
  });

  it('upload: requires name', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'upload', fileData: 'AAAA' });
    await expect(mailchimpFilesTool.handler(input, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'name' is required"),
    });
  });

  it('upload: requires fileData', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'upload', name: 'logo.png' });
    await expect(mailchimpFilesTool.handler(input, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'fileData' is required"),
    });
  });

  it('upload: POSTs to /file-manager/files with file_data (snake_case) and folder_id', async () => {
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    const result = await mailchimpFilesTool.handler(input, createMockContext());
    expect(result.file?.id).toBe(2641183);
  });

  it('upload: omits folder_id from payload when not provided', async () => {
    const stub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
    await mailchimpFilesTool.handler(input, createMockContext());
    expect(stub).toHaveBeenCalledOnce();
  });

  it('update: requires fileId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'update', name: 'x.png' });
    await expect(mailchimpFilesTool.handler(input, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'fileId' is required"),
    });
  });

  it('update: requires at least one of name/folderId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'update', fileId: '2641183' });
    await expect(mailchimpFilesTool.handler(input, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('at least one of'),
    });
  });

  it('update: PATCHes /file-manager/files/{id} with snake_case folder_id', async () => {
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    const result = await mailchimpFilesTool.handler(input, createMockContext());
    expect(stub).toHaveBeenCalledOnce();
    expect(result.file?.name).toBe('renamed.png');
  });

  it('update: name-only PATCH omits folder_id from payload', async () => {
    const stub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
    await mailchimpFilesTool.handler(input, createMockContext());
    expect(stub).toHaveBeenCalledOnce();
  });

  it('delete: requires fileId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'delete' });
    await expect(mailchimpFilesTool.handler(input, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'fileId' is required"),
    });
  });

  it('delete: DELETEs /file-manager/files/{id} and returns deleted: true on 204', async () => {
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/file-manager/files/2641183');
      expect(init?.method).toBe('DELETE');
      return fakeResponse(204);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({ operation: 'delete', fileId: '2641183' });
    const result = await mailchimpFilesTool.handler(input, createMockContext());
    expect(result.deleted).toBe(true);
  });

  it('list-folders: returns summarized folders and totalItems', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(200, { folders: [FOLDER_FIXTURE], total_items: 1 })),
    );
    const input = mailchimpFilesTool.input.parse({ operation: 'list-folders' });
    const result = await mailchimpFilesTool.handler(input, createMockContext());
    expect(result.operation).toBe('list-folders');
    expect(result.totalItems).toBe(1);
    expect(result.folders).toHaveLength(1);
    expect(result.folders?.[0]?.fileCount).toBe(3);
  });

  it('get-folder: requires folderId', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const input = mailchimpFilesTool.input.parse({ operation: 'get-folder' });
    await expect(mailchimpFilesTool.handler(input, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'folderId' is required"),
    });
  });

  it('get-folder: GETs /file-manager/folders/{id}', async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/file-manager/folders/42');
      return fakeResponse(200, FOLDER_FIXTURE);
    });
    vi.stubGlobal('fetch', stub);
    const input = mailchimpFilesTool.input.parse({ operation: 'get-folder', folderId: '42' });
    const result = await mailchimpFilesTool.handler(input, createMockContext());
    expect(stub).toHaveBeenCalledOnce();
    expect(result.folder?.id).toBe(42);
  });
});

describe('mailchimpFilesTool — format()', () => {
  it('upload result surfaces the embed hint and fullSizeUrl', () => {
    const out = mailchimpFilesTool.format({
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

  it('list result with empty files prompts upload', () => {
    const out = mailchimpFilesTool.format({
      operation: 'list',
      files: [],
      totalItems: 0,
      totalFileSizeInBytes: 0,
    });
    const text = out[0]?.type === 'text' ? out[0].text : '';
    expect(text).toContain('No files');
    expect(text).toContain('operation: upload');
  });

  it('delete result reports deleted: true', () => {
    const out = mailchimpFilesTool.format({ operation: 'delete', deleted: true });
    const text = out[0]?.type === 'text' ? out[0].text : '';
    expect(text).toContain('Deleted: true');
  });
});
