/**
 * @fileoverview CommonMark rendering for literal values in tool results.
 * @module mcp-server/tools/shared/markdown-values
 */

import {
  escapeMarkdownInline,
  markdown,
  markdownImage,
  markdownLink,
} from '@cyanheads/mcp-ts-core/utils';

/** Escapes text and encodes line endings without splitting the surrounding Markdown slot. */
export function inlineText(value: string): string {
  if (value.includes('\0')) return codeText(value);
  return value
    .split(/([\r\n])/)
    .map((part) => (part === '\r' ? '&#13;' : part === '\n' ? '&#10;' : escapeMarkdownInline(part)))
    .join('');
}

/** Uses a copyable code span. JSON quoting preserves values a code span would normalize. */
export function codeText(value: string): string {
  return markdown()
    .inlineCode(/[\r\n\0]/.test(value) ? JSON.stringify(value).replaceAll('|', '\\u007c') : value)
    .build();
}

/** Puts a multiline heading value in a labeled paragraph below the heading. */
export function headingText(value: string, level: 1 | 2 | 3 = 1, label = 'Title'): string {
  const prefix = '#'.repeat(level);
  return /[\r\n]/.test(value)
    ? `${prefix} ${label}\n\n${inlineText(value)}`
    : `${prefix} ${inlineText(value)}`;
}

/** Applies the quote marker to every line, preserving CR and terminal LF. */
export function quoteText(value: string): string {
  const lines = value.split('\n');
  return lines
    .map((line, index) => {
      const text = inlineText(line);
      if (index === lines.length - 1) return `> ${text}`;
      if (index === lines.length - 2 && lines[index + 1] === '') return `> ${text}&#10;`;
      return `> ${text}\\`;
    })
    .join('\n');
}

function isWebUrl(value: string): boolean {
  if (/[\r\n\0]/.test(value)) return false;
  const protocol = URL.parse(value)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
}

/** Keeps non-web and malformed destinations visible as exact literal text. */
export function webLink(value: string, label = value): string {
  if (isWebUrl(value)) return markdownLink(label, value);
  return label === value ? inlineText(value) : `${inlineText(label)} (${inlineText(value)})`;
}

/** Embeds a web thumbnail or shows the original value if it cannot be a destination. */
export function thumbnailImage(value: string): string {
  return isWebUrl(value) ? markdownImage('Thumbnail', value) : inlineText(value);
}
