/**
 * @fileoverview Exercise campaign confirmation over real HTTP with a local fake Mailchimp API.
 * @module tests/tools/campaign-dispatch-http.test
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Rpc = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};
let upstream: Server;
let child: ChildProcess;
let endpoint: string;
let upstreamUrl: string;
let mutations: string[] = [];
let output = '';
let upstreamCalls = 0;
let draftBody = '<p>Reviewed draft</p>';
let draftStatus = 'save';
let draftSubject = 'Test newsletter';
let scheduleBody = '';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

function launch(port: number, mode: string | undefined, transport = 'http'): ChildProcess {
  return spawn('bun', ['--no-env-file', new URL('../../src/index.ts', import.meta.url).pathname], {
    cwd: '/tmp',
    env: {
      PATH: process.env.PATH,
      MCP_TRANSPORT_TYPE: transport,
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: String(port),
      ...(mode ? { MCP_SESSION_MODE: mode } : {}),
      MCP_REQUEST_STATE_KEY: 'test-only-request-state-key-32-bytes',
      MCP_AUTH_MODE: 'none',
      MCP_LOG_LEVEL: 'error',
      OTEL_ENABLED: 'false',
      LOGS_DIR: '/tmp/mailchimp-confirmation-tests',
      MAILCHIMP_API_KEY: 'abcdef0123456789abcdef0123456789-us22',
      MAILCHIMP_BASE_URL: upstreamUrl,
      MAILCHIMP_MAX_RETRIES: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function* messages(response: Response): AsyncGenerator<Rpc> {
  if (response.headers.get('content-type')?.includes('application/json')) {
    yield (await response.json()) as Rpc;
    return;
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      while (pending.includes('\n\n')) {
        const boundary = pending.indexOf('\n\n');
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ') && line.slice(6).trim())
            yield JSON.parse(line.slice(6)) as Rpc;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
}

async function connect(capabilities: Record<string, unknown>, revision = '2025-11-25') {
  let session = '';
  async function post(message: Rpc) {
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': revision,
        ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      signal: AbortSignal.timeout(8_000),
    });
  }
  const response = await post({
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: revision,
      capabilities,
      clientInfo: { name: 'confirmation-test', version: '1' },
    },
  });
  expect(response.status).toBe(200);
  session = response.headers.get('Mcp-Session-Id') ?? '';
  for await (const message of messages(response)) {
    if (message.id === 1) expect(message.result?.protocolVersion).toBe(revision);
  }
  const initialized = await post({ method: 'notifications/initialized' });
  await initialized.body?.cancel();
  return post;
}

const args = {
  audienceId: 'audience-1',
  subject: 'Test newsletter',
  fromName: 'Test',
  replyTo: 'test@example.com',
  content: { html: '<p>Test</p>' },
  mode: 'send',
  confirmSend: true,
};

beforeAll(async () => {
  upstream = createServer((request, response) => {
    upstreamCalls++;
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (request.method !== 'GET') mutations.push(`${request.method} ${path}`);
    if (path.endsWith('/actions/schedule')) {
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        scheduleBody += chunk;
      });
      request.on('end', () => response.writeHead(204).end());
      return;
    }
    if (path.endsWith('/actions/send') || request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    const body =
      path === '/ping'
        ? { health_status: 'ok' }
        : path.startsWith('/lists/')
          ? { id: 'audience-1', name: 'Readers', stats: { member_count: 3 } }
          : path.endsWith('/send-checklist')
            ? { is_ready: true, items: [] }
            : path.endsWith('/content')
              ? { html: draftBody }
              : {
                  id: path === '/campaigns/draft-2' ? 'draft-2' : 'draft-1',
                  type: 'regular',
                  status: mutations.some((m) => m.endsWith('/actions/send')) ? 'sent' : draftStatus,
                  settings: { subject_line: draftSubject },
                  recipients: {
                    list_name: 'Readers',
                    segment_opts: { saved_segment_id: 17 },
                    recipient_count: 2,
                  },
                };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  endpoint = `http://127.0.0.1:${port}/mcp`;
  child = launch(port, undefined);
  child.stdout!.on('data', (data) => {
    output += data.toString();
  });
  child.stderr!.on('data', (data) => {
    output += data.toString();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      /* Wait for the listener. */
    }
    await delay(25);
  }
  throw new Error(`HTTP server did not start: ${output}`);
}, 10_000);

