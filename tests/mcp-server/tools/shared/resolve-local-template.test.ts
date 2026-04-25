/**
 * @fileoverview Tests for the shared `resolveLocalTemplate` helper. Covers
 * pass-through behavior, mutual-exclusion validation, the
 * service-not-configured path, and successful render returning content with
 * `localTemplate` cleared.
 * @module tests/mcp-server/tools/shared/resolve-local-template.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLocalTemplate } from '@/mcp-server/tools/shared/resolve-local-template.js';
import {
  setTemplateServiceForTesting,
  TemplateService,
} from '@/services/templates/template-service.js';

describe('resolveLocalTemplate', () => {
  it('passes through unchanged when localTemplate is not set', async () => {
    setTemplateServiceForTesting(undefined);
    const input = { html: '<p>x</p>', plainText: 'x' };
    const out = await resolveLocalTemplate(createMockContext(), input);
    expect(out).toEqual(input);
  });

  it('throws ConfigurationError when localTemplate is set but service is not configured', async () => {
    setTemplateServiceForTesting(undefined);
    await expect(
      resolveLocalTemplate(createMockContext(), { localTemplate: 'welcome' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining('MAILCHIMP_TEMPLATES_DIR'),
    });
  });

  describe('with template service configured', () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'resolve-local-template-'));
      await writeFile(join(dir, 'welcome.eta'), `<h1>Hi <%= it.firstName %></h1>`, 'utf8');
      setTemplateServiceForTesting(new TemplateService(dir));
      cleanup = async () => {
        await rm(dir, { recursive: true, force: true });
        setTemplateServiceForTesting(undefined);
      };
    });

    afterEach(async () => {
      await cleanup();
    });

    it('rejects localTemplate combined with html', async () => {
      await expect(
        resolveLocalTemplate(createMockContext(), {
          localTemplate: 'welcome',
          html: '<p>existing</p>',
        }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('mutually exclusive'),
      });
    });

    it('rejects localTemplate combined with templateId', async () => {
      await expect(
        resolveLocalTemplate(createMockContext(), {
          localTemplate: 'welcome',
          templateId: 12345,
        }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('mutually exclusive'),
      });
    });

    it('renders the template and clears the localTemplate fields', async () => {
      const out = await resolveLocalTemplate(createMockContext(), {
        localTemplate: 'welcome',
        localTemplateVars: { firstName: 'Casey' },
      });
      expect(out.html).toContain('Hi Casey');
      expect(out.localTemplate).toBeUndefined();
      expect(out.localTemplateVars).toBeUndefined();
    });

    it('preserves unrelated fields like plainText through resolution', async () => {
      const out = await resolveLocalTemplate(createMockContext(), {
        localTemplate: 'welcome',
        localTemplateVars: { firstName: 'A' },
        plainText: 'plain version',
      });
      expect(out.plainText).toBe('plain version');
      expect(out.html).toContain('Hi A');
    });
  });
});
