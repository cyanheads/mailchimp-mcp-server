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

/**
 * `scripts/lint-packaging.ts` holds a repo-only dynamic import that `tsc`
 * cannot resolve in this server (cyanheads/mcp-ts-core#797), so it is loaded by
 * URL at run time, outside the typechecked import graph.
 */
const lintPackaging: {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries: (entries: string[], label: string) => string[];
} = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);

const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-lib/lib/skills/loader.js',
  'node_modules/some-lib/dist/SKILL.md',
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
  'node_modules/a/node_modules/@scope/b/skills/c/SKILL.md',
];

describe('bundle agent-doc selection', () => {
  it('uses one rule in the cleaner and the packaging check', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(CLEANER_RULE.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(CLEANER_RULE.flags);
  });

  it.each(runtimeEntries)('keeps %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(lintPackaging.checkBundleEntries([entry], 'bundle')).toEqual([]);
  });

  it.each(agentDocEntries)('strips %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(lintPackaging.checkBundleEntries([entry], 'bundle')).toHaveLength(1);
  });
});
