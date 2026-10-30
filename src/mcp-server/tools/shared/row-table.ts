/**
 * @fileoverview Markdown rendering for list rows whose keys vary from row to
 * row (report slices, subscriber activity/events/goals, audience daily
 * activity). Every key of every row reaches the output: as a hoisted line
 * above the table, as a table cell, or as a labelled paragraph below it.
 * @module mcp-server/tools/shared/row-table
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

type Row = Record<string, unknown>;

const hasLineBreak = (value: unknown): value is string =>
  typeof value === 'string' && /[\r\n]/.test(value);

/** Inline text for a single-line value: absent → empty, nested values as their JSON. */
function cellText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return escapeMarkdownInline(value);
  if (value === null || typeof value !== 'object') return String(value);
  return escapeMarkdownInline(JSON.stringify(value));
}

/**
 * Renders rows as a GFM table and returns the lines to append. Columns are the
 * `leading` keys some row carries, then every other key in first-seen order.
 * With two or more rows, a single-line scalar present with the same value on
 * every row renders once above the table as `- **key:** value` instead of as a
 * column. A string holding a line break cannot sit in a table row: its cell
 * reads `(below)` and the full value follows the table as `**Row N · key:**`.
 * Zero rows render nothing.
 */
export function renderRowTable(rows: readonly Row[], leading: readonly string[]): string[] {
  const [first] = rows;
  if (!first) return [];
  const keys = [
    ...new Set([
      ...leading.filter((key) => rows.some((row) => key in row)),
      ...rows.flatMap((row) => Object.keys(row)),
    ]),
  ];
  const isHoisted = (key: string): boolean => {
    const value = first[key];
    return (
      rows.length > 1 &&
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') &&
      !hasLineBreak(value) &&
      rows.every((row) => key in row && row[key] === value)
    );
  };
  const hoisted = keys.filter(isHoisted);
  const columns = keys.filter((key) => !hoisted.includes(key));

  const lines = hoisted.map((key) => `- **${escapeMarkdownInline(key)}:** ${cellText(first[key])}`);
  if (columns.length === 0) return lines;
  if (lines.length > 0) lines.push('');

  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const below: string[] = [];
  lines.push(line(columns.map(escapeMarkdownInline)), line(columns.map(() => '---')));
  rows.forEach((row, index) => {
    const cells = columns.map((key) => {
      const value = row[key];
      if (!hasLineBreak(value)) return cellText(value);
      below.push(
        '',
        `**Row ${index + 1} · ${escapeMarkdownInline(key)}:** ${escapeMarkdownInline(value)}`,
      );
      return '(below)';
    });
    lines.push(line(cells));
  });
  return [...lines, ...below];
}
