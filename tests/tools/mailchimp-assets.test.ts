/**
 * @fileoverview Tests for the `mailchimp_assets` tool. Wires the tool against
 * a real AssetService backed by a tmp-dir fixture and a mocked Mailchimp
 * service. Covers each operation end-to-end and the configuration-error path
 * when no asset service is registered.
 * @module tests/tools/mailchimp-assets.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { mailchimpAssetsTool } from '@/mcp-server/tools/definitions/mailchimp-assets.tool.js';
import { AssetCache } from '@/services/assets/asset-cache.js';
import { AssetService, setAssetServiceForTesting } from '@/services/assets/asset-service.js';
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

const createToolContext = () => createMockContext({ errors: mailchimpAssetsTool.errors });
const formatTool = mailchimpAssetsTool.format;
if (!formatTool) throw new Error('mailchimpAssetsTool must define format().');

function fakeUploadResponse(id: number): Response {
  return new Response(
    JSON.stringify({
      id,
      folder_id: 0,
      type: 'image',
      name: 'asset.png',
      full_size_url: `https://mcusercontent.com/test/images/${id}.png`,
      thumbnail_url: `https://mcusercontent.com/test/_thumbs/${id}.png`,
      size: 4,
      width: 1,
      height: 1,
      created_at: '2026-04-24T00:00:00+00:00',
      created_by: 'tester',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function setup(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'mailchimp-assets-tool-'));
  await writeFile(join(dir, 'hero.png'), Buffer.from('AAAA'), 'binary');
  await writeFile(join(dir, 'icon.png'), Buffer.from('BBBB'), 'binary');
  const cache = new AssetCache(dir);
  await cache.load();
  setAssetServiceForTesting(new AssetService(dir, cache, 4));
  setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      setAssetServiceForTesting(undefined);
      setMailchimpServiceForTesting(undefined);
      vi.unstubAllGlobals();
    },
  };
}

describe('mailchimpAssetsTool — config error path', () => {
  it('throws ConfigurationError when asset service is not initialized', async () => {
    setAssetServiceForTesting(undefined);
    const input = mailchimpAssetsTool.input.parse({ operation: 'list' });
    await expect(mailchimpAssetsTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining('MAILCHIMP_ASSETS_DIR'),
    });
  });
});

describe('mailchimpAssetsTool — operations', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setup());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('list: returns entries sorted by relPath with assetsDir', async () => {
    const input = mailchimpAssetsTool.input.parse({ operation: 'list' });
    const result = await mailchimpAssetsTool.handler(input, createToolContext());
    expect(result.assetsDir).toBe(dir);
    expect(result.assets).toHaveLength(2);
    expect(result.assets?.[0]?.relPath).toBe('hero.png');
    expect(result.assets?.[1]?.relPath).toBe('icon.png');
    expect(result.cacheSize).toBe(0);
  });

  it('info: requires relPath', async () => {
    const input = mailchimpAssetsTool.input.parse({ operation: 'info' });
    await expect(mailchimpAssetsTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining("'relPath' is required"),
    });
  });

  it('info: returns sha256 + cached: undefined when never uploaded', async () => {
    const input = mailchimpAssetsTool.input.parse({ operation: 'info', relPath: 'hero.png' });
    const result = await mailchimpAssetsTool.handler(input, createToolContext());
    expect(result.asset?.relPath).toBe('hero.png');
    expect(result.asset?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.asset?.cached).toBeUndefined();
  });

  it('info: rejects path traversal', async () => {
    const input = mailchimpAssetsTool.input.parse({ operation: 'info', relPath: '../escape' });
    await expect(mailchimpAssetsTool.handler(input, createToolContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
  });

  it('sync: uploads uncached files and reports counts', async () => {
    let counter = 100;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeUploadResponse(++counter)),
    );

    const input = mailchimpAssetsTool.input.parse({ operation: 'sync' });
    const result = await mailchimpAssetsTool.handler(input, createToolContext());
    expect(result.uploaded).toBe(2);
    expect(result.cached).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.cacheSize).toBe(2);
  });

  it('sync: re-running with full cache reports cached count, no uploads', async () => {
    let counter = 100;
    const fetchStub = vi.fn(async () => fakeUploadResponse(++counter));
    vi.stubGlobal('fetch', fetchStub);

    const first = mailchimpAssetsTool.input.parse({ operation: 'sync' });
    await mailchimpAssetsTool.handler(first, createToolContext());

    const second = mailchimpAssetsTool.input.parse({ operation: 'sync' });
    const result = await mailchimpAssetsTool.handler(second, createToolContext());
    expect(result.uploaded).toBe(0);
    expect(result.cached).toBe(2);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('clear-cache: empties the cache', async () => {
    let counter = 100;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeUploadResponse(++counter)),
    );

    await mailchimpAssetsTool.handler(
      mailchimpAssetsTool.input.parse({ operation: 'sync' }),
      createToolContext(),
    );

    const result = await mailchimpAssetsTool.handler(
      mailchimpAssetsTool.input.parse({ operation: 'clear-cache' }),
      createToolContext(),
    );
    expect(result.cleared).toBe(true);
    expect(result.cacheSize).toBe(0);
  });
});

describe('mailchimpAssetsTool — format()', () => {
  it('list result with empty assets prompts to drop files in', () => {
    const out = formatTool({
      operation: 'list',
      assetsDir: '/tmp/a',
      assets: [],
      cacheSize: 0,
    });
    const text = out[0]?.type === 'text' ? out[0].text : '';
    expect(text).toContain('Drop image or document');
  });

  it('info result without cache shows "Not yet uploaded"', () => {
    const out = formatTool({
      operation: 'info',
      assetsDir: '/tmp/a',
      asset: {
        relPath: 'hero.png',
        sizeInBytes: 4,
        ext: '.png',
        isImage: true,
        sha256: 'abc',
      },
    });
    const text = out[0]?.type === 'text' ? out[0].text : '';
    expect(text).toContain('Not yet uploaded');
  });

  it('info result with cache shows fullSizeUrl', () => {
    const out = formatTool({
      operation: 'info',
      assetsDir: '/tmp/a',
      asset: {
        relPath: 'hero.png',
        sizeInBytes: 4,
        ext: '.png',
        isImage: true,
        sha256: 'abc',
        cached: {
          fileId: 999,
          fullSizeUrl: 'https://cdn/x.png',
          uploadedAt: '2026-04-24T00:00:00Z',
        },
      },
    });
    const text = out[0]?.type === 'text' ? out[0].text : '';
    expect(text).toContain('Cached upload');
    expect(text).toContain('https://cdn/x.png');
  });
});
