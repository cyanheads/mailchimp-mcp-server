/**
 * @fileoverview Tests for the pure HTML scan + URL rewrite functions.
 * Covers attribute matches (`src`/`href`/`background`), CSS `url(...)`,
 * single/double/unquoted forms, deduplication, and pass-through of
 * unmapped references.
 * @module tests/services/assets/rewrite.test
 */

import { describe, expect, it } from 'vitest';
import { rewriteHtml, scanAssetReferences } from '@/services/assets/rewrite.js';

describe('scanAssetReferences', () => {
  it('returns an empty array when no @assets/ references exist', () => {
    expect(scanAssetReferences('<p>hello</p>')).toEqual([]);
  });

  it('finds src attributes in double quotes', () => {
    expect(scanAssetReferences('<img src="@assets/hero.png">')).toEqual(['hero.png']);
  });

  it('finds src attributes in single quotes', () => {
    expect(scanAssetReferences("<img src='@assets/hero.png'>")).toEqual(['hero.png']);
  });

  it('finds href and background attributes', () => {
    const html = '<a href="@assets/doc.pdf"><div background="@assets/bg.png"></div></a>';
    expect(scanAssetReferences(html).sort()).toEqual(['bg.png', 'doc.pdf']);
  });

  it('finds CSS url() with quotes', () => {
    const html = `<style>.h { background: url("@assets/style/hero.png"); }</style>`;
    expect(scanAssetReferences(html)).toEqual(['style/hero.png']);
  });

  it('deduplicates identical references', () => {
    const html = '<img src="@assets/logo.png"><img src="@assets/logo.png">';
    expect(scanAssetReferences(html)).toEqual(['logo.png']);
  });

  it('handles nested paths with subdirectories', () => {
    const html = '<img src="@assets/brand/logo/full.png">';
    expect(scanAssetReferences(html)).toEqual(['brand/logo/full.png']);
  });

  it('does not match arbitrary @ strings', () => {
    expect(scanAssetReferences('<p>@assetsnope/x</p>')).toEqual([]);
    expect(scanAssetReferences('<p>email@assets/x</p>')).toEqual([]);
  });
});

describe('rewriteHtml', () => {
  it('returns input unchanged when urlMap is empty', () => {
    const html = '<img src="@assets/hero.png">';
    expect(rewriteHtml(html, new Map())).toBe(html);
  });

  it('replaces a double-quoted src reference', () => {
    const out = rewriteHtml(
      '<img src="@assets/hero.png" alt="x">',
      new Map([['hero.png', 'https://cdn/hero.png']]),
    );
    expect(out).toBe('<img src="https://cdn/hero.png" alt="x">');
  });

  it('replaces a single-quoted src reference', () => {
    const out = rewriteHtml(
      "<img src='@assets/hero.png'>",
      new Map([['hero.png', 'https://cdn/hero.png']]),
    );
    expect(out).toBe("<img src='https://cdn/hero.png'>");
  });

  it('replaces references in CSS url() with quotes', () => {
    const out = rewriteHtml(
      `<style>.h { background: url("@assets/hero.png"); }</style>`,
      new Map([['hero.png', 'https://cdn/hero.png']]),
    );
    expect(out).toContain('url("https://cdn/hero.png")');
  });

  it('replaces multiple references', () => {
    const out = rewriteHtml(
      '<img src="@assets/a.png"><a href="@assets/b.pdf">',
      new Map([
        ['a.png', 'https://cdn/a.png'],
        ['b.pdf', 'https://cdn/b.pdf'],
      ]),
    );
    expect(out).toBe('<img src="https://cdn/a.png"><a href="https://cdn/b.pdf">');
  });

  it('leaves unmapped references in place', () => {
    const out = rewriteHtml(
      '<img src="@assets/known.png"><img src="@assets/missing.png">',
      new Map([['known.png', 'https://cdn/known.png']]),
    );
    expect(out).toContain('src="https://cdn/known.png"');
    expect(out).toContain('src="@assets/missing.png"');
  });

  it('preserves quoting style (single vs double)', () => {
    const out = rewriteHtml(
      `<img src='@assets/x.png'><img src="@assets/x.png">`,
      new Map([['x.png', 'https://cdn/x.png']]),
    );
    expect(out).toBe(`<img src='https://cdn/x.png'><img src="https://cdn/x.png">`);
  });
});
