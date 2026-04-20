/**
 * @fileoverview Unit tests for the Mailchimp server config parser.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

const ENV_KEYS = [
  'MAILCHIMP_API_KEY',
  'MAILCHIMP_BASE_URL',
  'MAILCHIMP_TIMEOUT_MS',
  'MAILCHIMP_MAX_RETRIES',
  'MAILCHIMP_CONCURRENCY_LIMIT',
] as const;

describe('getServerConfig', () => {
  let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const key of ENV_KEYS) delete process.env[key];
    resetServerConfig();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    resetServerConfig();
  });

  it('parses a valid key and derives the data center', () => {
    process.env.MAILCHIMP_API_KEY = 'abcdef0123456789abcdef0123456789-us22';
    const cfg = getServerConfig();
    expect(cfg.dataCenter).toBe('us22');
    expect(cfg.baseUrl).toBe('https://us22.api.mailchimp.com/3.0');
    expect(cfg.timeoutMs).toBe(60_000);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.concurrencyLimit).toBe(4);
  });

  it('honors MAILCHIMP_BASE_URL override', () => {
    process.env.MAILCHIMP_API_KEY = 'abcdef0123456789abcdef0123456789-us1';
    process.env.MAILCHIMP_BASE_URL = 'https://mock.example.com/3.0';
    const cfg = getServerConfig();
    expect(cfg.baseUrl).toBe('https://mock.example.com/3.0');
    expect(cfg.dataCenter).toBe('us1');
  });

  it('coerces numeric envs from strings', () => {
    process.env.MAILCHIMP_API_KEY = 'abcdef0123456789abcdef0123456789-us22';
    process.env.MAILCHIMP_TIMEOUT_MS = '15000';
    process.env.MAILCHIMP_MAX_RETRIES = '5';
    process.env.MAILCHIMP_CONCURRENCY_LIMIT = '2';
    const cfg = getServerConfig();
    expect(cfg.timeoutMs).toBe(15_000);
    expect(cfg.maxRetries).toBe(5);
    expect(cfg.concurrencyLimit).toBe(2);
  });

  it('memoizes after first parse', () => {
    process.env.MAILCHIMP_API_KEY = 'abcdef0123456789abcdef0123456789-us22';
    const first = getServerConfig();
    process.env.MAILCHIMP_API_KEY = 'different00000000000000000000000-us1';
    const second = getServerConfig();
    expect(second).toBe(first);
    expect(second.dataCenter).toBe('us22');
  });

  it('rejects a malformed key', () => {
    process.env.MAILCHIMP_API_KEY = 'no-dc-suffix';
    expect(() => getServerConfig()).toThrow(/<32-hex>-<dc>/);
  });

  it('rejects a missing key', () => {
    expect(() => getServerConfig()).toThrow(/apiKey/);
  });
});
