/**
 * @fileoverview The bundle cleaner and the packaging check select the same
 * dependency agent docs, and neither selects runtime modules that live under a
 * nested `skills/` directory (the MCP SDK's `dist/ext/skills/`).
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEANER_RULE,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';
import {
  checkBundleEntries,
  AGENT_DOC_ENTRY as PACKAGING_RULE,
} from '../../scripts/lint-packaging.js';

const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-lib/lib/skills/loader.js',
  'node_modules/@scope/skills/index.js',
  'node_modules/skills-kit/index.js',
  'dist/index.js',
];

const agentDocEntries = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/some-lib/skills/guide/SKILL.md',
  'node_modules/@scope/pkg/.claude/skills/x/SKILL.md',
  'node_modules/@scope/pkg/.agents/skills/x/SKILL.md',
  'node_modules/some-lib/SKILL.md',
  'node_modules/some-lib/dist/SKILL.md',
  'node_modules/some-lib/AGENTS.md',
  'node_modules/a/node_modules/@scope/b/skills/c/SKILL.md',
];

describe('bundle agent-doc selection', () => {
  it('uses one rule in the cleaner and the packaging check', () => {
    expect(PACKAGING_RULE.source).toBe(CLEANER_RULE.source);
    expect(PACKAGING_RULE.flags).toBe(CLEANER_RULE.flags);
  });

  it.each(runtimeEntries)('keeps %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(checkBundleEntries([entry], 'bundle')).toEqual([]);
  });

  it.each(agentDocEntries)('strips %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(checkBundleEntries([entry], 'bundle')).toHaveLength(1);
  });
});
