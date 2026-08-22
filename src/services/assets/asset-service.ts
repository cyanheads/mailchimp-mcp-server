/**
 * @fileoverview Local-asset orchestrator. Walks `MAILCHIMP_ASSETS_DIR`, hashes
 * referenced files, uploads cache misses to Mailchimp File Manager via the
 * `mailchimp` service, and rewrites `@assets/<path>` references in campaign HTML
 * to public Mailchimp CDN URLs. Singleton init/accessor pattern matching
 * MailchimpService — initialized in `setup()` only when `assetsDir` is set and
 * the runtime has filesystem access.
 * @module services/assets/asset-service
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { Context } from '@cyanheads/mcp-ts-core';
import { forbidden, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { logger as globalLogger, type Logger } from '@cyanheads/mcp-ts-core/utils';
import { AssetCache, type CachedUpload, hashBuffer } from '@/services/assets/asset-cache.js';
import { rewriteHtml, scanAssetReferences } from '@/services/assets/rewrite.js';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

/** Mailchimp's image cap (1 MB); larger images return a 4xx upstream. */
export const MAX_IMAGE_BYTES = 1_048_576;
/** Mailchimp's non-image cap (10 MB). */
export const MAX_FILE_BYTES = 10_485_760;

const IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.jpe',
  '.png',
  '.gif',
  '.svg',
  '.bmp',
  '.tif',
  '.tiff',
  '.psd',
  '.ai',
  '.eps',
  '.indd',
]);

export interface AssetEntry {
  /** Absolute filesystem path. */
  absPath: string;
  /** Lowercase extension including leading dot (e.g. `.png`). */
  ext: string;
  /** Best-effort image classification by extension. */
  isImage: boolean;
  /** Path relative to assetsDir, forward-slash separated for cross-platform consistency. */
  relPath: string;
  /** File size in bytes. */
  size: number;
}

export interface AssetEntryWithCache extends AssetEntry {
  /** Cache hit, if any. */
  cached?: CachedUpload;
  /** SHA-256 hex of the file contents. */
  sha256: string;
}

export class AssetService {
  private readonly inFlight = new Map<string, Promise<CachedUpload>>();

  constructor(
    private readonly assetsDir: string,
    private readonly cache: AssetCache,
    private readonly concurrencyLimit: number,
  ) {}

  get directory(): string {
    return this.assetsDir;
  }

  /** Resolve a relative path under assetsDir, throwing on traversal. */
  resolveRelative(relPath: string): string {
    if (!relPath || relPath.startsWith('/') || relPath.includes('\0')) {
      throw validationError(`Invalid asset path: '${relPath}'.`);
    }
    const abs = resolve(this.assetsDir, relPath);
    const dirWithSep = this.assetsDir.endsWith(sep) ? this.assetsDir : `${this.assetsDir}${sep}`;
    if (abs !== this.assetsDir && !abs.startsWith(dirWithSep)) {
      throw forbidden(`Asset path escapes MAILCHIMP_ASSETS_DIR: '${relPath}'.`);
    }
    return abs;
  }

