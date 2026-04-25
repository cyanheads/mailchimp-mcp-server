/**
 * @fileoverview Local-template orchestrator. Walks `MAILCHIMP_TEMPLATES_DIR`,
 * resolves `<name>.eta` template files (with partials via Eta's `include()`),
 * loads optional `<name>.meta.yaml` sidecars for default subject / preview
 * text, and renders templates with caller-supplied variables. The canonical
 * write path for templates on free-tier Mailchimp accounts (where the upstream
 * templates API is read-only). Singleton init/accessor pattern.
 * @module services/templates/template-service
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { Context } from '@cyanheads/mcp-ts-core';
import { forbidden, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { logger as globalLogger, yamlParser } from '@cyanheads/mcp-ts-core/utils';
import { Eta } from 'eta';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, err?: unknown, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warning(msg: string, ctx?: Record<string, unknown>): void;
}

/** Source extension for templates. Sidecar metadata is `<name>.meta.yaml`. */
export const TEMPLATE_EXT = '.eta';
export const META_EXT = '.meta.yaml';

export interface TemplateMeta {
  /** Default preview / preheader text. */
  previewText?: string;
  /** Default subject line (overridable by tool input). */
  subject?: string;
  /**
   * Declared variable names — purely informational. Render does NOT enforce
   * a schema; missing vars surface as Eta render errors with a clear hint.
   */
  vars?: string[];
}

export interface TemplateSummary {
  /** Whether a `<name>.meta.yaml` sidecar was found. */
  hasMeta: boolean;
  /** Template name without extension, slash-separated for nested templates. */
  name: string;
  /** Path relative to templatesDir. */
  relPath: string;
  /** Body file size in bytes. */
  size: number;
}

export interface TemplateDetail extends TemplateSummary {
  /** Parsed sidecar metadata, if present. */
  meta?: TemplateMeta;
  /** Raw `.eta` source. */
  source: string;
}

export interface RenderResult {
  /** Rendered HTML body. */
  html: string;
  /** Preview text from meta.yaml, if any. */
  previewText?: string;
  /** Subject from meta.yaml, if any (caller decides whether to use it). */
  subject?: string;
}

export class TemplateService {
  private readonly eta: Eta;

  constructor(private readonly templatesDir: string) {
    this.eta = new Eta({
      views: templatesDir,
      cache: false,
      autoEscape: false,
      autoTrim: false,
    });
  }

  get directory(): string {
    return this.templatesDir;
  }

  /** Resolve a template name (no extension) to its absolute body path, with traversal guard. */
  private resolveBodyPath(name: string): string {
    if (!name || name.startsWith('/') || name.includes('\0') || name.endsWith(TEMPLATE_EXT)) {
      throw validationError(
        `Invalid template name '${name}'. Use the bare name without the .eta extension (e.g. 'welcome' or 'newsletters/april').`,
      );
    }
    const abs = resolve(this.templatesDir, `${name}${TEMPLATE_EXT}`);
    const dirWithSep = this.templatesDir.endsWith(sep)
      ? this.templatesDir
      : `${this.templatesDir}${sep}`;
    if (!abs.startsWith(dirWithSep)) {
      throw forbidden(`Template path escapes MAILCHIMP_TEMPLATES_DIR: '${name}'.`);
    }
    return abs;
  }

  /** Walk the templates directory and return one summary per `.eta` file. Partials are not excluded — they're templates too, and listing them is informative. */
  async list(): Promise<TemplateSummary[]> {
    const templates: { abs: string; rel: string; size: number }[] = [];
    const metaPaths = new Set<string>();

    const walk = async (current: string): Promise<void> => {
      const dirents = await readdir(current, { withFileTypes: true });
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        const abs = join(current, dirent.name);
        if (dirent.isDirectory()) {
          await walk(abs);
        } else if (dirent.isFile()) {
          if (extname(dirent.name) === TEMPLATE_EXT) {
            const st = await stat(abs);
            templates.push({
              abs,
              rel: relative(this.templatesDir, abs).split(sep).join('/'),
              size: st.size,
            });
          } else if (dirent.name.endsWith(META_EXT)) {
            metaPaths.add(abs);
          }
        }
      }
    };

    await walk(this.templatesDir);

