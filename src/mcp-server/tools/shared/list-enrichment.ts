/**
 * @fileoverview Shared `enrichment` declaration for list reads: `filters`
 * echoes the query parameters a call actually sent upstream (defaults and
 * normalization applied), and `notice` carries the next step when the
 * returned list is empty. Spread into every tool with a list-style operation
 * so the field names, descriptions, and trailer rendering stay uniform.
 * @module mcp-server/tools/shared/list-enrichment
 */

import { z } from '@cyanheads/mcp-ts-core';

/** One query parameter value as sent upstream. */
export type FilterValue = string | number | boolean;

/** Query parameters sent upstream, keyed by the tool's input name. */
export type AppliedFilters = Record<string, FilterValue>;

/** Spread into a tool definition's `enrichment` block. */
export const listEnrichment = {
  filters: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Query parameters this call sent upstream, keyed by input name, with defaults and normalization applied. Absent when the operation sends none.',
    ),
  notice: z
    .string()
    .optional()
    .describe('Next step when the returned list is empty. Absent on non-empty results.'),
};

/**
 * Code span wide enough for any backtick run inside the value. A string with a
 * line break renders as its JSON form, since a code span folds line breaks
 * into spaces.
 */
function codeLiteral(value: FilterValue): string {
  const text =
    typeof value === 'string' && /[\r\n]/.test(value) ? JSON.stringify(value) : String(value);
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || text === '' ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Spread into a tool definition's `enrichmentTrailer` block. */
export const listEnrichmentTrailer = {
  filters: {
    render: (filters: AppliedFilters | undefined): string =>
      `**Filters:** ${Object.entries(filters ?? {})
        .map(([key, value]) => `${key} ${codeLiteral(value)}`)
        .join(' · ')}`,
  },
};

/**
 * Notice for an empty offset/count page: the offset-past-end text when `offset`
 * sits at or beyond a known nonzero total, else `emptyText`.
 */
export function pageEndNotice(
  noun: string,
  offset: number,
  totalItems: number | undefined,
  emptyText: string,
): string {
  return totalItems !== undefined && totalItems > 0 && offset >= totalItems
    ? `No ${noun} on this page: \`offset\` is at or past \`totalItems\`. Lower \`offset\` to page back into the results.`
    : emptyText;
}
