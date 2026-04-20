/**
 * @fileoverview Service wrapping the Mailchimp Marketing API v3.0.
 * Owns request plumbing (basic auth, timeout, retry, cancellation) and
 * classifies upstream errors into framework error codes. Tool handlers
 * call grouped methods (`account.info()`, `campaigns.getChecklist()`, etc.)
 * and are not expected to know about HTTP.
 * @module services/mailchimp/mailchimp-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { logger as globalLogger, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  AbuseReport,
  AccountInfo,
  ActivityFeedResponse,
  Audience,
  AudienceLocation,
  BatchSubscribeResponse,
  BatchSubscribeRow,
  Campaign,
  CampaignChecklist,
  CampaignContent,
  CampaignReport,
  CampaignType,
  ClickDetail,
  EmailClient,
  GrowthHistoryEntry,
  LocationStat,
  MailchimpErrorBody,
  MailchimpErrorData,
  MergeField,
  OpenDetail,
  Paged,
  SearchCampaignsResponse,
  SearchMembersResponse,
  Segment,
  SegmentOptions,
  SignupForm,
  Subscriber,
  SubscriberActivityItem,
  SubscriberEvent,
  SubscriberGoal,
  SubscriberNote,
  SubscriberStatus,
  SubscriberTag,
  Template,
  TemplateDefaultContent,
  Unsubscribed,
} from '@/services/mailchimp/types.js';

interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, err?: unknown, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warning(msg: string, ctx?: Record<string, unknown>): void;
}

export interface RequestOptions {
  /** JSON body to send. */
  body?: unknown;
  /** Logger for upstream call annotation. */
  log?: Logger | undefined;
  /** Disable retry (use for destructive ops where idempotency isn't guaranteed). */
  noRetry?: boolean | undefined;
  /** URL query parameters — stringified and appended. Arrays are repeated per value. */
  query?: Record<string, string | number | boolean | string[] | undefined> | undefined;
  /** Request-scoped cancellation. */
  signal?: AbortSignal | undefined;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const PAID_FEATURE_MARKER = /only available to.*(paid|standard|premium|pro|plus)/i;

