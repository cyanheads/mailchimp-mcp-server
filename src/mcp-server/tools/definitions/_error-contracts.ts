/**
 * @fileoverview Shared `errors[]` contract entries for tool definitions.
 *
 * Every tool that calls the Mailchimp service can surface the same set of
 * upstream failures (auth, paid-tier gating, not-found, upstream validation,
 * rate-limiting, transport failures, timeouts). They're collected here so
 * tool definitions can spread them into their own `errors[]` without
 * duplicating the contract — keeping the public failure surface consistent
 * and machine-readable across the whole server.
 *
 * Service-layer throws stamp `data.reason` to match these entries (see
 * `classifyStatus` in `src/services/mailchimp/mailchimp-service.ts`) so wire
 * payloads carry the same `error.data.reason` clients see from `ctx.fail` in
 * tool handlers.
 *
 * @module src/mcp-server/tools/definitions/_error-contracts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/**
 * Cross-tool error reasons shared by every tool that calls the Mailchimp
 * service. Spread these into a tool's `errors[]` alongside any tool-specific
 * entries.
 */
export const MAILCHIMP_SERVICE_ERRORS = [
  {
    reason: 'mailchimp_unauthorized',
    code: JsonRpcErrorCode.Unauthorized,
    when: 'Mailchimp returned 401 — API key invalid, revoked, or missing.',
    recovery:
      'Verify MAILCHIMP_API_KEY in env; rotate via Mailchimp → Account → Extras → API keys.',
  },
  {
    reason: 'mailchimp_forbidden',
    code: JsonRpcErrorCode.Forbidden,
    when: 'Mailchimp returned 403 — paid-tier feature or insufficient permissions.',
    recovery:
      'When data.requiresPlan is set, upgrade the Mailchimp plan; otherwise use a free-tier alternative (e.g. mailchimp_local_templates instead of /templates).',
  },
  {
    reason: 'mailchimp_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'Mailchimp returned 404 — entity does not exist or has been deleted.',
    recovery:
      'List the parent collection (mailchimp_audiences / mailchimp_campaigns / mailchimp_templates) and retry with a valid ID.',
  },
  {
    reason: 'mailchimp_validation_failed',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Mailchimp returned 400 or 422 — request body failed upstream validation.',
    recovery: 'Inspect data.upstream.errors[] for field-level reasons, fix the input, and retry.',
  },
  {
    reason: 'mailchimp_rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: 'Mailchimp returned 429 — too many concurrent requests.',
    recovery: 'Retry after a brief delay; reduce MAILCHIMP_CONCURRENCY_LIMIT for bulk operations.',
    retryable: true,
  },
  {
    reason: 'mailchimp_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Mailchimp API unreachable or returned a 5xx after retries.',
    recovery: 'Retry after a brief delay; check status.mailchimp.com if failures persist.',
    retryable: true,
  },
  {
    reason: 'mailchimp_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'Request to Mailchimp exceeded MAILCHIMP_TIMEOUT_MS.',
    recovery: 'Retry; raise MAILCHIMP_TIMEOUT_MS for slow endpoints such as large batch imports.',
    retryable: true,
  },
] as const;