  /** Walk the assets directory and return one entry per file. The cache file is skipped because `walk` excludes dotfiles. */
  async list(): Promise<AssetEntry[]> {
    const out: AssetEntry[] = [];
    await walk(this.assetsDir, this.assetsDir, out);
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  /**
   * Read the file at `relPath`, hash it, and look up its cache entry. Shared
   * by `info()` and `ensureUploaded()` so the file is read+hashed only once
   * per upload pipeline pass.
   */
  private async _readWithHash(
    relPath: string,
  ): Promise<{ info: AssetEntryWithCache; buffer: Buffer }> {
    const absPath = this.resolveRelative(relPath);
    const st = await stat(absPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        throw notFound(`Asset not found at '${relPath}' under MAILCHIMP_ASSETS_DIR.`);
      }
      throw err;
    });
    if (!st.isFile()) throw validationError(`Asset path is not a regular file: '${relPath}'.`);
    const ext = extname(relPath).toLowerCase();
    const buffer = await readFile(absPath);
    const sha256 = hashBuffer(buffer);
    await this.cache.load();
    const cached = this.cache.get(sha256);
    return {
      info: {
        relPath,
        absPath,
        size: st.size,
        ext,
        isImage: IMAGE_EXTS.has(ext),
        sha256,
        ...(cached ? { cached } : {}),
      },
      buffer,
    };
  }

  /** Get one asset's metadata + hash + cache status. Throws if the file does not exist. */
  async info(relPath: string): Promise<AssetEntryWithCache> {
    return (await this._readWithHash(relPath)).info;
  }

  /**
   * Ensure the file at `relPath` is uploaded to Mailchimp and return its cached
   * upload metadata. Concurrent calls with the same hash de-dupe to a single
   * upload. Validates client-side size cap before round-tripping.
   */
  async ensureUploaded(
    ctx: Pick<Context, 'signal' | 'log'>,
    relPath: string,
  ): Promise<CachedUpload> {
    const { info, buffer } = await this._readWithHash(relPath);
    if (info.cached) return info.cached;

    const inFlight = this.inFlight.get(info.sha256);
    if (inFlight) return inFlight;

    if (info.isImage && info.size > MAX_IMAGE_BYTES) {
      throw validationError(
        `Asset '${relPath}' is ${info.size} bytes — exceeds Mailchimp's 1 MB cap for images.`,
      );
    }
    if (!info.isImage && info.size > MAX_FILE_BYTES) {
      throw validationError(
        `Asset '${relPath}' is ${info.size} bytes — exceeds Mailchimp's 10 MB cap for non-image files.`,
      );
    }

    const promise = this.doUpload(ctx, info, buffer);
    this.inFlight.set(info.sha256, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(info.sha256);
    }
  }

  private async doUpload(
    ctx: Pick<Context, 'signal' | 'log'>,
    info: AssetEntryWithCache,
    buffer: Buffer,
  ): Promise<CachedUpload> {
    const svc = getMailchimpService();
    const fileName = info.relPath.split('/').pop() ?? info.relPath;
    const uploaded = await svc.files.upload(ctx, {
      name: fileName,
      fileDataBase64: buffer.toString('base64'),
    });
    const cached: CachedUpload = {
      fileId: uploaded.id,
      fullSizeUrl: uploaded.full_size_url,
      ...(uploaded.thumbnail_url ? { thumbnailUrl: uploaded.thumbnail_url } : {}),
      uploadedAt: new Date().toISOString(),
      sourceRelPath: info.relPath,
    };
    this.cache.set(info.sha256, cached);
    await this.cache.save();
    ctx.log.info('asset uploaded to Mailchimp', {
      relPath: info.relPath,
      fileId: cached.fileId,
      bytes: info.size,
    });
    return cached;
  }

  /**
   * Pre-warm the cache: walk the directory, upload everything not already
   * cached. Returns counts.
   */
  async sync(ctx: Pick<Context, 'signal' | 'log'>): Promise<{
    uploaded: number;
    cached: number;
    skipped: Array<{ relPath: string; reason: string }>;
  }> {
    const entries = await this.list();
    let uploaded = 0;
    let cached = 0;
    const skipped: Array<{ relPath: string; reason: string }> = [];

    const queue = [...entries];
    const work = async (): Promise<void> => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) break;
        try {
          const info = await this.info(entry.relPath);
          if (info.cached) {
            cached++;
            continue;
          }
          await this.ensureUploaded(ctx, entry.relPath);
          uploaded++;
        } catch (err) {
          skipped.push({
            relPath: entry.relPath,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(this.concurrencyLimit, entries.length || 1) },
      () => work(),
    );
    await Promise.all(workers);
    return { uploaded, cached, skipped };
  }

  /**
   * Rewrite every `@assets/<path>` reference in `html` to a Mailchimp CDN URL,
   * uploading any uncached files first. Unresolvable references (file missing
   * or upload failed) are logged as warnings and left in place — Mailchimp will
   * later 404 them, surfacing the problem.
   */
  async rewriteHtml(ctx: Pick<Context, 'signal' | 'log'>, html: string): Promise<string> {
    const refs = scanAssetReferences(html);
    if (refs.length === 0) return html;

    const urlMap = new Map<string, string>();
    const queue = [...refs];
    const work = async (): Promise<void> => {
      while (queue.length > 0) {
        const ref = queue.shift();
        if (!ref) break;
        try {
          const cached = await this.ensureUploaded(ctx, ref);
          urlMap.set(ref, cached.fullSizeUrl);
        } catch (err) {
          ctx.log.warning('failed to resolve @assets reference', {
            relPath: ref,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    const workers = Array.from({ length: Math.min(this.concurrencyLimit, refs.length) }, () =>
      work(),
    );
    await Promise.all(workers);

    return rewriteHtml(html, urlMap);
  }

  async clearCache(): Promise<void> {
    await this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size();
  }
}

async function walk(root: string, current: string, out: AssetEntry[]): Promise<void> {
  const dirents = await readdir(current, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    const abs = join(current, dirent.name);
    if (dirent.isDirectory()) {
      await walk(root, abs, out);
    } else if (dirent.isFile()) {
      const rel = relative(root, abs).split(sep).join('/');
      const st = await stat(abs);
      const ext = extname(rel).toLowerCase();
      out.push({
        relPath: rel,
        absPath: abs,
        size: st.size,
        ext,
        isImage: IMAGE_EXTS.has(ext),
      });
    }
  }
}

// ─── Init / accessor ─────────────────────────────────────────────────

let _service: AssetService | undefined;

export async function initAssetService(
  assetsDir: string,
  concurrencyLimit: number,
  log: Logger = globalLogger,
): Promise<void> {
  const cache = new AssetCache(assetsDir);
  await cache.load();
  _service = new AssetService(assetsDir, cache, concurrencyLimit);
  log.info(`AssetService initialized: ${assetsDir} (${cache.size()} cached uploads)`);
}

export function getAssetService(): AssetService | undefined {
  return _service;
}

/** Test-only: inject a pre-built service. */
export function setAssetServiceForTesting(service: AssetService | undefined): void {
  _service = service;
}
