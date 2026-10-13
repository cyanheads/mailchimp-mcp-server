/**
 * @fileoverview Campaign content projection and checklist contract tests.
 * @module tests/tools/campaign-content.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailchimpCampaignsTool as tool } from '@/mcp-server/tools/definitions/mailchimp-campaigns.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';

const bodies = {
  html: ' <footer>*|UNSUB|*</footer>\r\n',
  plain_text: 'TEXT\r\nunsubscribe',
  archive_html: '<p>ARCHIVE</p>\n',
};
describe('campaign content', () => {
  let service: MailchimpService;
  beforeEach(() => {
    service = new MailchimpService({
      apiKey: 'abcdef0123456789abcdef0123456789-us22',
      baseUrl: 'https://example.invalid',
      timeoutMs: 1000,
      maxRetries: 0,
      concurrencyLimit: 4,
      dataCenter: 'us22',
    });
    setMailchimpServiceForTesting(service);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Response(
            JSON.stringify(init.method === 'PUT' ? JSON.parse(String(init.body)) : bodies),
          ),
      ),
    );
  });
  afterEach(() => {
    service.dispose();
    setMailchimpServiceForTesting(undefined);
    vi.unstubAllGlobals();
  });
  it('characterizes default bytes and set-content behavior', async () => {
    const result = await tool.handler(
      tool.input.parse({ operation: 'get-content', campaignId: 'c' }),
      createMockContext({ errors: tool.errors }),
    );
    expect(result.content).toEqual({
      html: bodies.html,
      plainText: bodies.plain_text,
      archiveHtml: bodies.archive_html,
    });
    const saved = await tool.handler(
      tool.input.parse({
        operation: 'set-content',
        campaignId: 'c',
        content: { html: bodies.html, plainText: bodies.plain_text },
      }),
      createMockContext({ errors: tool.errors }),
    );
    expect(saved.content).toEqual({ html: bodies.html, plainText: bodies.plain_text });
  });
  it('advertises only the callable checklist operation', () => {
    expect(tool.description).toContain('get-checklist');
    expect(tool.description).not.toContain('send-checklist');
    expect(tool.input.safeParse({ operation: 'send-checklist', campaignId: 'c' }).success).toBe(
      false,
    );
  });
  it('keeps get-checklist wired to the upstream send-checklist route', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"is_ready":true,"items":[]}'));
    const result = await runToolContract(tool, { operation: 'get-checklist', campaignId: 'c' });
    expect(result.structuredContent).toMatchObject({
      operation: 'get-checklist',
      checklist: { isReady: true, items: [] },
    });
    expect(JSON.stringify(result.content)).toContain('ready');
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain('/campaigns/c/send-checklist');
  });
  it.each(['html', 'plainText', 'archiveHtml', 'all'] as const)(
    'projects %s on both surfaces',
    async (variant) => {
      const result = await runToolContract(tool, {
        operation: 'get-content',
        campaignId: 'c',
        variant,
      });
      const expected = {
        html: bodies.html,
        plainText: bodies.plain_text,
        archiveHtml: bodies.archive_html,
      };
      expect(result.structuredContent).toEqual({
        operation: 'get-content',
        content: variant === 'all' ? expected : { [variant]: expected[variant] },
      });
      const text = JSON.stringify(result.content);
      for (const key of Object.keys(expected))
        expect(text.includes(key)).toBe(variant === 'all' || key === variant);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it('preserves omission for empty/sparse representations and rejects unknown variants', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"html":"","plain_text":"x"}'));
    const result = await runToolContract(tool, {
      operation: 'get-content',
      campaignId: 'c',
      variant: 'archiveHtml',
    });
    expect(result.structuredContent).toEqual({ operation: 'get-content', content: {} });
    expect(tool.input.safeParse({ operation: 'get-content', variant: 'bogus' }).success).toBe(
      false,
    );
  });
});
