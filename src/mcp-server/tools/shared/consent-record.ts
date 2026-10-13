/**
 * @fileoverview Single-use server-held consent issuance and redemption.
 * @module mcp-server/tools/shared/consent-record
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type Context, inputRequired, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

export type ConfirmationContext = Pick<Context, 'inputs' | 'requestInput' | 'state' | 'auth'>;
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

/** Spend locally before reading storage, excluding concurrent and replayed use. */
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

/** Resolve a bound confirmation or suspend with a fresh ten-minute consent record. */
export async function confirmConsent(
  ctx: ConfirmationContext,
  binding: { operation: string; target: string; content: () => Promise<unknown> },
  prompt: {
    key: string;
    schema: z.ZodObject<{ confirmed: z.ZodBoolean }>;
    label: string;
    message: () => Promise<string>;
  },
): Promise<boolean> {
  for (const [id, expires] of issued) if (expires <= Date.now()) issued.delete(id);
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
  const view = ctx.inputs.view(prompt.key);
  if (matches && view.kind === 'elicit') {
    if (view.action !== 'accept') return false;
    const response = ctx.inputs.accepted(prompt.key, prompt.schema);
    if (!response) throw validationError(`${prompt.label} confirmation response was invalid.`);
    return response.confirmed;
  }
  if (matches && view.kind !== 'missing')
    throw validationError(`${prompt.label} confirmation returned an unexpected response type.`);
  const fresh = randomUUID();
  const message = await prompt.message();
  await ctx.state.set(`consent/${fresh}`, expected, { ttl: 600 });
  issued.set(fresh, Date.now() + 600_000);
  return ctx.requestInput({
    inputRequests: {
      [prompt.key]: inputRequired.elicit({ message, requestedSchema: prompt.schema }),
    },
    requestState: fresh,
  });
}
