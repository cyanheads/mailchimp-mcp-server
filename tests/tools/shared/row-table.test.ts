/**
 * @fileoverview Tests for the shared row-table renderer: column order, hoisting
 * of values shared by every row, cell stringification, GFM round-trip of
 * Markdown-active characters, below-table rendering of multi-line strings, and
 * the zero-row case.
 * @module tests/tools/shared/row-table.test
 */

import { describe, expect, it } from 'vitest';
import { renderRowTable } from '@/mcp-server/tools/shared/row-table.js';

/**
 * Minimal GFM table reader: the first `|`-led line followed by a `---`
 * delimiter row, through the next line that is not a row. Cells split on pipes
 * no backslash escapes, then CommonMark backslash escapes and numeric character
 * references decode. Throws when a row's cell count differs from the header's —
 * the shape a raw `|` inside a cell produces.
 */
function parseTable(markdown: string): { header: string[]; rows: string[][] } {
  const lines = markdown.split('\n');
  const start = lines.findIndex(
    (line, i) => line.startsWith('|') && /^\|( --- \|)+$/.test(lines[i + 1] ?? ''),
  );
  if (start === -1) throw new Error('no GFM table found');
  const splitRow = (line: string): string[] =>
    line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) =>
        cell
          .trim()
          .replace(
            /\\([!-/:-@[-`{-~])|&#(\d+);|&#[xX]([0-9a-fA-F]+);/g,
            (_, punct?: string, dec?: string, hex?: string) =>
              punct ?? String.fromCodePoint(dec ? Number(dec) : Number.parseInt(hex ?? '', 16)),
          ),
      );
  const header = splitRow(lines[start] ?? '');
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const row = splitRow(line);
    if (row.length !== header.length)
      throw new Error(`row has ${row.length} cells, header has ${header.length}`);
    rows.push(row);
  }
  return { header, rows };
}

describe('parseTable (test helper)', () => {
  it('rejects a row a raw pipe splits', () => {
    expect(() => parseTable('| a | b |\n| --- | --- |\n| x|y | z |')).toThrow(/3 cells/);
  });

  it('reads escaped pipes and backticks back literally', () => {
    expect(parseTable('| a |\n| --- |\n| x\\|y \\`z\\` |').rows).toEqual([['x|y `z`']]);
  });
});

describe('renderRowTable', () => {
  it('renders no lines for zero rows', () => {
    expect(renderRowTable([], ['a'])).toEqual([]);
  });

  it.each([
    {
      name: 'leading keys first, then the rest in first-seen order',
      rows: [
        { z: 1, b: 2, a: 3 },
        { c: 4, a: 5 },
      ],
      leading: ['a', 'missing', 'b'],
      header: '| a | b | z | c |',
    },
    {
      name: 'no leading keys: first-seen order across rows',
      rows: [{ y: 1 }, { x: 2, y: 3 }],
      leading: [],
      header: '| y | x |',
    },
  ])('column order — $name', ({ rows, leading, header }) => {
    expect(renderRowTable(rows, leading)[0]).toBe(header);
  });

  it('renders the full table with a `| --- |` delimiter row and no row-number column', () => {
    expect(
      renderRowTable(
        [
          { day: '2026-10-29', subs: 3 },
          { day: '2026-10-28', subs: 2 },
        ],
        ['day'],
      ),
    ).toEqual(['| day | subs |', '| --- | --- |', '| 2026-10-29 | 3 |', '| 2026-10-28 | 2 |']);
  });

  it.each([
    {
      name: 'absent → empty cell',
      row: { a: 'x', b: undefined },
      cells: '| x |  |',
    },
    { name: 'null → null', row: { a: 'x', b: null }, cells: '| x | null |' },
    { name: 'number → digits', row: { a: 'x', b: -1.5 }, cells: '| x | -1.5 |' },
    { name: 'boolean → literal', row: { a: 'x', b: false }, cells: '| x | false |' },
    {
      name: 'object → escaped JSON',
      row: { a: 'x', b: { k: ['v'] } },
      cells: '| x | {"k":\\["v"\\]} |',
    },
    { name: 'string → escaped text', row: { a: 'x', b: '*em*' }, cells: '| x | \\*em\\* |' },
  ])('cell — $name', ({ row, cells }) => {
    expect(renderRowTable([row], [])[2]).toBe(cells);
  });

  it('an absent key in one row renders an empty cell in that row only', () => {
    expect(renderRowTable([{ a: 1, b: 2 }, { a: 3 }], [])).toEqual([
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '| 3 |  |',
    ]);
  });

  it('hoists a scalar identical and present on every row above the table, in column order', () => {
    expect(
      renderRowTable(
        [
          { id: 'r1', campaignId: 'c1', rate: 0.1, ok: true },
          { id: 'r2', campaignId: 'c1', rate: 0.1, ok: true },
        ],
        ['id', 'rate'],
      ),
    ).toEqual([
      '- **rate:** 0.1',
      '- **campaignId:** c1',
      '- **ok:** true',
      '',
      '| id |',
      '| --- |',
      '| r1 |',
      '| r2 |',
    ]);
  });

  it.each([
    { name: 'one row', rows: [{ a: 'same' }] },
    { name: 'a value differs', rows: [{ a: 'x' }, { a: 'y' }] },
    { name: 'absent on one row', rows: [{ a: 'x' }, { b: 1 }] },
    { name: 'null on every row', rows: [{ a: null }, { a: null }] },
    { name: 'equal objects', rows: [{ a: { k: 1 } }, { a: { k: 1 } }] },
  ])('does not hoist — $name', ({ rows }) => {
    expect(renderRowTable(rows, [])[0]).toMatch(/^\| /);
  });

  it('renders only the hoisted lines when every key is shared', () => {
    expect(renderRowTable([{ a: 1 }, { a: 1 }], [])).toEqual(['- **a:** 1']);
  });

  it('round-trips `|` and backticks in cells, headers, and JSON under a GFM parse', () => {
    const rows = [
      { 'k|ey': 'a|b `c`', obj: { sku: 'A|B' } },
      { 'k|ey': '``x``', obj: ['|'] },
    ];
    const table = parseTable(renderRowTable(rows, []).join('\n'));
    expect(table.header).toEqual(['k|ey', 'obj']);
    expect(table.rows).toEqual([
      ['a|b `c`', '{"sku":"A|B"}'],
      ['``x``', '["|"]'],
    ]);
  });

  it('moves a multi-line string below the table, keeping every line escaped', () => {
    expect(
      renderRowTable(
        [
          { id: 'r1', memo: 'one line' },
          { id: 'r2', memo: 'line one\n- line two\r\n# three' },
        ],
        ['id'],
      ),
    ).toEqual([
      '| id | memo |',
      '| --- | --- |',
      '| r1 | one line |',
      '| r2 | (below) |',
      '',
      '**Row 2 · memo:** line one\\\n\\- line two\\\n\\# three',
    ]);
  });

  it('keeps a multi-line value shared by every row below the table, once per row', () => {
    const lines = renderRowTable(
      [
        { id: 'r1', memo: 'a\nb' },
        { id: 'r2', memo: 'a\nb' },
      ],
      [],
    );
    expect(lines).toEqual([
      '| id | memo |',
      '| --- | --- |',
      '| r1 | (below) |',
      '| r2 | (below) |',
      '',
      '**Row 1 · memo:** a\\\nb',
      '',
      '**Row 2 · memo:** a\\\nb',
    ]);
  });

  it('a multi-line value in a row keeps the row parseable', () => {
    const table = parseTable(renderRowTable([{ a: 'x|y', b: 'first\nsecond' }], []).join('\n'));
    expect(table.rows).toEqual([['x|y', '(below)']]);
  });
});
