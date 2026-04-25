/**
 * @fileoverview Server-specific configuration for mailchimp-mcp-server.
 * Lazy-parsed Zod schema for Mailchimp API credentials and tuning knobs.
 * Kept separate from the framework's core config.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Mailchimp API keys have the form `<hex>-<dc>` where `<dc>` is the data center (e.g. `us22`).
 * The data center prefixes the API host: `https://{dc}.api.mailchimp.com/3.0`.
 */
const API_KEY_PATTERN = /^[a-f0-9]{32}-(?<dc>[a-z]+\d+)$/i;

const ServerConfigSchema = z
  .object({
    apiKey: z
      .string()
      .min(1)
      .regex(API_KEY_PATTERN, 'must match the format `<32-hex>-<dc>` (e.g. `abc…-us22`)')
      .describe('Mailchimp Marketing API key, including the data-center suffix.'),
    baseUrl: z
      .string()
      .url()
      .optional()
      .describe('Optional base URL override (for mock servers or tests).'),
    timeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe('Per-request timeout in milliseconds.'),
    maxRetries: z.coerce
      .number()
      .int()
      .min(0)
      .max(10)
      .default(3)
      .describe('Max retry attempts for transient upstream failures.'),
    concurrencyLimit: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(4)
      .describe('Max in-flight upstream requests per workflow tool.'),
    assetsDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Absolute path to a local assets directory. When set (and the runtime has filesystem access), enables the `mailchimp_assets` tool plus auto-upload of `@assets/<path>` references found in campaign HTML. Files are uploaded to Mailchimp File Manager once and cached locally by content hash. Leave unset to disable the L1 surface.',
      ),
    templatesDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute path to a local templates directory. When set (and the runtime has filesystem access), enables the `mailchimp_local_templates` tool plus support for `content.localTemplate` on campaign tools. Templates are `.eta` files with optional `<name>.meta.yaml` sidecars for subject / preview defaults. Partials live alongside the templates and are referenced via Eta's `include()`. Leave unset to disable the L2 surface.",
      ),
  })
  .transform((raw) => {
    const dc = API_KEY_PATTERN.exec(raw.apiKey)?.groups?.dc ?? '';
    const baseUrl = raw.baseUrl ?? `https://${dc}.api.mailchimp.com/3.0`;
    return { ...raw, dataCenter: dc, baseUrl };
  });

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'MAILCHIMP_API_KEY',
    baseUrl: 'MAILCHIMP_BASE_URL',
    timeoutMs: 'MAILCHIMP_TIMEOUT_MS',
    maxRetries: 'MAILCHIMP_MAX_RETRIES',
    concurrencyLimit: 'MAILCHIMP_CONCURRENCY_LIMIT',
    assetsDir: 'MAILCHIMP_ASSETS_DIR',
    templatesDir: 'MAILCHIMP_TEMPLATES_DIR',
  });
  return _config;
}

/** Test-only: reset the cached config so a fresh `process.env` read is forced on next access. */
export function resetServerConfig(): void {
  _config = undefined;
}
