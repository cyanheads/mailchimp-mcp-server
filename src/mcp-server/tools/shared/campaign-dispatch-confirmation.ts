/**
 * @fileoverview Shared multi-round confirmation gate for campaign dispatch tools.
 * @module mcp-server/tools/shared/campaign-dispatch-confirmation
 */

import { type Context, inputRequired, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

const CONFIRMATION_KEY = 'campaignDispatchConfirmation';

const CampaignDispatchConfirmationSchema = z.object({
  confirmed: z.boolean().describe('Confirm to proceed, decline to leave the campaign as a draft.'),
});

type ConfirmationContext = Pick<Context, 'inputs' | 'requestInput'>;

/**
 * Resolve an existing confirmation response or suspend for a new one.
 * The message factory runs only on the first round, before any campaign mutation.
 */
export async function confirmCampaignDispatch(
  ctx: ConfirmationContext,
  message: () => Promise<string>,
): Promise<boolean> {
  const view = ctx.inputs.view(CONFIRMATION_KEY);

  if (view.kind === 'elicit') {
    if (view.action !== 'accept') return false;

    const response = ctx.inputs.accepted(CONFIRMATION_KEY, CampaignDispatchConfirmationSchema);
    if (!response) {
      throw validationError('Campaign dispatch confirmation response was invalid.');
    }
    return response.confirmed;
  }

  if (view.kind !== 'missing') {
    throw validationError('Campaign dispatch confirmation returned an unexpected response type.');
  }

  return ctx.requestInput({
    inputRequests: {
      [CONFIRMATION_KEY]: inputRequired.elicit({
        message: await message(),
        requestedSchema: CampaignDispatchConfirmationSchema,
      }),
    },
  });
}
