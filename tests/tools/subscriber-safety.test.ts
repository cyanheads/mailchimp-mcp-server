/**
 * @fileoverview Real-service subscriber validation and consent regression tests.
 * @module tests/tools/subscriber-safety.test
 */
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createMockContext,
  expectInputRequired,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailchimpFindSubscriberTool as find } from '@/mcp-server/tools/definitions/mailchimp-find-subscriber.tool.js';
import { mailchimpImportSubscribersTool as batch } from '@/mcp-server/tools/definitions/mailchimp-import-subscribers.tool.js';
import { mailchimpSubscribersTool as primitive } from '@/mcp-server/tools/definitions/mailchimp-subscribers.tool.js';
import { mailchimpUpsertSubscriberTool as upsert } from '@/mcp-server/tools/definitions/mailchimp-upsert-subscriber.tool.js';
import {
  MailchimpService,
  mailchimpMemberHash,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';

const key = 'subscriptionConfirmation';
const email = 'user@example.com';
const upsertInput = {
  audienceId: 'a',
  email,
  status: 'subscribed' as const,
  tags: ['new'],
  note: 'note',
};
const updateInput = {
  operation: 'update' as const,
  audienceId: 'a',
  email,
  status: 'subscribed' as const,
  vip: true,
};
const batchInput = { audienceId: 'a', subscribers: [{ email, status: 'subscribed' as const }] };
const context = () => createMockContext({ errors: primitive.errors });
describe('subscriber safety through HTTP', () => {
  let server: Server;
  let service: MailchimpService;
  let status: string | undefined;
  let readStatus: number;
  let cancelRead: (() => void) | undefined;
  let requests: Array<{ method: string; url: string; body: Record<string, unknown> }>;
  beforeEach(async () => {
    status = 'unsubscribed';
    readStatus = 200;
    cancelRead = undefined;
    requests = [];
    server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      requests.push({ method, url, body });
      if (method === 'GET' && cancelRead) {
        cancelRead();
        return;
      }
      const member = () => ({
        id: mailchimpMemberHash(email),
        email_address: email,
        list_id: 'a',
        status,
      });
      let response: unknown = member();
      if (
        method === 'GET' &&
        /\/members\/[a-f0-9]+(?:\?|$)/.test(url) &&
        (readStatus !== 200 || status === undefined)
      ) {
        res
          .writeHead(readStatus !== 200 ? readStatus : 404, { 'content-type': 'application/json' })
          .end('{"title":"Resource Not Found"}');
        return;
      }
      if (method === 'GET' && url.startsWith('/search-members'))
        response = { exact_matches: { members: [] }, full_search: { members: [member()] } };
      else if (method === 'GET' && /\/tags/.test(url)) response = { tags: [], total_items: 0 };
      else if (method === 'GET' && /\/members\?/.test(url))
        response = { members: [], total_items: 0 };
      else if (method === 'PATCH' || method === 'PUT') {
        status = (body.status as string) ?? status ?? (body.status_if_new as string);
        response = { ...member(), ...body };
      } else if (method === 'POST' && url === '/lists/a') {
        const rows = body.members as Array<{ email_address: string; status: string }>;
        response = {
          new_members: rows
            .filter((r) => r.email_address !== 'bad@example.com')
            .map((r) => ({ ...member(), email_address: r.email_address, status: r.status })),
          updated_members: [],
          errors: rows
            .filter((r) => r.email_address === 'bad@example.com')
            .map((r) => ({
              email_address: r.email_address,
              error: 'upstream rejection',
              error_code: 'BAD',
            })),
          total_created: rows.filter((r) => r.email_address !== 'bad@example.com').length,
          total_updated: 0,
          error_count: rows.filter((r) => r.email_address === 'bad@example.com').length,
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    service = new MailchimpService({
      apiKey: 'abcdef0123456789abcdef0123456789-us22',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      timeoutMs: 1000,
      maxRetries: 0,
      concurrencyLimit: 4,
      dataCenter: 'us22',
    });
    setMailchimpServiceForTesting(service);
  });
  afterEach(async () => {
    vi.useRealTimers();
    service.dispose();
    setMailchimpServiceForTesting(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const writes = () => requests.filter((r) => r.method !== 'GET');
  const run = async (
    kind: 'upsert' | 'update' | 'batch',
    input: Record<string, unknown>,
    ctx = context(),
  ) => {
    if (kind === 'upsert') return upsert.handler(upsert.input.parse(input), ctx);
    if (kind === 'update') return primitive.handler(primitive.input.parse(input), ctx);
    return batch.handler(batch.input.parse(input), ctx);
  };
  async function consent(
    kind: 'upsert' | 'update' | 'batch',
    input: Record<string, unknown>,
    response: Record<string, unknown> = { action: 'accept', content: { confirmed: true } },
  ) {
    const first = context();
    const asked = await expectInputRequired(() => run(kind, input, first));
    const second = createMockContext({
      errors: primitive.errors,
      requestState: asked.requestState,
      inputResponses: { [key]: response },
    });
    await second.state.set(
      `consent/${asked.requestState}`,
      await first.state.get(`consent/${asked.requestState}`),
    );
    return second;
  }
  it('characterizes pending upsert/import and free-form find', async () => {
    status = undefined;
    const result = await run('upsert', {
      ...upsertInput,
      status: 'pending',
      tags: undefined,
      note: undefined,
    });
    expect(result).toMatchObject({ status: 'pending', isNew: true });
    const imported = await runToolContract(batch, { audienceId: 'a', subscribers: [{ email }] });
    expect(imported.structuredContent).toMatchObject({ succeeded: [{ status: 'pending' }] });
    const found = await runToolContract(find, { email: 'user', includeTags: false });
    expect(found.structuredContent).toMatchObject({ totalMatches: 1 });
    expect(JSON.stringify(found.content)).toContain(email);
  });
  it.each(['', '  ', 'no-at', '@domain', 'local@'])(
    'rejects malformed address %j locally',
    async (value) => {
      const result = await runToolContract(primitive, {
        operation: 'get',
        audienceId: 'a',
        email: value,
      });
      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(0);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_email' } },
      });
      expect(JSON.stringify(result.content)).toContain('nonempty');
    },
  );
  it.each([
    'list',
    'get',
    'update',
    'archive',
    'list-tags',
    'set-tags',
    'list-notes',
    'add-note',
    'update-note',
    'delete-note',
    'list-activity',
    'list-events',
    'list-goals',
  ] as const)('guards address on %s', async (operation) => {
    const result = await runToolContract(primitive, {
      operation,
      audienceId: 'a',
      email: 'no-at',
      tags: [],
      note: 'n',
      noteId: 1,
      vip: true,
    });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
  it('accepts unusual syntax and normalized hashes; omitted/empty list stays unfiltered', async () => {
    for (const value of [' User@Example.COM ', 'a+b@localhost', '"a b"@[127.0.0.1]']) {
      await primitive.handler(
        primitive.input.parse({ operation: 'get', audienceId: 'a', email: value }),
        context(),
      );
      expect(requests.at(-1)?.url).toContain(mailchimpMemberHash(value));
    }
    for (const value of [undefined, '']) {
      const result = await runToolContract(primitive, {
        operation: 'list',
        audienceId: 'a',
        email: value,
        offset: 999,
        count: 1000,
      });
      expect(result.structuredContent).toMatchObject({ subscribers: [], totalItems: 0 });
      expect(requests.at(-1)?.url).not.toContain('email_address');
    }
  });
  it('retains mixed import failures and avoids all-invalid upstream calls', async () => {
    const result = await runToolContract(batch, {
      audienceId: 'a',
      subscribers: [{ email: 'no-at' }, { email }, { email: 'bad@example.com' }],
    });
    expect(result.structuredContent).toMatchObject({
      errorCount: 2,
      totalCreated: 1,
      failed: [
        { email: 'no-at', errorCode: 'invalid_email' },
        { email: 'bad@example.com', error: 'upstream rejection', errorCode: 'BAD' },
      ],
    });
    expect(JSON.stringify(result.content)).toContain('[invalid_email]');
    expect(JSON.stringify(result.content)).toContain('[BAD]: upstream rejection');
    expect(JSON.stringify(result.content)).toContain('user@example.com');
    expect(JSON.stringify(result.content)).toContain('Successful rows returned as `pending`');
    requests = [];
    const empty = await runToolContract(batch, {
      audienceId: 'a',
      status: 'subscribed',
      subscribers: [{ email: 'no-at' }],
    });
    expect(empty.structuredContent).toMatchObject({ succeeded: [], errorCount: 1 });
    expect(requests).toHaveLength(0);
  });
  it.each([
    ['upsert', upsertInput],
    ['update', updateInput],
    ['batch', batchInput],
  ] as const)(
    '%s gates before mutation and replays after persistent status change',
    async (kind, input) => {
      const ctx = await consent(kind, input);
      expect(writes()).toHaveLength(0);
      const result = await run(kind, input, ctx);
      if (kind === 'upsert') {
        expect(result).toMatchObject({
          status: 'subscribed',
          noteAttached: true,
          tagsAdded: ['new'],
        });
        expect(writes().map((request) => request.method)).toEqual(['PATCH', 'POST', 'POST']);
        expect(writes()[0]?.body).toEqual({ status: 'subscribed' });
      } else if (kind === 'update') {
        expect(result).toMatchObject({ subscriber: { status: 'subscribed', vip: true } });
        expect(writes()).toHaveLength(1);
        expect(writes()[0]?.body).toEqual({ status: 'subscribed', vip: true });
      } else {
        expect(result).toMatchObject({
          totalCreated: 1,
          succeeded: [{ email, status: 'subscribed' }],
        });
        expect(writes()).toHaveLength(1);
        expect(writes()[0]?.body.members).toEqual([{ email_address: email, status: 'subscribed' }]);
      }
      const count = writes().length;
      await expectInputRequired(() => run(kind, input, ctx));
      expect(writes()).toHaveLength(count);
    },
  );
  it.each(['decline', 'cancel'])('declined/cancelled import %s writes nothing', async (action) => {
    const ctx = await consent('batch', batchInput, { action });
    await expect(run('batch', batchInput, ctx)).rejects.toMatchObject({
      data: { reason: 'subscription_cancelled' },
    });
    expect(writes()).toHaveLength(0);
  });
  it('does not confirm or rewrite already-subscribed status on first calls', async () => {
    status = 'subscribed';
    for (const kind of ['upsert', 'update'] as const) {
      requests = [];
      await run(kind, kind === 'upsert' ? { ...upsertInput, vip: true } : updateInput);
      const patches = writes().filter((request) => request.method === 'PATCH');
      expect(patches).toHaveLength(1);
      expect(patches[0]?.body).toEqual({ vip: true });
      requests = [];
      await run(kind, {
        audienceId: 'a',
        email,
        status: 'subscribed',
        ...(kind === 'update' ? { operation: 'update' } : {}),
      });
      expect(writes()).toEqual([]);
    }
    status = 'unsubscribed';
    requests = [];
    await run('upsert', { ...upsertInput, updateExistingStatus: false, vip: true });
    expect(
      writes()
        .filter((request) => request.method === 'PATCH')
        .map((request) => request.body),
    ).toEqual([{ vip: true }]);
  });
  it.each([401, 403, 500])('read %s cannot become creation', async (failure) => {
    readStatus = failure;
    const result = await runToolContract(upsert, upsertInput);
    expect(result.isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });
  it('valid missing member remains not found for primitive but creation asks on upsert', async () => {
    status = undefined;
    const result = await runToolContract(primitive, updateInput);
    expect(result.isError).toBe(true);
    expect(writes()).toHaveLength(0);
    const ctx = await consent('upsert', upsertInput);
    await run('upsert', upsertInput, ctx);
    expect(writes()[0]?.method).toBe('PUT');
  });
  it.each(['upsert', 'update', 'batch'] as const)(
    '%s ignores a preanswered unissued approval',
    async (kind) => {
      const input = kind === 'upsert' ? upsertInput : kind === 'update' ? updateInput : batchInput;
      const ctx = createMockContext({
        errors: primitive.errors,
        inputResponses: { [key]: { action: 'accept', content: { confirmed: true } } },
      });
      await expectInputRequired(() => run(kind, input, ctx));
      expect(writes()).toHaveLength(0);
    },
  );
  it.each(['upsert', 'update', 'batch'] as const)(
    '%s rejects malformed acceptance and declines without writes',
    async (kind) => {
      const input = kind === 'upsert' ? upsertInput : kind === 'update' ? updateInput : batchInput;
      const malformed = await consent(kind, input, {
        action: 'accept',
        content: { confirmed: 'yes' },
      });
      await expect(run(kind, input, malformed)).rejects.toThrow(
        'confirmation response was invalid',
      );
      const declined = await consent(kind, input, { action: 'decline' });
      await expect(run(kind, input, declined)).rejects.toMatchObject({
        data: { reason: 'subscription_cancelled' },
      });
      expect(writes()).toHaveLength(0);
    },
  );
  it.each([
    { audienceId: 'other' },
    { email: 'other@example.com' },
    { status: 'pending' },
    { tags: ['different'] },
    { preserveTags: ['keep'] },
    { note: 'different' },
    { mergeFields: { FNAME: 'different' } },
    { vip: true },
    { language: 'fr' },
    { updateExistingStatus: false },
  ])('upsert binds every write option %j', async (change) => {
    const ctx = await consent('upsert', upsertInput);
    await expectInputRequired(() => run('upsert', { ...upsertInput, ...change }, ctx));
    expect(writes()).toHaveLength(0);
  });
  it.each([
    { subscribers: [{ email, status: 'pending' }] },
    { subscribers: [{ email: 'other@example.com', status: 'subscribed' }] },
    {
      subscribers: [{ email, status: 'subscribed', tags: ['different'], mergeFields: { X: 'y' } }],
    },
    { audienceId: 'other' },
    { syncTags: false },
    { updateExisting: true },
    { skipMergeValidation: true },
    { skipDuplicateCheck: true },
  ])('import binds resolved rows and options %j', async (change) => {
    const ctx = await consent('batch', batchInput);
    await expectInputRequired(() => run('batch', { ...batchInput, ...change }, ctx));
    expect(writes()).toHaveLength(0);
  });
  it('reentry binds caller and issuing instance', async () => {
    const ctx = await consent('batch', batchInput);
    const record = await ctx.state.get<Record<string, unknown>>(`consent/${ctx.inputs.state()}`);
    await ctx.state.set(`consent/${ctx.inputs.state()}`, { ...record, instanceId: 'foreign' });
    await expectInputRequired(() => run('batch', batchInput, ctx));
    expect(writes()).toHaveLength(0);
    const first = context();
    const asked = await expectInputRequired(() => run('batch', batchInput, first));
    const other = createMockContext({
      errors: primitive.errors,
      auth: { clientId: 'other', sub: 'other', scopes: [] },
      requestState: asked.requestState,
      inputResponses: { [key]: { action: 'accept', content: { confirmed: true } } },
    });
    await other.state.set(
      `consent/${asked.requestState}`,
      await first.state.get(`consent/${asked.requestState}`),
    );
    await expectInputRequired(() => run('batch', batchInput, other));
    expect(writes()).toHaveLength(0);
  });
  it('concurrent upserts redeem once and never repeat notes/tags', async () => {
    const ctx = await consent('upsert', upsertInput);
    const results = await Promise.allSettled([
      run('upsert', upsertInput, ctx),
      run('upsert', upsertInput, ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(writes()).toHaveLength(3);
    expect(writes().filter((r) => r.url.endsWith('/notes'))).toHaveLength(1);
  });
  it('expiration asks again without writes', async () => {
    const ctx = await consent('batch', batchInput);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000);
    try {
      await expectInputRequired(() => run('batch', batchInput, ctx));
      expect(writes()).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('cancellation during a member read stops upsert instead of creating', async () => {
    const controller = new AbortController();
    cancelRead = () => controller.abort();
    const result = await runToolContract(upsert, upsertInput, {
      context: { signal: controller.signal },
    });
    expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
    expect(JSON.stringify(result.content)).toContain('cancel');
    expect(writes()).toHaveLength(0);
  });
  it('batch cap and successful pending rows are visible on both surfaces', async () => {
    const subscribers = Array.from({ length: 500 }, (_, i) => ({ email: `user${i}@example.com` }));
    const result = await runToolContract(batch, { audienceId: 'a', subscribers });
    expect(result.structuredContent).toMatchObject({
      totalCreated: 500,
      succeeded: subscribers.map((row) => ({ email: row.email, status: 'pending', isNew: true })),
    });
    expect(JSON.stringify(result.content)).toContain('500/500');
    expect(JSON.stringify(result.content)).toContain('Successful rows returned as');
    expect(
      batch.input.safeParse({ audienceId: 'a', subscribers: [...subscribers, { email }] }).success,
    ).toBe(false);
    expect(batch.input.safeParse({ audienceId: 'a', subscribers: [] }).success).toBe(false);
    expect(requests).toHaveLength(1);
  });
});
