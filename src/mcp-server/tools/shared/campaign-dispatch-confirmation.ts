/**
 * @fileoverview Shared multi-round confirmation gate for campaign dispatch tools.
 * @module mcp-server/tools/shared/campaign-dispatch-confirmation
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type Context, inputRequired, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

const CONFIRMATION_KEY = 'campaignDispatchConfirmation';

const CampaignDispatchConfirmationSchema = z.object({
  confirmed: z.boolean().describe('Confirm to proceed, decline to leave the campaign as a draft.'),
});

type ConfirmationContext = Pick<Context, 'inputs' | 'requestInput' | 'state' | 'auth'>;

const INSTANCE_ID = randomUUID();
const issued = new Map<string, number>();
const ConsentSchema = z.object({
  instanceId: z.string(),
  operation: z.string(),
  clientId: z.string(),
  subject: z.string(),
  target: z.string(),
  contentHash: z.string(),
});

/** Spend a consent once in its issuing process; other instances must ask again. */
async function redeem(ctx: ConfirmationContext) {
  const id = ctx.inputs.state();
  if (typeof id !== 'string') return null;
  const expires = issued.get(id);
  if (expires === undefined) return null;
  issued.delete(id);
  if (expires <= Date.now()) return null;
  const record = await ctx.state.get(`consent/${id}`, ConsentSchema);
  if (!record || record.instanceId !== INSTANCE_ID) return null;
  await ctx.state.delete(`consent/${id}`);
  return record;
}

/**
 * Resolve an existing confirmation response or suspend for a new one.
 * The message factory runs only on the first round, before any campaign mutation.
 */
export async function confirmCampaignDispatch(
  ctx: ConfirmationContext,
  binding: { operation: string; target: string; content: () => Promise<unknown> },
  message: () => Promise<string>,
): Promise<boolean> {
  for (const [id, expires] of issued) {
    if (expires <= Date.now()) issued.delete(id);
  }
  const record = await redeem(ctx);
  const expected = {
    instanceId: INSTANCE_ID,
    operation: binding.operation,
    clientId: ctx.auth?.clientId ?? '',
    subject: ctx.auth?.sub ?? '',
    target: binding.target,
    contentHash: createHash('sha256')
      .update(JSON.stringify(await binding.content()))
      .digest('hex'),
  };
  const matches = record !== null && isDeepStrictEqual(record, expected);
  const view = ctx.inputs.view(CONFIRMATION_KEY);

  if (matches && view.kind === 'elicit') {
    if (view.action !== 'accept') return false;

    const response = ctx.inputs.accepted(CONFIRMATION_KEY, CampaignDispatchConfirmationSchema);
    if (!response) {
      throw validationError('Campaign dispatch confirmation response was invalid.');
    }
    return response.confirmed;
  }

  if (matches && view.kind !== 'missing') {
    throw validationError('Campaign dispatch confirmation returned an unexpected response type.');
  }

  const fresh = randomUUID();
  const prompt = await message();
  await ctx.state.set(`consent/${fresh}`, expected, { ttl: 600 });
  issued.set(fresh, Date.now() + 600_000);
  return ctx.requestInput({
    inputRequests: {
      [CONFIRMATION_KEY]: inputRequired.elicit({
        message: prompt,
        requestedSchema: CampaignDispatchConfirmationSchema,
      }),
    },
    requestState: fresh,
  });
}
