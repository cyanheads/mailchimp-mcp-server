/**
 * @fileoverview Keep HTTP deployment defaults compatible with campaign confirmation.
 * @module tests/config/session-posture.test
 */
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

const { createApp } = vi.hoisted(() => ({ createApp: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core', async (original) => ({
  ...(await original<object>()),
  createApp,
}));

it('requires a durable HTTP session at every entry point', async () => {
  await import('@/index.js');
  expect(createApp.mock.calls[0]?.[0].sessionMode).toEqual({
    require: 'stateful',
  });
  expect(readFileSync('Dockerfile', 'utf8')).toContain('ENV MCP_SESSION_MODE="stateful"');
  expect(readFileSync('.env.example', 'utf8')).toMatch(/^MCP_SESSION_MODE=stateful\s/m);
});
