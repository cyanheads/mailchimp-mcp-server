/**
 * @fileoverview Response normalization helpers for Mailchimp payloads.
 *
 * Mailchimp returns `snake_case` keys and attaches a HAL-style `_links`
 * array to most resources. Tool handlers that rename fields one-by-one
 * miss nested objects and leak raw shapes to the agent. Applying
 * `normalizeMailchimp()` at the boundary produces a consistently
 * `camelCase` shape and strips `_links` at every depth, so handlers and
 * resource definitions don't have to remember to do it themselves.
 *
 * @module services/mailchimp/normalize
 */

/**
 * Convert a snake_case (or kebab-case) key to camelCase.
 * All-caps keys (e.g. merge-field tags like `FNAME`, `FIELDTST`) are
 * preserved as-is so user-chosen merge tags survive the conversion.
 */
export function toCamelCase(key: string): string {
  if (/^[A-Z0-9_]+$/.test(key)) return key;
  return key.replace(/[_-]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Recursively normalize a Mailchimp API value:
 *   - Objects: snake_case keys become camelCase; `_links` is stripped at every depth.
 *   - Arrays: each element is normalized.
 *   - Primitives: returned as-is.
 *
 * This is a *shape* normalization — it never changes values, only keys.
 */
export function normalizeMailchimp<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map((v) => normalizeMailchimp(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === '_links') continue;
      out[toCamelCase(key)] = normalizeMailchimp(v);
    }
    return out as T;
  }
  return value as T;
}
