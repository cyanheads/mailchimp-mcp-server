/**
 * @fileoverview Conservative structural guard for address-based member operations.
 * @module mcp-server/tools/shared/subscriber-address
 */
import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** Mailchimp remains responsible for address grammar beyond nonempty parts. */
export function hasSubscriberAddress(email: string): boolean {
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  return at > 0 && at < trimmed.length - 1;
}

/** Trim and reject incomplete addresses before an upstream lookup or mutation. */
export function requireSubscriberAddress(email: string | undefined): string {
  if (email === undefined || !hasSubscriberAddress(email))
    throw validationError('Email must contain @ with nonempty local and domain parts.', {
      reason: 'invalid_email',
    });
  return email.trim();
}
