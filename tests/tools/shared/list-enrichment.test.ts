/**
 * @fileoverview Tests for the shared list-read enrichment declaration: the
 * `filters` / `notice` schemas and the `filters` trailer renderer, whose code
 * spans must read back each value literally whatever backticks or line breaks
 * it holds.
 * @module tests/tools/shared/list-enrichment.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  listEnrichment,
  listEnrichmentTrailer,
  pageEndNotice,
} from '@/mcp-server/tools/shared/list-enrichment.js';

const render = listEnrichmentTrailer.filters.render;
const schema = z.object(listEnrichment);

describe('listEnrichment schema', () => {
  it('accepts a flat record of string, number, and boolean values', () => {
    const filters = { count: 10, offset: 0, status: 'sent', includeCleaned: false };
    expect(schema.parse({ filters })).toEqual({ filters });
  });

  it('leaves both fields optional', () => {
    expect(schema.parse({})).toEqual({});
  });

  it('rejects nested, array, and null filter values', () => {
    expect(() => schema.parse({ filters: { a: { b: 1 } } })).toThrow();
    expect(() => schema.parse({ filters: { a: ['x'] } })).toThrow();
    expect(() => schema.parse({ filters: { a: null } })).toThrow();
  });

  it('requires notice to be a string', () => {
    expect(() => schema.parse({ notice: 3 })).toThrow();
  });
});

describe('listEnrichmentTrailer.filters.render', () => {
  it('renders one Markdown line of key + code-span pairs in insertion order', () => {
    expect(render({ count: 10, offset: 0, status: 'sent', includeCleaned: true })).toBe(
      '**Filters:** count `10` · offset `0` · status `sent` · includeCleaned `true`',
    );
  });

  it('keeps Markdown-active characters literal inside the span', () => {
    expect(render({ q: '*a* [x](y) _b_' })).toBe('**Filters:** q `*a* [x](y) _b_`');
  });

  it('widens the fence past any backtick run in the value', () => {
    expect(render({ q: 'a`b' })).toBe('**Filters:** q ``a`b``');
    expect(render({ q: 'a``b' })).toBe('**Filters:** q ```a``b```');
  });

  it('pads a value that starts or ends with a backtick so the fence stays closed', () => {
    expect(render({ q: '`x' })).toBe('**Filters:** q `` `x ``');
    expect(render({ q: 'x`' })).toBe('**Filters:** q `` x` ``');
  });

  it('pads an empty string so it renders as an empty span, not two backticks', () => {
    expect(render({ q: '' })).toBe('**Filters:** q `  `');
  });

  it('renders a value holding a line break as its JSON form on one line', () => {
    const line = render({ q: 'a\nb', r: 'c\r\nd' });
    expect(line).toBe('**Filters:** q `"a\\nb"` · r `"c\\r\\nd"`');
    expect(line).not.toMatch(/[\r\n]/);
  });

  it('renders an empty or absent record as the bare label', () => {
    expect(render({})).toBe('**Filters:** ');
    expect(render(undefined)).toBe('**Filters:** ');
  });
});

describe('pageEndNotice', () => {
  const pastEnd =
    'No files on this page: `offset` is at or past `totalItems`. Lower `offset` to page back into the results.';

  it('names the noun and the offset-past-end step when offset reaches a nonzero total', () => {
    expect(pageEndNotice('files', 10, 10, 'empty')).toBe(pastEnd);
    expect(pageEndNotice('files', 25, 10, 'empty')).toBe(pastEnd);
  });

  it('returns the empty text when offset is within the total, the total is zero, or unknown', () => {
    expect(pageEndNotice('files', 9, 10, 'empty')).toBe('empty');
    expect(pageEndNotice('files', 0, 0, 'empty')).toBe('empty');
    expect(pageEndNotice('files', 5, undefined, 'empty')).toBe('empty');
  });
});