/** Compute MD5-lowercase of an email address — Mailchimp uses this as the member-hash URL segment. */
export function mailchimpMemberHash(email: string): string {
  return createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

export class MailchimpService {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly config: ServerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`mcp:${config.apiKey}`).toString('base64')}`;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
  }

  get dataCenter(): string {
    return this.config.dataCenter;
  }

  /** Build a full URL from a path + optional query. */
  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(
      path.startsWith('/') ? `${this.baseUrl}${path}` : `${this.baseUrl}/${path}`,
    );
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          if (value.length > 0) url.searchParams.set(key, value.join(','));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const log = opts.log ?? globalLogger;
    const fn = async (): Promise<T> => this.sendOnce<T>(method, url, opts, log);
    if (opts.noRetry) return fn();
    const retryOpts: Parameters<typeof withRetry>[1] = {
      operation: `mailchimp:${method} ${path}`,
      maxRetries: this.maxRetries,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
    };
    if (opts.signal) retryOpts.signal = opts.signal;
    return withRetry(fn, retryOpts);
  }

  /** Single HTTP attempt — all classification happens here. */
  private async sendOnce<T>(
    method: HttpMethod,
    url: string,
    opts: RequestOptions,
    log: Logger,
  ): Promise<T> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const signal = mergeSignals(opts.signal, timeoutController.signal);

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'User-Agent': 'mailchimp-mcp-server',
    };
    const init: RequestInit = { method, headers, signal };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (opts.signal?.aborted) {
        throw timeout('Request cancelled by caller.', { url, method }, { cause: err });
      }
      if (timeoutController.signal.aborted) {
        throw serviceUnavailable(
          `Mailchimp request timed out after ${this.timeoutMs}ms (${method} ${url}).`,
          { url, method, timeoutMs: this.timeoutMs },
          { cause: err },
        );
      }
      throw serviceUnavailable(
        `Network failure calling Mailchimp (${method} ${url}).`,
        { url, method },
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return undefined as T;

    const rawText = await res.text();
    if (res.ok) {
      if (rawText.length === 0) return undefined as T;
      try {
        return JSON.parse(rawText) as T;
      } catch (err) {
        throw serviceUnavailable(
          'Mailchimp returned a non-JSON successful response (likely a maintenance page).',
          { url, method, preview: rawText.slice(0, 200) },
          { cause: err },
        );
      }
    }

    // Non-2xx — classify.
    let body: MailchimpErrorBody | undefined;
    try {
      body = rawText.length > 0 ? (JSON.parse(rawText) as MailchimpErrorBody) : undefined;
    } catch {
      body = undefined;
    }
    const errorData = this.buildErrorData(res.status, body);
    const title = body?.title ?? res.statusText;
    const detail = body?.detail ?? 'No details from Mailchimp.';
    const message = `Mailchimp ${method} ${url} failed (${res.status} ${title}): ${detail}`;

    log.warning('Mailchimp upstream error', {
      url,
      method,
      status: res.status,
      title,
      detail: body?.detail,
    });

    throw this.classifyStatus(res.status, message, errorData);
  }

  private buildErrorData(status: number, body: MailchimpErrorBody | undefined): MailchimpErrorData {
    const data: MailchimpErrorData = { status };
    if (body) data.upstream = body;
    if (body?.type) data.type = body.type;
    if (body?.title) data.title = body.title;
    if (body?.detail) data.detail = body.detail;
    if (body?.instance) data.instance = body.instance;
    if (status === 403 && body?.detail && PAID_FEATURE_MARKER.test(body.detail)) {
      data.requiresPlan = /premium/i.test(body.detail) ? 'premium' : 'standard';
    }
    return data;
  }

  private classifyStatus(status: number, message: string, data: MailchimpErrorData): McpError {
    if (status === 401) {
      return unauthorized(
        `${message}. Check MAILCHIMP_API_KEY — the key may be invalid or revoked.`,
        data,
      );
    }
    if (status === 403) return forbidden(message, data);
    if (status === 404) return notFound(message, data);
    if (status === 422 || status === 400) return validationError(message, data);
    if (status === 429) return rateLimited(message, data);
    return serviceUnavailable(message, data);
  }

  // ─── Account ──────────────────────────────────────────────────────

  account = {
    info: (ctx?: Pick<Context, 'signal' | 'log'>): Promise<AccountInfo> =>
      this.request<AccountInfo>('GET', '/', {
        signal: ctx?.signal,
        log: ctx?.log,
      }),

    activityFeed: (
      ctx?: Pick<Context, 'signal' | 'log'>,
      params?: { count?: number; offset?: number },
    ): Promise<ActivityFeedResponse> =>
      this.request<ActivityFeedResponse>('GET', '/activity-feed/chimp-chatter', {
        signal: ctx?.signal,
        log: ctx?.log,
        query: params,
      }),

    ping: async (ctx?: Pick<Context, 'signal' | 'log'>): Promise<void> => {
      await this.request<{ health_status: string }>('GET', '/ping', {
        signal: ctx?.signal,
        log: ctx?.log,
      });
    },
  };

  // ─── Audiences (lists) ────────────────────────────────────────────

  audiences = {
    list: (
      ctx: Pick<Context, 'signal' | 'log'>,
      params?: { count?: number; offset?: number; fields?: string[]; excludeFields?: string[] },
    ): Promise<Paged<Audience> & { lists: Audience[] }> =>
      this.request('GET', '/lists', {
        signal: ctx.signal,
        log: ctx.log,
        query: {
          count: params?.count,
          offset: params?.offset,
          fields: params?.fields,
          exclude_fields: params?.excludeFields,
        },
      }),

    get: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { fields?: string[] },
    ): Promise<Audience> =>
      this.request('GET', `/lists/${id}`, {
        signal: ctx.signal,
        log: ctx.log,
        query: { fields: params?.fields },
      }),

    create: (ctx: Pick<Context, 'signal' | 'log'>, body: Partial<Audience>): Promise<Audience> =>
      this.request('POST', '/lists', { signal: ctx.signal, log: ctx.log, body }),

    update: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      body: Partial<Audience>,
    ): Promise<Audience> =>
      this.request('PATCH', `/lists/${id}`, { signal: ctx.signal, log: ctx.log, body }),

    listActivity: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number },
    ): Promise<{ activity: Array<Record<string, unknown>> }> =>
      this.request('GET', `/lists/${id}/activity`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    listGrowthHistory: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ history: GrowthHistoryEntry[]; total_items: number }> =>
      this.request('GET', `/lists/${id}/growth-history`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    listClients: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
    ): Promise<{ clients: EmailClient[]; total_items: number }> =>
      this.request('GET', `/lists/${id}/clients`, { signal: ctx.signal, log: ctx.log }),

    listAbuseReports: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ abuse_reports: AbuseReport[]; total_items: number }> =>
      this.request('GET', `/lists/${id}/abuse-reports`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    listLocations: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number },
    ): Promise<{ locations: AudienceLocation[]; total_items: number }> =>
      this.request('GET', `/lists/${id}/locations`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    getSignupForms: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
    ): Promise<{ signup_forms: SignupForm[]; total_items: number }> =>
      this.request('GET', `/lists/${id}/signup-forms`, { signal: ctx.signal, log: ctx.log }),

    customizeSignupForms: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      body: SignupForm,
    ): Promise<SignupForm> =>
      this.request('POST', `/lists/${id}/signup-forms`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
      }),
  };

  // ─── Subscribers (members) ────────────────────────────────────────

  subscribers = {
    list: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      params?: {
        count?: number;
        offset?: number;
        status?: SubscriberStatus;
        email?: string;
        fields?: string[];
      },
    ): Promise<{ members: Subscriber[]; total_items: number }> =>
      this.request('GET', `/lists/${listId}/members`, {
        signal: ctx.signal,
        log: ctx.log,
        query: {
          count: params?.count,
          offset: params?.offset,
          status: params?.status,
          email_address: params?.email,
          fields: params?.fields,
        },
      }),

    get: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
    ): Promise<Subscriber> =>
      this.request('GET', `/lists/${listId}/members/${memberHash}`, {
        signal: ctx.signal,
        log: ctx.log,
      }),

    update: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      body: Partial<Subscriber>,
      opts?: { skipMergeValidation?: boolean },
    ): Promise<Subscriber> =>
      this.request('PATCH', `/lists/${listId}/members/${memberHash}`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
        query: opts?.skipMergeValidation ? { skip_merge_validation: true } : undefined,
      }),

    /** Create-or-update subscriber by member hash. Safest primitive for idempotent upsert. */
    upsert: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      body: {
        email_address: string;
        status_if_new: SubscriberStatus;
        status?: SubscriberStatus;
        merge_fields?: Record<string, unknown>;
        interests?: Record<string, boolean>;
        language?: string;
        vip?: boolean;
        tags?: string[];
      },
      opts?: { skipMergeValidation?: boolean },
    ): Promise<Subscriber> =>
      this.request('PUT', `/lists/${listId}/members/${memberHash}`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
        query: opts?.skipMergeValidation ? { skip_merge_validation: true } : undefined,
      }),

    archive: async (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
    ): Promise<void> => {
      await this.request('DELETE', `/lists/${listId}/members/${memberHash}`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },

    /** Batch subscribe — the endpoint-on-the-list used by `import_subscribers`. */
    batch: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      body: {
        members: Array<BatchSubscribeRow>;
        sync_tags?: boolean;
        update_existing?: boolean;
        skip_merge_validation?: boolean;
        skip_duplicate_check?: boolean;
      },
    ): Promise<BatchSubscribeResponse> =>
      this.request('POST', `/lists/${listId}`, { signal: ctx.signal, log: ctx.log, body }),

    listTags: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ tags: SubscriberTag[]; total_items: number }> =>
      this.request('GET', `/lists/${listId}/members/${memberHash}/tags`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    updateTags: async (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      tags: Array<{ name: string; status: 'active' | 'inactive' }>,
    ): Promise<void> => {
      await this.request('POST', `/lists/${listId}/members/${memberHash}/tags`, {
        signal: ctx.signal,
        log: ctx.log,
        body: { tags },
      });
    },

    listNotes: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ notes: SubscriberNote[]; total_items: number }> =>
      this.request('GET', `/lists/${listId}/members/${memberHash}/notes`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    addNote: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      note: string,
    ): Promise<SubscriberNote> =>
      this.request('POST', `/lists/${listId}/members/${memberHash}/notes`, {
        signal: ctx.signal,
        log: ctx.log,
        body: { note },
      }),

    updateNote: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      noteId: number,
      note: string,
    ): Promise<SubscriberNote> =>
      this.request('PATCH', `/lists/${listId}/members/${memberHash}/notes/${noteId}`, {
        signal: ctx.signal,
        log: ctx.log,
        body: { note },
      }),

    deleteNote: async (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      noteId: number,
    ): Promise<void> => {
      await this.request('DELETE', `/lists/${listId}/members/${memberHash}/notes/${noteId}`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },

    listActivity: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      params?: { count?: number; offset?: number; action?: string[] },
    ): Promise<{ activity: SubscriberActivityItem[]; total_items: number }> =>
      this.request('GET', `/lists/${listId}/members/${memberHash}/activity-feed`, {
        signal: ctx.signal,
        log: ctx.log,
        query: { count: params?.count, offset: params?.offset, activity_filters: params?.action },
      }),

    listEvents: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ events: SubscriberEvent[]; total_items: number }> =>
      this.request('GET', `/lists/${listId}/members/${memberHash}/events`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    listGoals: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      memberHash: string,
    ): Promise<{ goals: SubscriberGoal[]; total_items: number }> =>
      this.request('GET', `/lists/${listId}/members/${memberHash}/goals`, {
        signal: ctx.signal,
        log: ctx.log,
      }),
  };

  // ─── Merge fields ─────────────────────────────────────────────────

  mergeFields = {
    list: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      params?: { count?: number; offset?: number; type?: string; required?: boolean },
    ): Promise<{ merge_fields: MergeField[]; total_items: number }> =>
      this.request('GET', `/lists/${listId}/merge-fields`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    get: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      mergeId: number,
    ): Promise<MergeField> =>
      this.request('GET', `/lists/${listId}/merge-fields/${mergeId}`, {
        signal: ctx.signal,
        log: ctx.log,
      }),

    create: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      body: Partial<MergeField>,
    ): Promise<MergeField> =>
      this.request('POST', `/lists/${listId}/merge-fields`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
      }),

    update: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      mergeId: number,
      body: Partial<MergeField>,
    ): Promise<MergeField> =>
      this.request('PATCH', `/lists/${listId}/merge-fields/${mergeId}`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
      }),
  };

  // ─── Segments ─────────────────────────────────────────────────────

  segments = {
    list: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      params?: { count?: number; offset?: number; type?: 'saved' | 'static' | 'fuzzy' },
    ): Promise<{ segments: Segment[]; total_items: number }> =>
      this.request('GET', `/lists/${listId}/segments`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    get: (ctx: Pick<Context, 'signal' | 'log'>, listId: string, segId: number): Promise<Segment> =>
      this.request('GET', `/lists/${listId}/segments/${segId}`, {
        signal: ctx.signal,
        log: ctx.log,
      }),

    create: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      body: {
        name: string;
        static_segment?: string[];
        options?: SegmentOptions;
      },
    ): Promise<Segment> =>
      this.request('POST', `/lists/${listId}/segments`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
      }),

    update: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      segId: number,
      body: {
        name?: string;
        static_segment?: string[];
        options?: SegmentOptions;
      },
    ): Promise<Segment> =>
      this.request('PATCH', `/lists/${listId}/segments/${segId}`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
      }),

    delete: async (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      segId: number,
    ): Promise<void> => {
      await this.request('DELETE', `/lists/${listId}/segments/${segId}`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },

    listMembers: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      segId: number,
      params?: {
        count?: number;
        offset?: number;
        includeCleaned?: boolean;
        includeTransactional?: boolean;
      },
    ): Promise<{ members: Subscriber[]; total_items: number }> =>
      this.request('GET', `/lists/${listId}/segments/${segId}/members`, {
        signal: ctx.signal,
        log: ctx.log,
        query: {
          count: params?.count,
          offset: params?.offset,
          include_cleaned: params?.includeCleaned,
          include_transactional: params?.includeTransactional,
        },
      }),

    batchUpdateMembers: (
      ctx: Pick<Context, 'signal' | 'log'>,
      listId: string,
      segId: number,
      body: { members_to_add?: string[]; members_to_remove?: string[] },
    ): Promise<{
      members_added: Subscriber[];
      members_removed: Subscriber[];
      errors: Array<{ email_address: string; error: string }>;
      total_added: number;
      total_removed: number;
      error_count: number;
    }> =>
      this.request('POST', `/lists/${listId}/segments/${segId}`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
      }),
  };

  // ─── Campaigns ────────────────────────────────────────────────────

  campaigns = {
    list: (
      ctx: Pick<Context, 'signal' | 'log'>,
      params?: {
        count?: number;
        offset?: number;
        type?: CampaignType;
        status?: string;
        beforeSendTime?: string;
        sinceSendTime?: string;
        beforeCreateTime?: string;
        sinceCreateTime?: string;
        listId?: string;
        fields?: string[];
      },
    ): Promise<{ campaigns: Campaign[]; total_items: number }> =>
      this.request('GET', '/campaigns', {
        signal: ctx.signal,
        log: ctx.log,
        query: {
          count: params?.count,
          offset: params?.offset,
          type: params?.type,
          status: params?.status,
          before_send_time: params?.beforeSendTime,
          since_send_time: params?.sinceSendTime,
          before_create_time: params?.beforeCreateTime,
          since_create_time: params?.sinceCreateTime,
          list_id: params?.listId,
          fields: params?.fields,
        },
      }),

    get: (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<Campaign> =>
      this.request('GET', `/campaigns/${id}`, { signal: ctx.signal, log: ctx.log }),

    create: (
      ctx: Pick<Context, 'signal' | 'log'>,
      body: {
        type: CampaignType;
        recipients: { list_id: string; segment_opts?: { saved_segment_id?: number } };
        settings: Partial<Campaign['settings']>;
      },
    ): Promise<Campaign> =>
      this.request('POST', '/campaigns', { signal: ctx.signal, log: ctx.log, body }),

    update: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      body: Partial<Campaign>,
    ): Promise<Campaign> =>
      this.request('PATCH', `/campaigns/${id}`, { signal: ctx.signal, log: ctx.log, body }),

    replicate: (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<Campaign> =>
      this.request('POST', `/campaigns/${id}/actions/replicate`, {
        signal: ctx.signal,
        log: ctx.log,
      }),

    delete: async (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<void> => {
      await this.request('DELETE', `/campaigns/${id}`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },

    getContent: (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<CampaignContent> =>
      this.request('GET', `/campaigns/${id}/content`, { signal: ctx.signal, log: ctx.log }),

    setContent: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      body: {
        html?: string;
        plain_text?: string;
        template?: { id: number; sections?: Record<string, unknown> };
        archive?: { archive_content: string; archive_type?: string };
        url?: string;
      },
    ): Promise<CampaignContent> =>
      this.request('PUT', `/campaigns/${id}/content`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
      }),

    getChecklist: (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<CampaignChecklist> =>
      this.request('GET', `/campaigns/${id}/send-checklist`, {
        signal: ctx.signal,
        log: ctx.log,
      }),

    sendTest: async (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      body: { test_emails: string[]; send_type: 'html' | 'plaintext' },
    ): Promise<void> => {
      await this.request('POST', `/campaigns/${id}/actions/test`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
        noRetry: true,
      });
    },

    send: async (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<void> => {
      await this.request('POST', `/campaigns/${id}/actions/send`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },

    schedule: async (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      body: { schedule_time: string; timewarp?: boolean; batch_delivery?: Record<string, unknown> },
    ): Promise<void> => {
      await this.request('POST', `/campaigns/${id}/actions/schedule`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
        noRetry: true,
      });
    },

    unschedule: async (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<void> => {
      await this.request('POST', `/campaigns/${id}/actions/unschedule`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },

    cancelSend: async (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<void> => {
      await this.request('POST', `/campaigns/${id}/actions/cancel-send`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },

    createResend: (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<Campaign> =>
      this.request('POST', `/campaigns/${id}/actions/create-resend`, {
        signal: ctx.signal,
        log: ctx.log,
      }),

    pauseRss: async (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<void> => {
      await this.request('POST', `/campaigns/${id}/actions/pause`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },

    resumeRss: async (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<void> => {
      await this.request('POST', `/campaigns/${id}/actions/resume`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },
  };

  // ─── Reports ──────────────────────────────────────────────────────

  reports = {
    list: (
      ctx: Pick<Context, 'signal' | 'log'>,
      params?: {
        count?: number;
        offset?: number;
        type?: CampaignType;
        beforeSendTime?: string;
        sinceSendTime?: string;
      },
    ): Promise<{ reports: CampaignReport[]; total_items: number }> =>
      this.request('GET', '/reports', {
        signal: ctx.signal,
        log: ctx.log,
        query: {
          count: params?.count,
          offset: params?.offset,
          type: params?.type,
          before_send_time: params?.beforeSendTime,
          since_send_time: params?.sinceSendTime,
        },
      }),

    get: (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<CampaignReport> =>
      this.request('GET', `/reports/${id}`, { signal: ctx.signal, log: ctx.log }),

    abuseReports: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
    ): Promise<{ abuse_reports: AbuseReport[]; total_items: number }> =>
      this.request('GET', `/reports/${id}/abuse-reports`, { signal: ctx.signal, log: ctx.log }),

    advice: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
    ): Promise<{ advice: Array<{ type: string; message: string }>; total_items: number }> =>
      this.request('GET', `/reports/${id}/advice`, { signal: ctx.signal, log: ctx.log }),

    clickDetailsList: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ urls_clicked: ClickDetail[]; total_items: number }> =>
      this.request('GET', `/reports/${id}/click-details`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    clickDetailsGet: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      linkId: string,
    ): Promise<ClickDetail> =>
      this.request('GET', `/reports/${id}/click-details/${linkId}`, {
        signal: ctx.signal,
        log: ctx.log,
      }),

    clickDetailsMembers: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      linkId: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ members: Subscriber[]; total_items: number }> =>
      this.request('GET', `/reports/${id}/click-details/${linkId}/members`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    openDetails: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number; offset?: number; since?: string },
    ): Promise<{ members: OpenDetail[]; total_items: number }> =>
      this.request('GET', `/reports/${id}/open-details`, {
        signal: ctx.signal,
        log: ctx.log,
        query: { count: params?.count, offset: params?.offset, since: params?.since },
      }),

    openDetailsMember: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      subscriberHash: string,
    ): Promise<OpenDetail> =>
      this.request('GET', `/reports/${id}/open-details/${subscriberHash}`, {
        signal: ctx.signal,
        log: ctx.log,
      }),

    domainPerformance: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
    ): Promise<{ domains: Array<Record<string, unknown>>; total_items: number }> =>
      this.request('GET', `/reports/${id}/domain-performance`, {
        signal: ctx.signal,
        log: ctx.log,
      }),

    eepurl: (ctx: Pick<Context, 'signal' | 'log'>, id: string): Promise<Record<string, unknown>> =>
      this.request('GET', `/reports/${id}/eepurl`, { signal: ctx.signal, log: ctx.log }),

    emailActivity: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number; offset?: number; since?: string },
    ): Promise<{ emails: Array<Record<string, unknown>>; total_items: number }> =>
      this.request('GET', `/reports/${id}/email-activity`, {
        signal: ctx.signal,
        log: ctx.log,
        query: { count: params?.count, offset: params?.offset, since: params?.since },
      }),

    locations: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ locations: LocationStat[]; total_items: number }> =>
      this.request('GET', `/reports/${id}/locations`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    sentTo: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ sent_to: Subscriber[]; total_items: number }> =>
      this.request('GET', `/reports/${id}/sent-to`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),

    unsubscribed: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: string,
      params?: { count?: number; offset?: number },
    ): Promise<{ unsubscribes: Unsubscribed[]; total_items: number }> =>
      this.request('GET', `/reports/${id}/unsubscribed`, {
        signal: ctx.signal,
        log: ctx.log,
        query: params,
      }),
  };

  // ─── Templates ────────────────────────────────────────────────────

  templates = {
    list: (
      ctx: Pick<Context, 'signal' | 'log'>,
      params?: {
        count?: number;
        offset?: number;
        type?: 'user' | 'base' | 'gallery';
        category?: string;
        folderId?: string;
      },
    ): Promise<{ templates: Template[]; total_items: number }> =>
      this.request('GET', '/templates', {
        signal: ctx.signal,
        log: ctx.log,
        query: {
          count: params?.count,
          offset: params?.offset,
          type: params?.type,
          category: params?.category,
          folder_id: params?.folderId,
        },
      }),

    get: (ctx: Pick<Context, 'signal' | 'log'>, id: number): Promise<Template> =>
      this.request('GET', `/templates/${id}`, { signal: ctx.signal, log: ctx.log }),

    create: (
      ctx: Pick<Context, 'signal' | 'log'>,
      body: { name: string; html: string; folder_id?: string },
    ): Promise<Template> =>
      this.request('POST', '/templates', { signal: ctx.signal, log: ctx.log, body }),

    update: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: number,
      body: Partial<{ name: string; html: string; folder_id: string }>,
    ): Promise<Template> =>
      this.request('PATCH', `/templates/${id}`, {
        signal: ctx.signal,
        log: ctx.log,
        body,
      }),

    delete: async (ctx: Pick<Context, 'signal' | 'log'>, id: number): Promise<void> => {
      await this.request('DELETE', `/templates/${id}`, {
        signal: ctx.signal,
        log: ctx.log,
        noRetry: true,
      });
    },

    defaultContent: (
      ctx: Pick<Context, 'signal' | 'log'>,
      id: number,
    ): Promise<TemplateDefaultContent> =>
      this.request('GET', `/templates/${id}/default-content`, {
        signal: ctx.signal,
        log: ctx.log,
      }),
  };

  // ─── Search ───────────────────────────────────────────────────────

  search = {
    members: (
      ctx: Pick<Context, 'signal' | 'log'>,
      params: { query: string; listId?: string },
    ): Promise<SearchMembersResponse> =>
      this.request('GET', '/search-members', {
        signal: ctx.signal,
        log: ctx.log,
        query: { query: params.query, list_id: params.listId },
      }),

    campaigns: (
      ctx: Pick<Context, 'signal' | 'log'>,
      params: { query: string },
    ): Promise<SearchCampaignsResponse> =>
      this.request('GET', '/search-campaigns', {
        signal: ctx.signal,
        log: ctx.log,
        query: { query: params.query },
      }),
  };
}

// ─── Init / accessor ─────────────────────────────────────────────────

let _service: MailchimpService | undefined;

export async function initMailchimpService(
  config: ServerConfig,
  log: Logger = globalLogger,
): Promise<void> {
  const svc = new MailchimpService(config);
  try {
    await svc.account.ping({
      signal: AbortSignal.timeout(10_000),
      log,
    } as Pick<Context, 'signal' | 'log'>);
    log.info('Mailchimp API key validated against /ping.', { dataCenter: svc.dataCenter });
  } catch (err) {
    if (err instanceof McpError && err.code === JsonRpcErrorCode.Unauthorized) {
      throw err;
    }
    log.warning('Mailchimp /ping failed at startup — continuing anyway.', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  _service = svc;
}

export function getMailchimpService(): MailchimpService {
  if (!_service) {
    throw new Error('MailchimpService not initialized — call initMailchimpService() in setup().');
  }
  return _service;
}

/** Test-only: inject a pre-built service (e.g., with a mocked fetch). */
export function setMailchimpServiceForTesting(service: MailchimpService | undefined): void {
  _service = service;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}
