/**
 * @fileoverview HTML scanning + URL rewriting for `@assets/<path>` references.
 * Scans common attributes (`src`, `href`, `background`) and CSS `url(...)` for
 * `@assets/...` references and returns the unique relative paths. After the
 * caller resolves each to an uploaded Mailchimp URL, `rewriteHtml` substitutes
 * them in place. Pure functions — no I/O.
 * @module services/assets/rewrite
 */

const ATTR_PATTERN =
  /\b(src|href|background)\s*=\s*(?:"@assets\/([^"\s>]+)"|'@assets\/([^'\s>]+)'|@assets\/([^"'\s>]+))/gi;

const CSS_URL_PATTERN =
  /url\(\s*(?:"@assets\/([^"\s)]+)"|'@assets\/([^'\s)]+)'|@assets\/([^"'\s)]+))\s*\)/gi;

/** Extract the unique set of `@assets/<path>` references from HTML. */
export function scanAssetReferences(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(ATTR_PATTERN)) {
    const ref = match[2] ?? match[3] ?? match[4];
    if (ref) found.add(decodeURI(ref));
  }
  for (const match of html.matchAll(CSS_URL_PATTERN)) {
    const ref = match[1] ?? match[2] ?? match[3];
    if (ref) found.add(decodeURI(ref));
  }
  return [...found];
}

/**
 * Rewrite every `@assets/<relPath>` reference to the supplied URL. References
 * not present in `urlMap` are left untouched (they will fail at Mailchimp's end,
 * which is the intended signal that the asset is missing).
 */
export function rewriteHtml(html: string, urlMap: Map<string, string>): string {
  const replace = (raw: string): string => {
    const ref = decodeURI(raw);
    return urlMap.get(ref) ?? `@assets/${raw}`;
  };

  return html
    .replace(ATTR_PATTERN, (full, attr, dq, sq, bare) => {
      const ref = (dq ?? sq ?? bare) as string;
      const replacement = replace(ref);
      if (replacement === `@assets/${ref}`) return full;
      if (dq !== undefined) return `${attr}="${replacement}"`;
      if (sq !== undefined) return `${attr}='${replacement}'`;
      return `${attr}=${replacement}`;
    })
    .replace(CSS_URL_PATTERN, (full, dq, sq, bare) => {
      const ref = (dq ?? sq ?? bare) as string;
      const replacement = replace(ref);
      if (replacement === `@assets/${ref}`) return full;
      if (dq !== undefined) return `url("${replacement}")`;
      if (sq !== undefined) return `url('${replacement}')`;
      return `url(${replacement})`;
    });
}
