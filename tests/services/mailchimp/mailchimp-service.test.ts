/**
 * @fileoverview Unit tests for the Mailchimp service — HTTP layer, error
 * classification, retry behavior, and the pure `mailchimpMemberHash` helper.
 * Stubs `fetch` globally per test so nothing hits the network.
 * @module tests/services/mailchimp/mailchimp-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { MailchimpService, mailchimpMemberHash } from '@/services/mailchimp/mailchimp-service.js';

const BASE_CONFIG: ServerConfig = {
  apiKey: 'abcdef0123456789abcdef0123456789-us22',
  baseUrl: 'https://us22.api.mailchimp.com/3.0',
  timeoutMs: 1_000,
  maxRetries: 0,
  concurrencyLimit: 4,
  dataCenter: 'us22',
};

function makeService(overrides: Partial<ServerConfig> = {}): MailchimpService {
  return new MailchimpService({ ...BASE_CONFIG, ...overrides });
}

/** Build a `Response`-like object for the fetch stub. */
function fakeResponse(status: number, body: unknown = ''): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const res = new Response(text, {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' },
  });
  return res;
}

describe('mailchimpMemberHash', () => {
  it('produces MD5-lowercase for a canonical email', () => {
    // Reference hash for "user@example.com" — stable since the helper
    // lowercases + trims before hashing.
    expect(mailchimpMemberHash('user@example.com')).toBe('b58996c504c5638798eb6b511e6f49af');
  });

  it('lowercases before hashing', () => {
    expect(mailchimpMemberHash('User@Example.COM')).toBe(mailchimpMemberHash('user@example.com'));
  });

  it('trims surrounding whitespace', () => {
    expect(mailchimpMemberHash('  user@example.com  ')).toBe(
      mailchimpMemberHash('user@example.com'),
    );
  });
});

describe('MailchimpService.request', () => {
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed JSON on a 200 response', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(200, { ok: true, value: 42 }));
    const svc = makeService();
    const result = await svc.request<{ ok: boolean; value: number }>('GET', '/');
    expect(result).toEqual({ ok: true, value: 42 });
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('returns undefined on 204 No Content', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(204, ''));
    const svc = makeService();
    const result = await svc.request('DELETE', '/campaigns/abc');
    expect(result).toBeUndefined();
  });

  it('returns undefined on empty 2xx body', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(200, ''));
    const svc = makeService();
    const result = await svc.request('GET', '/');
    expect(result).toBeUndefined();
  });

  it('appends query params (including comma-joined arrays) to the URL', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(200, { ok: true }));
    const svc = makeService();
    await svc.request('GET', '/lists', {
      query: { count: 25, fields: ['id', 'name'], skip: undefined },
    });
    const calledUrl = String(fetchStub.mock.calls[0]?.[0]);
    expect(calledUrl).toBe('https://us22.api.mailchimp.com/3.0/lists?count=25&fields=id%2Cname');
  });

  it('classifies 401 as Unauthorized with a key-check hint', async () => {
    fetchStub.mockResolvedValueOnce(
      fakeResponse(401, { title: 'API Key Invalid', detail: 'Your key is wrong.' }),
    );
    const svc = makeService();
    await expect(svc.request('GET', '/')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      message: expect.stringContaining('MAILCHIMP_API_KEY'),
    });
  });

  it('classifies 403 with paid-feature body as Forbidden + requiresPlan', async () => {
    fetchStub.mockResolvedValueOnce(
      fakeResponse(403, {
        title: 'Forbidden',
        detail: 'This feature is only available to Premium plans.',
      }),
    );
    const svc = makeService();
    await expect(svc.request('GET', '/reports/x')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { requiresPlan: 'premium' },
    });
  });

  it('classifies 403 with standard-plan marker as requiresPlan: standard', async () => {
    fetchStub.mockResolvedValueOnce(
      fakeResponse(403, {
        title: 'Forbidden',
        detail: 'Only available to Standard and higher plans.',
      }),
    );
    const svc = makeService();
    await expect(svc.request('GET', '/x')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { requiresPlan: 'standard' },
    });
  });

  it('classifies 404 as NotFound', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(404, { title: 'Missing' }));
    const svc = makeService();
    await expect(svc.request('GET', '/x')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('classifies 422 as ValidationError', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(422, { title: 'Bad input' }));
    const svc = makeService();
    await expect(svc.request('POST', '/members')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('surfaces Mailchimp `errors[]` field entries in the error message', async () => {
    fetchStub.mockResolvedValueOnce(
      fakeResponse(400, {
        title: 'Invalid Resource',
        detail:
          "The resource submitted could not be validated. For field-specific details, see the 'errors' array.",
        errors: [
          { field: 'members_to_add.0.email_address', message: 'must be subscribed' },
          { field: 'members_to_remove.0', message: 'not a member of this segment' },
        ],
      }),
    );
    const svc = makeService();
    await expect(svc.request('POST', '/lists/abc/segments/1')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('members_to_add.0.email_address: must be subscribed'),
      data: {
        upstream: {
          errors: expect.arrayContaining([
            expect.objectContaining({ field: 'members_to_remove.0' }),
          ]),
        },
      },
    });
  });

  it('omits the `Field errors` suffix when `errors[]` is absent or empty', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(400, { title: 'Bad', detail: 'generic failure' }));
    const svc = makeService();
    await expect(svc.request('POST', '/x')).rejects.toMatchObject({
      message: expect.not.stringContaining('Field errors:'),
    });
  });

  it('classifies 429 as RateLimited', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(429, { title: 'Too many requests' }));
    const svc = makeService({ maxRetries: 0 });
    await expect(svc.request('GET', '/')).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });
  });

  it('classifies 500 as ServiceUnavailable', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(500, { title: 'Internal error' }));
    const svc = makeService({ maxRetries: 0 });
    await expect(svc.request('GET', '/')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('wraps a non-JSON 2xx body (maintenance page) as ServiceUnavailable', async () => {
    fetchStub.mockResolvedValueOnce(
      new Response('<html>oops</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const svc = makeService();
    await expect(svc.request('GET', '/')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('non-JSON'),
    });
  });

  it('wraps a caller-aborted request as Timeout', async () => {
    const controller = new AbortController();
    fetchStub.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const svc = makeService({ maxRetries: 0 });
    await expect(
      svc.request('GET', '/', { signal: controller.signal, noRetry: true }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
  });

  it('honors `noRetry: true` (does not call fetch more than once on a 5xx)', async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse(500, { title: 'boom' }));
    const svc = makeService({ maxRetries: 3 });
    await expect(svc.request('POST', '/campaigns', { noRetry: true })).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});