afterAll(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

describe('HTTP existing draft actions', () => {
  async function call(args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'mailchimp_campaigns',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'mailchimp_campaigns',
          arguments: { campaignId: 'draft-1', ...args },
          ...extra,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'confirmation-test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
          },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    for await (const message of messages(response)) {
      if (message.id === 23) return message.result;
    }
    throw new Error('No MCP result received for the draft action');
  }

  function answer(
    asked: Record<string, unknown> | undefined,
    action: 'accept' | 'decline' | 'cancel',
  ) {
    return {
      requestState: asked?.requestState,
      inputResponses: {
        campaignDispatchConfirmation:
          action === 'accept' ? { action, content: { confirmed: true } } : { action },
      },
    };
  }

  it.each([
    [{ operation: 'send', confirmSend: true }, 'POST /campaigns/draft-1/actions/send'],
    [
      { operation: 'send', confirmSend: true, campaignId: 'draft-2' },
      'POST /campaigns/draft-2/actions/send',
    ],
    [
      { operation: 'schedule', confirmSend: true, scheduleTime: '2099-01-01T00:15:00Z' },
      'POST /campaigns/draft-1/actions/schedule',
    ],
    [{ operation: 'delete' }, 'DELETE /campaigns/draft-1'],
  ])('performs exactly one approved by-ID action for %j', async (args, mutation) => {
    mutations = [];
    scheduleBody = '';
    const asked = await call(args);
    expect(asked?.resultType).toBe('input_required');
    expect(JSON.stringify(asked?.inputRequests)).toContain('Test newsletter');
    expect(JSON.stringify(asked?.inputRequests)).toContain('Readers');
    expect(JSON.stringify(asked?.inputRequests)).toContain('segment \\"17\\", 2 recipients');
    if ('scheduleTime' in args)
      expect(JSON.stringify(asked?.inputRequests)).toContain(args.scheduleTime);
    expect(mutations).toEqual([]);

    const accepted = await call(args, answer(asked, 'accept'));
    const campaignId = 'campaignId' in args ? args.campaignId : 'draft-1';
    expect(accepted?.structuredContent).toEqual({
      operation: args.operation,
      campaignId,
    });
    expect(JSON.stringify(accepted?.content)).toContain(`Campaign ID: \`${campaignId}\``);
    expect(mutations).toEqual([mutation]);
    if ('scheduleTime' in args)
      expect(JSON.parse(scheduleBody)).toEqual({ schedule_time: '2099-01-01T00:15:00Z' });
    await call(args, answer(asked, 'accept'));
    expect(mutations).toEqual([mutation]);
  });

  it.each(['decline', 'cancel'] as const)('leaves a draft after %s', async (action) => {
    mutations = [];
    const args = { operation: 'delete' };
    const result = await call(args, answer(await call(args), action));
    expect(result?.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'campaign_action_cancelled',
          recovery: { hint: 'Leave the existing draft as is or begin a new confirmation.' },
        },
      },
    });
    expect(JSON.stringify(result?.content)).toContain('campaign_action_cancelled');
    expect(mutations).toEqual([]);
  });

  it('asks again after the draft body changes and protects a draft that has since been scheduled', async () => {
    mutations = [];
    const send = { operation: 'send', confirmSend: true };
    const reviewed = await call(send);
    try {
      draftBody = '<p>Edited after approval was requested</p>';
      const changed = await call(send, answer(reviewed, 'accept'));
      expect(changed?.resultType).toBe('input_required');
      expect(changed?.requestState).not.toBe(reviewed?.requestState);
      expect(mutations).toEqual([]);

      const remove = { operation: 'delete' };
      const discard = await call(remove);
      draftStatus = 'schedule';
      const blocked = await call(remove, answer(discard, 'accept'));
      expect(blocked?.structuredContent).toMatchObject({
        error: { data: { reason: 'campaign_not_draft' } },
      });
      expect(mutations).toEqual([]);
    } finally {
      draftBody = '<p>Reviewed draft</p>';
      draftStatus = 'save';
    }
  });

  it('asks again if the reviewed subject changes before the approved send', async () => {
    mutations = [];
    const send = { operation: 'send', confirmSend: true };
    const reviewed = await call(send);
    expect(reviewed?.resultType).toBe('input_required');
    try {
      draftSubject = 'Edited subject after review';
      const changed = await call(send, answer(reviewed, 'accept'));
      expect(changed?.resultType).toBe('input_required');
      expect(changed?.requestState).not.toBe(reviewed?.requestState);
      expect(JSON.stringify(changed?.inputRequests)).toContain('Edited subject after review');
      expect(mutations).toEqual([]);
    } finally {
      draftSubject = args.subject;
    }
  });
});

