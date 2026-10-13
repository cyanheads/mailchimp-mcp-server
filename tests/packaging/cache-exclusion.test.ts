/**
 * @fileoverview Bundle ignore rules retain examples and exclude private caches.
 * @module tests/packaging/cache-exclusion.test
 */
import { readFileSync } from 'node:fs';
import ignore from 'ignore';
import { describe, expect, it } from 'vitest';

const rules = ignore().add(readFileSync('.mcpbignore', 'utf8'));
describe('bundle exclusions', () => {
  it('characterizes environment exclusion and retained examples', () => {
    for (const file of ['.env', 'nested/.env.secret']) expect(rules.ignores(file)).toBe(true);
    for (const file of ['examples/assets/hero.png', 'examples/templates/newsletter.eta'])
      expect(rules.ignores(file)).toBe(false);
  });
  it.each([
    '.mailchimp-cache.json',
    'assets/.mailchimp-cache.json',
    'nested/assets/.mailchimp-cache.json',
    '.mailchimp-cache.json.123.tmp',
    'nested/assets/.mailchimp-cache.json.abc.tmp',
  ])('excludes %s', (file) => expect(rules.ignores(file)).toBe(true));
});
