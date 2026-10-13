/**
 * @fileoverview Bound consent for new or resumed marketing subscriptions.
 * @module mcp-server/tools/shared/subscription-confirmation
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { type ConfirmationContext, confirmConsent } from './consent-record.js';

const KEY = 'subscriptionConfirmation';
const Schema = z.object({
  confirmed: z
    .boolean()
    .describe(
      'Confirm documented consent to enable marketing delivery; declining cancels all writes.',
    ),
});

/** Reentry must redeem even when an earlier write changed the current member status. */
export function isSubscriptionReentry(ctx: ConfirmationContext): boolean {
  return ctx.inputs.state() !== undefined || ctx.inputs.view(KEY).kind !== 'missing';
}

/** Require one single-use approval for the complete resolved subscriber request. */
export async function confirmSubscription(
  ctx: ConfirmationContext,
  operation: string,
  target: string,
  content: unknown,
): Promise<void> {
  const confirmed = await confirmConsent(
    ctx,
    { operation, target, content: async () => content },
    {
      key: KEY,
      schema: Schema,
      label: 'Subscription',
      message: async () =>
        'Enable marketing delivery for the subscribed contacts in this request? Confirm that you have documented consent. Declining or cancelling performs no writes, including tags and notes.',
    },
  );
  if (!confirmed)
    throw new McpError(
      JsonRpcErrorCode.InvalidRequest,
      'Subscription request cancelled; no writes were performed.',
      { reason: 'subscription_cancelled' },
    );
}