    return templates
      .map((t) => ({
        name: t.rel.slice(0, -TEMPLATE_EXT.length),
        relPath: t.rel,
        size: t.size,
        hasMeta: metaPaths.has(t.abs.slice(0, -TEMPLATE_EXT.length) + META_EXT),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Get one template's source and parsed meta. Throws if the body file is missing. */
  async get(name: string): Promise<TemplateDetail> {
    const bodyPath = this.resolveBodyPath(name);
    let source: string;
    try {
      source = await readFile(bodyPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw notFound(
          `Template '${name}' not found at '${relative(this.templatesDir, bodyPath)}'.`,
        );
      }
      throw err;
    }
    const st = await stat(bodyPath);
    const metaPath = `${bodyPath.slice(0, -TEMPLATE_EXT.length)}${META_EXT}`;
    let meta: TemplateMeta | undefined;
    try {
      const yaml = await readFile(metaPath, 'utf8');
      meta = await yamlParser.parse<TemplateMeta>(yaml);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return {
      name,
      relPath: relative(this.templatesDir, bodyPath).split(sep).join('/'),
      size: st.size,
      hasMeta: meta !== undefined,
      source,
      ...(meta ? { meta } : {}),
    };
  }

  /**
   * Render a template by name with the supplied vars. Eta's include() resolves
   * partials relative to `templatesDir`. Returns the rendered HTML plus any
   * subject / previewText from the optional meta sidecar (caller decides
   * whether to use them).
   */
  async render(name: string, vars: Record<string, unknown>): Promise<RenderResult> {
    const detail = await this.get(name);
    let html: string;
    try {
      const result = this.eta.renderString(detail.source, vars);
      html = typeof result === 'string' ? result : await result;
    } catch (err) {
      throw validationError(
        `Failed to render template '${name}': ${err instanceof Error ? err.message : String(err)}`,
        { name },
        { cause: err instanceof Error ? err : undefined },
      );
    }
    const out: RenderResult = { html };
    if (detail.meta?.subject) out.subject = detail.meta.subject;
    if (detail.meta?.previewText) out.previewText = detail.meta.previewText;
    return out;
  }

  /**
   * Pull a Mailchimp-hosted template (base or user) and write it to disk as a
   * starting point. Useful on free-tier where authoring upstream is forbidden
   * — read a starter, save locally, then iterate.
   */
  async seedFromMailchimp(
    ctx: Pick<Context, 'signal' | 'log'>,
    mailchimpTemplateId: number,
    localName: string,
  ): Promise<{ relPath: string; bytes: number }> {
    const bodyPath = this.resolveBodyPath(localName);
    const svc = getMailchimpService();
    const tmpl = await svc.templates.get(ctx, mailchimpTemplateId);
    /**
     * The /templates GET endpoint returns metadata only — the rendered HTML
     * isn't included on that response shape. Fall back to default-content,
     * which surfaces the section map for drag-and-drop templates and an
     * empty map for user-uploaded HTML templates. For the empty case we
     * write a stub explaining how to populate it.
     */
    const content = await svc.templates.defaultContent(ctx, mailchimpTemplateId).catch(() => null);
    const sections = content?.sections ?? {};
    const sectionKeys = Object.keys(sections);

    let body: string;
    /** Eta v4 doesn't accept `<%#` for comments. Use JS block comments inside an Eta code tag instead — they survive in the seeded source but render to nothing. */
    if (sectionKeys.length > 0) {
      const fragments = sectionKeys.map((k) => `<% /* section: ${k} */ %>\n${String(sections[k])}`);
      body = fragments.join('\n\n');
    } else {
      body = `<% /* Seeded from Mailchimp template ${tmpl.id} (${JSON.stringify(tmpl.name)}). */ %>\n<% /* This template returned no default-content sections (typical for user-uploaded HTML templates that use mc:edit). Populate the body below. */ %>\n<h1><%= it.title %></h1>\n<p><%= it.body %></p>\n`;
    }

    await writeFile(bodyPath, body, 'utf8');
    const metaPath = `${bodyPath.slice(0, -TEMPLATE_EXT.length)}${META_EXT}`;
    const metaYaml = `# Sidecar metadata for '${localName}'. All fields optional.\nsubject: ${JSON.stringify(tmpl.name)}\n`;
    await writeFile(metaPath, metaYaml, 'utf8');
    ctx.log.info('template seeded from Mailchimp', {
      mailchimpTemplateId: tmpl.id,
      localName,
      sections: sectionKeys.length,
    });
    return {
      relPath: relative(this.templatesDir, bodyPath).split(sep).join('/'),
      bytes: Buffer.byteLength(body, 'utf8'),
    };
  }
}

// ─── Init / accessor ─────────────────────────────────────────────────

let _service: TemplateService | undefined;

export async function initTemplateService(
  templatesDir: string,
  log: Logger = globalLogger,
): Promise<void> {
  /** Verify the directory exists before silently going live. */
  try {
    const st = await stat(templatesDir);
    if (!st.isDirectory()) {
      throw new Error(`MAILCHIMP_TEMPLATES_DIR points to a non-directory: ${templatesDir}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`MAILCHIMP_TEMPLATES_DIR does not exist: ${templatesDir}`);
    }
    throw err;
  }
  _service = new TemplateService(templatesDir);
  log.info('TemplateService initialized', { templatesDir });
}

export function getTemplateService(): TemplateService | undefined {
  return _service;
}

/** Test-only: inject a pre-built service. */
export function setTemplateServiceForTesting(service: TemplateService | undefined): void {
  _service = service;
}