describe('HTTP campaign confirmation', () => {
  it('spends one sealed 2026 consent across concurrent retries and rejects tampering', async () => {
    mutations = [];
    async function call(extra: Record<string, unknown> = {}) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'mailchimp_send_campaign',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 22,
          method: 'tools/call',
          params: {
            name: 'mailchimp_send_campaign',
            arguments: args,
            ...extra,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'confirmation-test', version: '1' },
              'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
            },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      let result: Record<string, unknown> | undefined;
      for await (const message of messages(response))
        if (message.id === 22)
          result = message.error ? { rpcError: message.error } : message.result;
      return result;
    }
    const inputResponses = {
      campaignDispatchConfirmation: { action: 'accept', content: { confirmed: true } },
    };
    const asked = await call({ inputResponses });
    expect(asked?.resultType).toBe('input_required');
    expect(mutations).toEqual([]);
    const results = await Promise.all([
      call({ requestState: asked?.requestState, inputResponses }),
      call({ requestState: asked?.requestState, inputResponses }),
    ]);
    const completed = results.filter((result) => result?.structuredContent);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.structuredContent).toMatchObject({ campaignId: 'draft-1', mode: 'send' });
    expect(JSON.stringify(completed[0]?.content)).toContain('Campaign send');
    expect(mutations.filter((entry) => entry === 'POST /campaigns')).toHaveLength(1);
    expect(mutations.filter((entry) => entry.endsWith('/actions/send'))).toHaveLength(1);
    expect((await call({ requestState: asked?.requestState, inputResponses }))?.resultType).toBe(
      'input_required',
    );
    const before = upstreamCalls;
    const tampered = await call({ requestState: 'not-server-issued', inputResponses });
    expect(tampered?.rpcError).toMatchObject({
      code: -32602,
      data: { reason: 'invalid_request_state' },
    });
    expect(upstreamCalls).toBe(before);
  });
  it.each(['accept', 'decline'] as const)(
    'handles a 2025 form %s before mutation',
    async (action) => {
      mutations = [];
      const post = await connect({ elicitation: { form: {} } });
      const response = await post({
        id: 2,
        method: 'tools/call',
        params: { name: 'mailchimp_send_campaign', arguments: args },
      });
      let asked = false;
      let result: Record<string, unknown> | undefined;
      for await (const message of messages(response)) {
        if (message.method === 'elicitation/create') {
          asked = true;
          expect(mutations).toEqual([]);
          const accepted = await post({
            id: message.id!,
            result: action === 'accept' ? { action, content: { confirmed: true } } : { action },
          });
          await accepted.body?.cancel();
        }
        if (message.id === 2) {
          result = message.result;
          break;
        }
      }
      expect(asked).toBe(true);
      expect(result?.isError).not.toBe(true);
      expect(result?.structuredContent).toMatchObject({
        mode: action === 'accept' ? 'send' : 'draft',
        campaignId: 'draft-1',
      });
      expect(JSON.stringify(result?.content)).toContain(
        action === 'accept' ? 'Campaign send' : 'Send cancelled',
      );
      expect(mutations.includes('POST /campaigns/draft-1/actions/send')).toBe(action === 'accept');
    },
  );

  it('refuses a 2025 client without elicitation on both output surfaces', async () => {
    mutations = [];
    const post = await connect({});
    const response = await post({
      id: 2,
      method: 'tools/call',
      params: { name: 'mailchimp_send_campaign', arguments: args },
    });
    let result: Record<string, unknown> | undefined;
    for await (const message of messages(response)) {
      if (message.id !== 2) continue;
      result = message.result;
    }
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({
      error: { code: -32600, data: { reason: 'client_capability_missing' } },
    });
    expect(JSON.stringify(result?.content)).toContain('elicitation.form');
    expect(JSON.stringify(result?.content)).toContain('Reconnect');
    expect(JSON.stringify(result)).not.toContain('argument');
    for (const field of ['originalStack', 'causeChain', 'tenantId', 'inputResponses']) {
      expect(JSON.stringify(result)).not.toContain(`"${field}"`);
    }
    expect(mutations).toEqual([]);
    expect(result?.structuredContent).toMatchObject({
      error: { data: { requestId: expect.any(String) } },
    });
  });

  it('repairs stringified content and integer audience IDs before confirmation', async () => {
    mutations = [];
    const post = await connect({});
    const response = await post({
      id: 2,
      method: 'tools/call',
      params: {
        name: 'mailchimp_send_campaign',
        arguments: { ...args, audienceId: 123, content: JSON.stringify(args.content) },
      },
    });
    let result: Record<string, unknown> | undefined;
    for await (const message of messages(response)) {
      if (message.id === 2) result = message.result;
    }
    expect(result?.structuredContent).toMatchObject({
      error: { code: -32600, data: { reason: 'client_capability_missing' } },
    });
    expect(JSON.stringify(result?.content)).toContain('elicitation.form');
    expect(mutations).toEqual([]);
  });

  it.each([true, 1.5])(
    'rejects an unrepairable audience ID %s before upstream work',
    async (audienceId) => {
      mutations = [];
      const post = await connect({});
      const callsBefore = upstreamCalls;
      const response = await post({
        id: 2,
        method: 'tools/call',
        params: { name: 'mailchimp_send_campaign', arguments: { ...args, audienceId } },
      });
      let result: Record<string, unknown> | undefined;
      for await (const message of messages(response)) {
        if (message.id === 2) result = message.result;
      }
      expect(result?.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(JSON.stringify(result?.content)).toContain('audienceId');
      expect(upstreamCalls).toBe(callsBefore);
      expect(mutations).toEqual([]);
    },
  );

  it('preserves the 2026 input-required round without mutation', async () => {
    mutations = [];
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'mailchimp_send_campaign',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'mailchimp_send_campaign',
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'confirmation-test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
          },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    let result: Record<string, unknown> | undefined;
    for await (const message of messages(response)) {
      if (message.id === 2) result = message.result;
    }
    expect(result).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        campaignDispatchConfirmation: { method: 'elicitation/create' },
      },
    });
    expect(mutations).toEqual([]);
  });

  it('allows stateless configuration on stdio', async () => {
    const stdio = launch(3010, 'stateless', 'stdio');
    try {
      const initialized = new Promise<Rpc>((resolve, reject) => {
        let buffer = '';
        stdio.stdout!.on('data', (data) => {
          buffer += data.toString();
          const line = buffer.split('\n').find((line) => line.startsWith('{'));
          if (line) resolve(JSON.parse(line) as Rpc);
        });
        stdio.on('error', reject);
        stdio.on('exit', () => reject(new Error('stdio exited before initialization')));
      });
      stdio.stdin!.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        })}\n`,
      );
      expect((await initialized).result?.protocolVersion).toBe('2025-11-25');
    } finally {
      if (stdio.exitCode === null) {
        stdio.kill('SIGTERM');
        await once(stdio, 'exit');
      }
    }
  });

  it('rejects stateless HTTP before contacting Mailchimp', async () => {
    const callsBefore = upstreamCalls;
    const rejected = launch(3010, 'stateless');
    let stderr = '';
    rejected.stderr!.on('data', (data) => {
      stderr += data.toString();
    });
    const [code] = await once(rejected, 'exit');
    expect(code).not.toBe(0);
    expect(stderr).toContain('stateful');
    expect(stderr).toContain('stateless');
    expect(upstreamCalls).toBe(callsBefore);
  });
});
