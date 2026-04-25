/**
 * @fileoverview Tests for the AssetService — discovery, hashing, cache hit/miss,
 * upload-via-mocked-fetch, path-traversal guard, concurrency dedup, and HTML
 * rewrite end-to-end. Uses real tmp-dir fixtures so I/O paths are exercised.
 * @module tests/services/assets/asset-service.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { AssetCache } from '@/services/assets/asset-cache.js';
import { AssetService } from '@/services/assets/asset-service.js';
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

function fakeUploadResponse(id: number, name: string): Response {
  return new Response(
    JSON.stringify({
      id,
      folder_id: 0,
      type: 'image',
      name,
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

async function setupTmpAssets(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mailchimp-assets-'));
  await writeFile(join(dir, 'hero.png'), Buffer.from('AAAA'), 'binary');
  await writeFile(join(dir, 'icon.png'), Buffer.from('BBBB'), 'binary');
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('AssetService — list & info', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setupTmpAssets());
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(async () => {
    await cleanup();
    setMailchimpServiceForTesting(undefined);
  });

  it('list returns one entry per file, sorted', async () => {
    const cache = new AssetCache(dir);
    await cache.load();
    const svc = new AssetService(dir, cache, 4);
    const entries = await svc.list();
    expect(entries.map((e) => e.relPath)).toEqual(['hero.png', 'icon.png']);
    expect(entries[0]?.size).toBe(4);
    expect(entries[0]?.isImage).toBe(true);
  });

  it('list excludes the .mailchimp-cache.json file', async () => {
    const cache = new AssetCache(dir);
    await cache.load();
    await cache.save();
    const svc = new AssetService(dir, cache, 4);
    const entries = await svc.list();
    expect(entries.some((e) => e.relPath.startsWith('.mailchimp-cache'))).toBe(false);
  });

  it('info returns sha256 and cached: undefined when never uploaded', async () => {
    const cache = new AssetCache(dir);
    await cache.load();
    const svc = new AssetService(dir, cache, 4);
    const info = await svc.info('hero.png');
    expect(info.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(info.cached).toBeUndefined();
  });

  it('info throws notFound for a missing file', async () => {
    const cache = new AssetCache(dir);
    await cache.load();
    const svc = new AssetService(dir, cache, 4);
    await expect(svc.info('missing.png')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});

describe('AssetService — path-traversal guard', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setupTmpAssets());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('rejects ../ traversal', async () => {
    const cache = new AssetCache(dir);
    const svc = new AssetService(dir, cache, 4);
    expect(() => svc.resolveRelative('../escape.png')).toThrow(/escapes/);
  });

  it('rejects absolute paths', async () => {
    const cache = new AssetCache(dir);
    const svc = new AssetService(dir, cache, 4);
    expect(() => svc.resolveRelative('/etc/passwd')).toThrow(/Invalid asset path/);
  });

  it('rejects null bytes', async () => {
    const cache = new AssetCache(dir);
    const svc = new AssetService(dir, cache, 4);
    expect(() => svc.resolveRelative('foo\0bar')).toThrow(/Invalid asset path/);
  });

  it('accepts a clean relative path', async () => {
    const cache = new AssetCache(dir);
    const svc = new AssetService(dir, cache, 4);
    expect(svc.resolveRelative('hero.png')).toContain('hero.png');
  });

  it('accepts nested subdirectory paths', async () => {
    const cache = new AssetCache(dir);
    const svc = new AssetService(dir, cache, 4);
    const resolved = svc.resolveRelative('brand/logo.png');
    expect(resolved).toContain('brand');
    expect(resolved).toContain('logo.png');
  });
});

describe('AssetService — ensureUploaded + cache', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setupTmpAssets());
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(async () => {
    await cleanup();
    setMailchimpServiceForTesting(undefined);
    vi.unstubAllGlobals();
  });

  it('uploads on first call and caches the result', async () => {
    const fetchStub = vi.fn(async () => fakeUploadResponse(101, 'hero.png'));
    vi.stubGlobal('fetch', fetchStub);

    const cache = new AssetCache(dir);
    await cache.load();
    const svc = new AssetService(dir, cache, 4);
    const uploaded = await svc.ensureUploaded(createMockContext(), 'hero.png');
    expect(uploaded.fileId).toBe(101);
    expect(uploaded.fullSizeUrl).toBe('https://mcusercontent.com/test/images/101.png');
    expect(fetchStub).toHaveBeenCalledOnce();

    const reloaded = new AssetCache(dir);
    await reloaded.load();
    expect(reloaded.size()).toBe(1);
  });

  it('returns cache hit without re-uploading on second call', async () => {
    const fetchStub = vi.fn(async () => fakeUploadResponse(101, 'hero.png'));
    vi.stubGlobal('fetch', fetchStub);

    const cache = new AssetCache(dir);
    await cache.load();
    const svc = new AssetService(dir, cache, 4);
    await svc.ensureUploaded(createMockContext(), 'hero.png');
    await svc.ensureUploaded(createMockContext(), 'hero.png');
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('dedupes concurrent uploads of the same file', async () => {
    const fetchStub = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return fakeUploadResponse(101, 'hero.png');
    });
    vi.stubGlobal('fetch', fetchStub);

    const cache = new AssetCache(dir);
    await cache.load();
    const svc = new AssetService(dir, cache, 4);
    const ctx = createMockContext();
    const [a, b, c] = await Promise.all([
      svc.ensureUploaded(ctx, 'hero.png'),
      svc.ensureUploaded(ctx, 'hero.png'),
      svc.ensureUploaded(ctx, 'hero.png'),
    ]);
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(a.fileId).toBe(101);
    expect(b.fileId).toBe(101);
    expect(c.fileId).toBe(101);
  });

  it('rejects oversized images client-side without uploading', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024); // 2 MB > 1 MB cap
    await writeFile(join(dir, 'big.png'), big);
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    const cache = new AssetCache(dir);
    await cache.load();
    const svc = new AssetService(dir, cache, 4);
    await expect(svc.ensureUploaded(createMockContext(), 'big.png')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('1 MB cap'),
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('AssetService — rewriteHtml integration', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await setupTmpAssets());
    setMailchimpServiceForTesting(new MailchimpService(BASE_CONFIG));
  });

  afterEach(async () => {
    await cleanup();
    setMailchimpServiceForTesting(undefined);
    vi.unstubAllGlobals();
  });

  it('returns html unchanged when no @assets/ references', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const cache = new AssetCache(dir);
    const svc = new AssetService(dir, cache, 4);
    const html = '<p>plain</p>';
    expect(await svc.rewriteHtml(createMockContext(), html)).toBe(html);
  });

  it('uploads referenced files and rewrites URLs', async () => {
    let counter = 100;
    const fetchStub = vi.fn(async () => fakeUploadResponse(++counter, 'asset.png'));
    vi.stubGlobal('fetch', fetchStub);

    const cache = new AssetCache(dir);
    await cache.load();
    const svc = new AssetService(dir, cache, 4);
    const html = '<img src="@assets/hero.png"><img src="@assets/icon.png">';
    const out = await svc.rewriteHtml(createMockContext(), html);

    expect(out).toContain('https://mcusercontent.com/test/images/');
    expect(out).not.toContain('@assets/hero.png');
    expect(out).not.toContain('@assets/icon.png');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('leaves missing-asset references in place when upload fails', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const cache = new AssetCache(dir);
    const svc = new AssetService(dir, cache, 4);
    const html = '<img src="@assets/missing.png">';
    const out = await svc.rewriteHtml(createMockContext(), html);
    expect(out).toBe(html);
  });
});
