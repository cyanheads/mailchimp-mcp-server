/**
 * @fileoverview Content-hash-keyed cache mapping local asset SHA-256 → uploaded
 * Mailchimp file metadata. Lives at `<assetsDir>/.mailchimp-cache.json`. Keys
 * are content hashes, so a content change produces a new key — there is no
 * invalidation logic. Writes are atomic (temp file + rename). The cache is a
 * pure performance optimization; deleting the file is always safe and forces
 * re-upload on next reference.
 * @module services/assets/asset-cache
 */

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_FILE = '.mailchimp-cache.json';
const CACHE_VERSION = 1;

export interface CachedUpload {
  fileId: number;
  fullSizeUrl: string;
  sourceRelPath: string;
  thumbnailUrl?: string;
  uploadedAt: string;
}

interface CacheFileV1 {
  entries: Record<string, CachedUpload>;
  version: 1;
}

export class AssetCache {
  private readonly path: string;
  private entries: Record<string, CachedUpload> = {};
  private loaded = false;

  constructor(assetsDir: string) {
    this.path = join(assetsDir, CACHE_FILE);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as CacheFileV1;
      if (parsed.version === CACHE_VERSION && parsed.entries) {
        this.entries = parsed.entries;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.loaded = true;
  }

  get(hash: string): CachedUpload | undefined {
    return this.entries[hash];
  }

  set(hash: string, upload: CachedUpload): void {
    this.entries[hash] = upload;
  }

  async save(): Promise<void> {
    /**
     * Use a unique tmp filename per call so concurrent saves (which can happen
     * when multiple assets upload in parallel) don't race on the same path.
     * The final rename is still last-writer-wins, but both writers produce the
     * same content (entries is a live reference shared by all in-flight saves)
     * so divergence is impossible.
     */
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const data: CacheFileV1 = { version: CACHE_VERSION, entries: this.entries };
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmpPath, this.path);
  }

  async clear(): Promise<void> {
    this.entries = {};
    await this.save();
  }

  size(): number {
    return Object.keys(this.entries).length;
  }
}

/** Compute SHA-256 of a buffer as a lowercase hex string. */
export function hashBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}
