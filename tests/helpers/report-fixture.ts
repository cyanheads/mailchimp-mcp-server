/**
 * @fileoverview Real-service fixtures for report and subscriber read contracts.
 * @module tests/helpers/report-fixture
 */
import { afterEach, beforeEach, vi } from 'vitest';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';

export const SENT = { id: 'c1', send_time: '2026-04-20T12:00:00Z' };
export const ZERO = {
  ...SENT,
  emails_sent: 100,
  bounces: { hard_bounces: 0, soft_bounces: 0, syntax_errors: 0 },
  abuse_reports: 0,
  unsubscribed: 0,
  opens: { opens_total: 0, unique_opens: 0, open_rate: 0 },
  clicks: { clicks_total: 0, unique_clicks: 0, click_rate: 0 },
};
export const MEMBER = {
  id: 'h1',
  list_id: 'a1',
  email_address: 'ada@example.com',
  status: 'subscribed',
};

/** Plain text from all public content blocks. */
export const reportText = (r: { content: readonly { type: string; text?: string }[] }): string =>
  r.content.map((b) => b.text ?? '').join('\n');

/** Register this fixture inside a describe so existing suites keep their own setup. */
export function reportFixture() {
  let service: MailchimpService;
  const paths: string[] = [];
  beforeEach(() => {
    paths.length = 0;
    service = new MailchimpService({
      apiKey: 'abcdef0123456789abcdef0123456789-us22',
      dataCenter: 'us22',
      baseUrl: 'https://us22.api.mailchimp.com/3.0',
      timeoutMs: 10_000,
      maxRetries: 0,
      concurrencyLimit: 4,
    });
    setMailchimpServiceForTesting(service);
  });
  afterEach(() => {
    service.dispose();
    setMailchimpServiceForTesting(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  return {
    paths,
    /** Fake only fetch so retries, pacer, cancellation and status mapping remain real. */
    route(reply: (path: string, init?: RequestInit) => Response | Promise<Response>) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const path = new URL(url instanceof Request ? url.url : String(url)).pathname;
          paths.push(path);
          return reply(path, init);
        }),
      );
    },
  };
}
