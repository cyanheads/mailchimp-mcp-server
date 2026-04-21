/**
 * @fileoverview Regression tests for the `z.coerce.number()` swap across every
 * tool input schema that takes a numeric ID, page count, or offset. Before the
 * swap these fields used `z.number()` which rejected string inputs — a common
 * way MCP clients marshal integers over JSON-RPC, and the direct cause of a
 * user-visible "expected number, received string" failure on any tool with a
 * numeric parameter. These tests pin the behavior so it cannot silently
 * regress across tools, imports, or future schema edits.
 * @module tests/tools/input-coercion.test
 */

import { describe, expect, it } from 'vitest';
import { mailchimpAudiencesTool } from '@/mcp-server/tools/definitions/mailchimp-audiences.tool.js';
import { mailchimpCampaignsTool } from '@/mcp-server/tools/definitions/mailchimp-campaigns.tool.js';
import { mailchimpMergeFieldsTool } from '@/mcp-server/tools/definitions/mailchimp-merge-fields.tool.js';
import { mailchimpReplicateCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-replicate-campaign.tool.js';
import { mailchimpReportsTool } from '@/mcp-server/tools/definitions/mailchimp-reports.tool.js';
import { mailchimpSearchTool } from '@/mcp-server/tools/definitions/mailchimp-search.tool.js';
import { mailchimpSegmentsTool } from '@/mcp-server/tools/definitions/mailchimp-segments.tool.js';
import { mailchimpSendCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-send-campaign.tool.js';
import { mailchimpSubscribersTool } from '@/mcp-server/tools/definitions/mailchimp-subscribers.tool.js';
import { mailchimpTemplatesTool } from '@/mcp-server/tools/definitions/mailchimp-templates.tool.js';

describe('input-coercion regression suite', () => {
  it('templates: templateId/count/offset all accept strings', () => {
    const parsed = mailchimpTemplatesTool.input.parse({
      operation: 'get',
      templateId: '999',
      count: '50',
      offset: '10',
    });
    expect(parsed.templateId).toBe(999);
    expect(parsed.count).toBe(50);
    expect(parsed.offset).toBe(10);
  });

  it('merge-fields: mergeId/displayOrder/count/offset all accept strings', () => {
    const parsed = mailchimpMergeFieldsTool.input.parse({
      operation: 'get',
      audienceId: 'abc',
      mergeId: '17',
      displayOrder: '3',
      count: '100',
      offset: '20',
    });
    expect(parsed.mergeId).toBe(17);
    expect(parsed.displayOrder).toBe(3);
    expect(parsed.count).toBe(100);
    expect(parsed.offset).toBe(20);
  });

  it('segments: segmentId/count/offset all accept strings', () => {
    const parsed = mailchimpSegmentsTool.input.parse({
      operation: 'get',
      audienceId: 'abc',
      segmentId: '42',
      count: '25',
      offset: '5',
    });
    expect(parsed.segmentId).toBe(42);
    expect(parsed.count).toBe(25);
    expect(parsed.offset).toBe(5);
  });

  it('subscribers: noteId/count/offset all accept strings', () => {
    const parsed = mailchimpSubscribersTool.input.parse({
      operation: 'update-note',
      audienceId: 'abc',
      email: 'user@example.com',
      noteId: '7',
      note: 'hello',
      count: '30',
      offset: '15',
    });
    expect(parsed.noteId).toBe(7);
    expect(parsed.count).toBe(30);
    expect(parsed.offset).toBe(15);
  });

  it('reports: count/offset accept strings', () => {
    const parsed = mailchimpReportsTool.input.parse({
      operation: 'list',
      count: '40',
      offset: '80',
    });
    expect(parsed.count).toBe(40);
    expect(parsed.offset).toBe(80);
  });

  it('audiences: count/offset accept strings', () => {
    const parsed = mailchimpAudiencesTool.input.parse({
      operation: 'list',
      count: '12',
      offset: '24',
    });
    expect(parsed.count).toBe(12);
    expect(parsed.offset).toBe(24);
  });

  it('campaigns: count/offset + nested templateId and savedSegmentId accept strings', () => {
    const parsed = mailchimpCampaignsTool.input.parse({
      operation: 'create',
      type: 'regular',
      recipients: {
        listId: 'list1',
        savedSegmentId: '99',
      },
      settings: {
        subjectLine: 's',
        templateId: '555',
      },
      content: {
        templateId: '555',
      },
      count: '5',
      offset: '0',
    });
    expect(parsed.recipients?.savedSegmentId).toBe(99);
    expect(parsed.settings?.templateId).toBe(555);
    expect(parsed.content?.templateId).toBe(555);
    expect(parsed.count).toBe(5);
    expect(parsed.offset).toBe(0);
  });

  it('send-campaign: content.templateId and segmentId accept strings', () => {
    const parsed = mailchimpSendCampaignTool.input.parse({
      audienceId: 'list1',
      subject: 'hi',
      fromName: 'me',
      replyTo: 'me@example.com',
      segmentId: '100',
      content: {
        templateId: '777',
      },
    });
    expect(parsed.segmentId).toBe(100);
    expect(parsed.content.templateId).toBe(777);
  });

  it('replicate-campaign: contentOverride.templateId and segmentOverride accept strings', () => {
    const parsed = mailchimpReplicateCampaignTool.input.parse({
      sourceCampaignId: 'src',
      segmentOverride: '888',
      contentOverride: {
        templateId: '999',
      },
    });
    expect(parsed.segmentOverride).toBe(888);
    expect(parsed.contentOverride?.templateId).toBe(999);
  });

  it('search: includeTopN accepts strings', () => {
    const parsed = mailchimpSearchTool.input.parse({
      scope: 'members',
      query: 'anna',
      includeTopN: '25',
    });
    expect(parsed.includeTopN).toBe(25);
  });

  it('still rejects non-numeric strings', () => {
    expect(() =>
      mailchimpTemplatesTool.input.parse({ operation: 'get', templateId: 'abc' }),
    ).toThrow();
    expect(() =>
      mailchimpCampaignsTool.input.parse({
        operation: 'create',
        type: 'regular',
        recipients: { listId: 'l', savedSegmentId: 'xyz' },
      }),
    ).toThrow();
  });

  it('still enforces min/max on coerced numbers', () => {
    expect(() =>
      mailchimpTemplatesTool.input.parse({ operation: 'list', count: '5000' }),
    ).toThrow();
    expect(() =>
      mailchimpSearchTool.input.parse({
        scope: 'members',
        query: 'x',
        includeTopN: '0',
      }),
    ).toThrow();
  });
});
