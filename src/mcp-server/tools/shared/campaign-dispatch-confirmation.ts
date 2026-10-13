/**
 * @fileoverview Shared multi-round confirmation gate for campaign dispatch tools.
 * @module mcp-server/tools/shared/campaign-dispatch-confirmation
 */

import { z } from '@cyanheads/mcp-ts-core';
import { type ConfirmationContext, confirmConsent } from './consent-record.js';

const CONFIRMATION_KEY = 'campaignDispatchConfirmation';

const CampaignDispatchConfirmationSchema = z.object({
  confirmed: z.boolean().describe('Confirm to proceed, decline to leave the campaign as a draft.'),
});

/**
 * Resolve an existing confirmation response or suspend for a new one.
 * The message factory runs only on the first round, before any campaign mutation.
 */
export function confirmCampaignDispatch(
  ctx: ConfirmationContext,
  binding: { operation: string; target: string; content: () => Promise<unknown> },
  message: () => Promise<string>,
): Promise<boolean> {
  return confirmConsent(ctx, binding, {
    key: CONFIRMATION_KEY,
    schema: CampaignDispatchConfirmationSchema,
    label: 'Campaign dispatch',
    message,
  });
}
