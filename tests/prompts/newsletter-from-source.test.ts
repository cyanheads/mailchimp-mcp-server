/**
 * @fileoverview Tests for the `newsletter_from_source` prompt. Prompts are
 * pure template functions — no service, no ctx. We verify that optional args
 * (`audienceId`, `seasonalContext`) shape the generated message text
 * conditionally, and that required scaffolding is always present.
 * @module tests/prompts/newsletter-from-source.test
 */

import { describe, expect, it } from 'vitest';
import { newsletterFromSourcePrompt } from '@/mcp-server/prompts/definitions/newsletter-from-source.prompt.js';

/** Pull the first text-content block from the generated messages. */
async function renderText(args: Record<string, unknown>): Promise<string> {
  const parsed =
    newsletterFromSourcePrompt.args === undefined
      ? ({} as never)
      : (newsletterFromSourcePrompt.args.parse(args) as never);
  const messages = await newsletterFromSourcePrompt.generate(parsed);
  const [first] = messages;
  if (!first || first.content.type !== 'text') {
    throw new Error('expected a text message block');
  }
  return first.content.text;
}

describe('newsletterFromSourcePrompt', () => {
  it('is registered with the expected name and args schema', () => {
    expect(newsletterFromSourcePrompt.name).toBe('newsletter_from_source');
    expect(newsletterFromSourcePrompt.args).toBeDefined();
  });

  it('generates a workflow with a single user-role message', async () => {
    const parsed = newsletterFromSourcePrompt.args?.parse({
      source: 'https://example.org',
    });
    const messages = await newsletterFromSourcePrompt.generate(parsed as never);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content.type).toBe('text');
  });

  it('always includes the source, workflow steps, and discipline notes', async () => {
    const text = await renderText({ source: 'https://example.org' });
    expect(text).toContain('**Source:** https://example.org');
    expect(text).toContain('**Workflow:**');
    expect(text).toContain('**Discipline:**');
    // All eight workflow steps should be present.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(text).toMatch(new RegExp(`^${n}\\. \\*\\*`, 'm'));
    }
  });

  it('falls back to a "not specified" audience line when audienceId is omitted', async () => {
    const text = await renderText({ source: 'a brief description' });
    expect(text).toContain('target audience is not specified');
    expect(text).toContain('(with the audience ID once confirmed)');
    expect(text).not.toMatch(/target audience is `[^`]+`/);
  });

  it('threads the audienceId into both the audience line and step 2', async () => {
    const text = await renderText({
      source: 'https://example.org',
      audienceId: 'abc123',
    });
    expect(text).toContain('target audience is `abc123`');
    expect(text).toContain("and `audienceId: 'abc123'`");
    expect(text).not.toContain('target audience is not specified');
  });

  it('adds a seasonal-context block only when provided', async () => {
    const without = await renderText({ source: 'brief' });
    expect(without).not.toContain('Seasonal / thematic context');

    const withSeason = await renderText({
      source: 'brief',
      seasonalContext: 'April spring planting',
    });
    expect(withSeason).toContain('**Seasonal / thematic context:** April spring planting');
  });

  it('rejects missing `source` at the schema level', () => {
    expect(() => newsletterFromSourcePrompt.args?.parse({})).toThrow();
  });
});
