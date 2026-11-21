/**
 * @fileoverview CommonMark read-back for Mailchimp campaign and media text.
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailchimpAccountTool } from '@/mcp-server/tools/definitions/mailchimp-account.tool.js';
import { mailchimpAssetsTool } from '@/mcp-server/tools/definitions/mailchimp-assets.tool.js';
import { mailchimpCampaignReportTool } from '@/mcp-server/tools/definitions/mailchimp-campaign-report.tool.js';
import { mailchimpCampaignsTool } from '@/mcp-server/tools/definitions/mailchimp-campaigns.tool.js';
import { mailchimpFilesTool } from '@/mcp-server/tools/definitions/mailchimp-files.tool.js';
import { mailchimpLocalTemplatesTool } from '@/mcp-server/tools/definitions/mailchimp-local-templates.tool.js';
import { mailchimpPlaybookTool } from '@/mcp-server/tools/definitions/mailchimp-playbook.tool.js';
import { mailchimpReplicateCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-replicate-campaign.tool.js';
import { mailchimpSearchTool } from '@/mcp-server/tools/definitions/mailchimp-search.tool.js';
import { mailchimpSendCampaignTool } from '@/mcp-server/tools/definitions/mailchimp-send-campaign.tool.js';
import { mailchimpTemplatesTool } from '@/mcp-server/tools/definitions/mailchimp-templates.tool.js';
import {
  MailchimpService,
  setMailchimpServiceForTesting,
} from '@/services/mailchimp/mailchimp-service.js';

const parser = new MarkdownIt('commonmark');
const newsletter = 'Weekly *news* and `events`\r\n\r\n# Draft copy  \n';
const emphasis = 'The *weekend* edition';
const id = 'issue`27';
const url = 'https://example.test/news(q)?a=1&b=2';
const thumbnail = 'https://example.test/thumb(q).png';

function useMailchimpService() {
  setMailchimpServiceForTesting(
    new MailchimpService({
      apiKey: 'mailchimp-test-key',
      baseUrl: 'https://mailchimp.example.test/3.0',
      timeoutMs: 1_000,
      maxRetries: 0,
      concurrencyLimit: 1,
      dataCenter: 'us1',
    }),
  );
}

function read(blocks: { type: string; text?: string }[]) {
  const tokens = parser.parse(blocks[0]?.text ?? '', {});
  const inline = tokens.flatMap((token) => token.children ?? []);
  const visible = inline
    .filter(({ type }) => type === 'text' || type === 'code_inline')
    .map(({ content }) => content)
    .join('');
  return {
    tokens,
    inline,
    visible,
    urls: inline.filter(({ type }) => type === 'link_open').map((link) => link.attrGet('href')),
    images: inline.filter(({ type }) => type === 'image'),
  };
}

describe('newsletter Markdown results', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setMailchimpServiceForTesting(undefined);
  });

  it('keeps the existing plain account layout and activity link', () => {
    const out = read(
      mailchimpAccountTool.format!({
        operation: 'activity-feed',
        items: [{ type: 'send', updateTime: '2026-11-21', activity: 'Sent newsletter', url }],
      }),
    );
    expect(out.visible).toContain('Activity feed (1 of 1, offset 0)');
    expect(out.visible).toContain('Sent newsletter');
    expect(out.urls).toEqual([url]);
  });

  it('preserves account names and raw activity text inside the feed', () => {
    const out = read(
      mailchimpAccountTool.format!({
        operation: 'info',
        accountId: id,
        accountName: newsletter,
        items: [
          { type: 'send', updateTime: '2026-11-21', activity: newsletter, title: emphasis, url },
        ],
      }),
    );
    expect(out.visible).toContain(newsletter);
    expect(out.visible).toContain(emphasis);
    expect(out.inline.find(({ type }) => type === 'code_inline')?.content).toBe(id);
    expect(out.urls).toEqual([url]);
  });

  it('preserves both account feed surfaces at the cap and after the final page', async () => {
    useMailchimpService();
    const event = { type: 'send', update_time: '2026-11-21', activity: newsletter, url };
    const fetchStub = vi.fn(async (request: string) => {
      const endpoint = new URL(request);
      expect(endpoint.pathname).toBe('/3.0/activity-feed/chimp-chatter');
      expect(endpoint.searchParams.get('count')).toBe('100');
      const activity = endpoint.searchParams.get('offset') === '0' ? Array(100).fill(event) : [];
      return Response.json({ activity, total_items: 100 });
    });
    vi.stubGlobal('fetch', fetchStub);
    const page = await runToolContract(mailchimpAccountTool, {
      operation: 'activity-feed',
      count: 100,
    });
    expect(page.structuredContent).toMatchObject({
      items: Array.from({ length: 100 }, () => ({ activity: newsletter, url })),
    });
    expect(read(page.content).visible.split(newsletter)).toHaveLength(101);
    const end = await runToolContract(mailchimpAccountTool, {
      operation: 'activity-feed',
      count: 100,
      offset: 101,
    });
    expect(end.structuredContent).toMatchObject({ items: [], offset: 101, totalItems: 100 });
    expect(read(end.content).visible).toContain('Activity feed (0 of 100, offset 101)');
    const invalid = await runToolContract(mailchimpAccountTool, {
      operation: 'activity-feed',
      count: 101,
    });
    expect(invalid.isError).toBe(true);
    expect(read(invalid.content).visible).toContain('count');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('preserves nested report values and clicked link destinations', () => {
    const out = read(
      mailchimpCampaignReportTool.format!({
        campaignId: id,
        campaignTitle: newsletter,
        delivery: { bounces: {} },
        engagement: { opens: {}, clicks: {} },
        topClickedLinks: [{ url, totalClicks: 3, uniqueClicks: 2 }],
        topLocations: [{ countryCode: 'US', regionName: emphasis }],
        recentUnsubscribes: [{ email: 'reader@example.test', reason: newsletter }],
      }),
    );
    expect(out.visible.split(newsletter)).toHaveLength(3);
    expect(out.visible).toContain(emphasis);
    expect(out.urls).toEqual([url]);
  });

  it('keeps file and cache URLs clickable and thumbnails rendered as images', () => {
    const file = { id: 27, name: newsletter, fullSizeUrl: url, thumbnailUrl: thumbnail };
    const files = read(mailchimpFilesTool.format!({ operation: 'get', file }));
    expect(files.visible).toContain(newsletter);
    const assets = read(
      mailchimpAssetsTool.format!({
        operation: 'info',
        assetsDir: '/newsletter-assets',
        asset: {
          relPath: 'newsletter.png',
          sizeInBytes: 10,
          ext: '.png',
          isImage: true,
          sha256: 'abc',
          cached: {
            fileId: 27,
            fullSizeUrl: url,
            thumbnailUrl: thumbnail,
            uploadedAt: '2026-11-21',
          },
        },
      }),
    );
    for (const out of [files, assets]) {
      expect(out.urls).toEqual([url]);
      expect(out.visible).toContain(url);
      expect(out.images.map((image) => image.attrGet('src'))).toEqual([thumbnail]);
      expect(out.images[0]?.children?.map((child) => child.content).join('')).toBe('Thumbnail');
    }
  });

  it('preserves malformed file destinations as literal text', () => {
    const invalid = 'https://example.test/thumbnail\r\n# Draft copy  \n';
    const out = read(
      mailchimpFilesTool.format!({
        operation: 'get',
        file: { id: 27, name: 'Newsletter', fullSizeUrl: invalid, thumbnailUrl: invalid },
      }),
    );
    expect(out.visible.split(invalid)).toHaveLength(3);
    expect(out.urls).toEqual([]);
    expect(out.images).toEqual([]);
  });

  it('preserves template names, links and default section JSON', () => {
    const out = read(
      mailchimpTemplatesTool.format!({
        operation: 'get',
        template: { id: 27, name: newsletter, shareUrl: url, thumbnail },
      }),
    );
    expect(out.visible).toContain(newsletter);
    expect(out.urls).toEqual([url]);
    expect(out.images[0]?.attrGet('src')).toBe(thumbnail);
    const sections = { intro: `${newsletter}\`\`\`` };
    const rendered = read(
      mailchimpTemplatesTool.format!({
        operation: 'get-default-content',
        defaultContent: { sections },
      }),
    );
    const fence = rendered.tokens.find((token) => token.type === 'fence');
    expect(JSON.parse(fence?.content ?? '')).toEqual(sections);
  });

  it('recovers seeded template source and rendered output through the real fence parser', () => {
    const html = '<p>News</p>\r\n\x60\x60\x60\r\n# Draft copy';
    const source = 'subject: "Newsletter"\n\x60\x60\x60\n<p>News</p>\n';
    const get = read(
      mailchimpLocalTemplatesTool.format!({
        operation: 'get',
        templatesDir: '/tmp/templates',
        template: {
          name: 'newsletter',
          relPath: 'newsletter.eta',
          size: source.length,
          hasMeta: true,
          source,
          meta: { subject: newsletter },
        },
      }),
    );
    const preview = read(
      mailchimpLocalTemplatesTool.format!({
        operation: 'render-preview',
        templatesDir: '/tmp/templates',
        rendered: { name: 'newsletter', html, subject: newsletter },
      }),
    );
    expect(get.visible).toContain(newsletter);
    expect(preview.visible).toContain(newsletter);
    for (const [out, expected] of [
      [get, source],
      [preview, html],
    ] as const) {
      const fences = out.tokens.filter(({ type }) => type === 'fence');
      expect(fences).toHaveLength(1);
      const fence = fences[0];
      expect(fence?.info === 'json' ? JSON.parse(fence.content) : fence?.content).toBe(expected);
    }
  });

  it('keeps campaign search snippets and returned identifiers literal', () => {
    const out = read(
      mailchimpSearchTool.format!({
        scope: 'campaigns',
        query: 'news',
        campaigns: {
          totalMatches: 1,
          matches: [{ campaignId: id, title: emphasis, snippet: newsletter }],
        },
      }),
    );
    expect(out.visible).toContain(emphasis);
    expect(out.visible).toContain(newsletter);
    expect(
      out.inline.filter(({ type }) => type === 'code_inline').map(({ content }) => content),
    ).toContain(id);
  });

  it('preserves workflow checklist text and real campaign links', () => {
    const output = {
      campaignId: id,
      mode: 'draft' as const,
      status: 'save',
      subject: newsletter,
      archiveUrl: url,
      webUrl: url,
      checklistWarnings: [{ type: 'warning' as const, heading: emphasis, details: newsletter }],
    };
    for (const blocks of [
      mailchimpSendCampaignTool.format!(output),
      mailchimpReplicateCampaignTool.format!({
        ...output,
        sourceCampaignId: 'source`27',
        overridesApplied: [],
      }),
    ]) {
      const out = read(blocks);
      expect(out.visible.split(newsletter)).toHaveLength(3);
      expect(out.visible).toContain(emphasis);
      expect(out.urls).toEqual([url, url]);
      expect(
        out.inline.filter(({ type }) => type === 'code_inline').map(({ content }) => content),
      ).toContain(id);
    }
  });

  it('preserves a campaign summary and checklist without altering its JSON body', () => {
    const content = { plainText: newsletter, html: '<p>Draft</p>\r\n\x60\x60\x60' };
    const blocks = mailchimpCampaignsTool.format!({
      operation: 'get-content',
      campaignId: id,
      campaign: { id, subjectLine: newsletter, type: 'regular', status: 'save', archiveUrl: url },
      content,
      checklist: {
        isReady: true,
        items: [{ type: 'warning', heading: emphasis, details: newsletter }],
      },
    });
    const out = read(blocks);
    expect(out.visible.split(newsletter)).toHaveLength(4);
    expect(out.visible).toContain(emphasis);
    expect(out.urls).toEqual([url]);
    expect(JSON.parse(out.tokens.find(({ type }) => type === 'fence')?.content ?? '')).toEqual(
      content,
    );
  });

  it('keeps the raw audience name in playbook live state and literal in both Markdown surfaces', async () => {
    useMailchimpService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        expect(new URL(input).pathname).toBe('/3.0/lists/a1');
        return Response.json({ id: 'a1', name: newsletter, stats: { member_count: 42 } });
      }),
    );
    const result = await runToolContract(mailchimpPlaybookTool, {
      topic: 'list-hygiene',
      audienceId: 'a1',
    });
    const structured = mailchimpPlaybookTool.output?.parse(result.structuredContent);
    expect(structured?.liveState.audienceName).toBe(newsletter);
    const instructions = read([{ type: 'text', text: structured?.instructions ?? '' }]);
    const rendered = read(result.content);
    expect(instructions.visible).toContain(newsletter);
    expect(rendered.visible).toContain(newsletter);
    expect(rendered.visible).toContain('List hygiene');
    expect(rendered.visible).toContain('Archive chronically disengaged subscribers.');
  });
});
