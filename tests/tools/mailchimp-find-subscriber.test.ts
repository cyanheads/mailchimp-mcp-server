/**
 * @fileoverview Subscriber tag enrichment success, failure and cancellation contracts.
 * @module tests/tools/mailchimp-find-subscriber.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { mailchimpFindSubscriberTool as find } from '@/mcp-server/tools/definitions/mailchimp-find-subscriber.tool.js';
import { MEMBER, reportFixture, reportText as text } from '../helpers/report-fixture.js';

describe('subscriber tag reads (#31)', () => {
  const fixture = reportFixture();

  it('keeps a successful empty tag list and skips tag I/O when disabled', async () => {
    fixture.route((path) =>
      Response.json(
        path.includes('search-members')
          ? { exact_matches: { members: [MEMBER] }, full_search: { members: [] } }
          : { tags: [], total_items: 0 },
      ),
    );
    const withTags = await runToolContract(find, { email: 'ada' });
    expect(withTags.structuredContent).toMatchObject({ exactMatches: [{ tags: [] }] });
    expect(text(withTags)).toContain('ada@example.com');
    fixture.paths.length = 0;
    const withoutTags = await runToolContract(find, { email: 'ada', includeTags: false });
    expect(withoutTags.structuredContent).not.toHaveProperty('exactMatches.0.tags');
    expect(fixture.paths).toEqual(['/3.0/search-members']);
  });
  it.each([401, 403, 404, 429, 500, 503])(
    'find reads propagate HTTP %s rather than successful emptiness',
    async (status) => {
      fixture.route((path) => {
        if (path.includes('search-members'))
          return Response.json({
            exact_matches: { members: [MEMBER] },
            full_search: { members: [] },
          });
        return Response.json({ title: 'Upstream failure' }, { status });
      });
      const result = await runToolContract(find, { email: 'ada' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toHaveProperty('error');
      expect(text(result)).toContain(String(status));
      if (status === 429) {
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.RateLimited, data: { reason: 'mailchimp_rate_limited' } },
        });
        expect(text(result)).toContain('mailchimp_rate_limited');
      }
    },
  );
  it('caller cancellation escapes the find handler itself', async () => {
    let controller = new AbortController();
    fixture.route((path, init) => {
      if (path.includes('search-members'))
        return Response.json({ exact_matches: { members: [MEMBER] } });
      controller.abort(new DOMException('Stop report enrichment', 'AbortError'));
      return Promise.reject(init?.signal?.reason);
    });
    const ctx = createMockContext({ signal: controller.signal, errors: find.errors });
    await expect(find.handler(find.input.parse({ email: 'ada' }), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: expect.stringContaining('was aborted.'),
      data: { reason: 'request_cancelled', errorSource: 'FetchAborted' },
    });
    expect(controller.signal.aborted).toBe(true);
    controller = new AbortController();
    const result = await runToolContract(
      find,
      { email: 'ada' },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RequestCancelled,
        message: expect.stringContaining('was aborted.'),
      },
    });
    expect(text(result)).toContain('was aborted.');
  });
});
