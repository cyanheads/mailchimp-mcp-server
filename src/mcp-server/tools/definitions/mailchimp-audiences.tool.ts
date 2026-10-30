/**
 * @fileoverview `mailchimp_audiences` tool — audience CRUD (no delete), analytics,
 * signup-form config. Deliberately excludes delete: on the 1-audience free plan
 * losing an audience is catastrophic and humans should do it in the UI.
 * @module mcp-server/tools/definitions/mailchimp-audiences.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  listEnrichment,
  listEnrichmentTrailer,
  pageEndNotice,
} from '@/mcp-server/tools/shared/list-enrichment.js';
import { renderRowTable } from '@/mcp-server/tools/shared/row-table.js';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import { normalizeMailchimp } from '@/services/mailchimp/normalize.js';
import type {
  Audience,
  AudienceCampaignDefaults,
  AudienceContact,
  SignupForm,
} from '@/services/mailchimp/types.js';

const OperationSchema = z
  .enum([
    'list',
    'get',
    'create',
    'update',
    'list-activity',
    'list-growth',
    'list-clients',
    'list-abuse-reports',
    'list-locations',
    'get-signup-forms',
    'customize-signup-forms',
  ])
  .describe(
    'Which audience operation to run. `list`/`get` are the default reads. `create`/`update` modify the audience record. `list-activity`, `list-growth`, `list-clients`, `list-abuse-reports`, `list-locations` are analytics reads. `get-signup-forms`/`customize-signup-forms` manage the hosted/embedded signup form HTML. No delete — delete an audience via the Mailchimp UI.',
  );

const ContactSchema = z.object({
  company: z.string().describe('Organization name (required by CAN-SPAM).'),
  address1: z.string().describe('Physical mailing address line 1.'),
  address2: z.string().optional().describe('Physical mailing address line 2.'),
  city: z.string().describe('City.'),
  state: z.string().describe('State/region.'),
  zip: z.string().describe('Postal code.'),
  country: z.string().describe('Two-letter country code (e.g. `US`).'),
  phone: z.string().optional().describe('Contact phone number.'),
});

const CampaignDefaultsSchema = z.object({
  fromName: z.string().describe('Default From name shown on campaigns.'),
  fromEmail: z.string().describe('Default From email address.'),
  subject: z.string().describe('Default subject line (can be blank).'),
  language: z.string().describe('ISO 639-1 language code (e.g. `en`).'),
});

const InputSchema = z.object({
  operation: OperationSchema,
  audienceId: z
    .string()
    .optional()
    .describe('Audience (list) ID. Required for every operation except `list` and `create`.'),
  name: z
    .string()
    .optional()
    .describe('Audience name. Required for `create`; optional for `update`.'),
  contact: ContactSchema.partial()
    .optional()
    .describe(
      'Audience contact info. `create` requires `company`, `address1`, `city`, `state`, `zip`, `country`. On `update`, pass only the subfields to change: the tool reads the audience first, and omitted or empty subfields keep their current values.',
    ),
  permissionReminder: z
    .string()
    .optional()
    .describe(
      'Reminder shown in email footers ("You are receiving this because…"). Required on `create`.',
    ),
  campaignDefaults: CampaignDefaultsSchema.partial()
    .optional()
    .describe(
      'Default campaign settings. `create` requires `fromName` and `fromEmail`; `subject` defaults to blank and `language` to `en`. On `update`, pass only the subfields to change: the tool reads the audience first, and omitted or empty subfields keep their current values.',
    ),
  emailTypeOption: z
    .boolean()
    .optional()
    .describe('Whether subscribers choose HTML vs plaintext. Default `false`.'),
  doubleOptin: z
    .boolean()
    .optional()
    .describe('Require double opt-in confirmation for new subscribers.'),
  useArchiveBar: z.boolean().optional().describe('Show the archive bar in campaigns.'),
  notifyOnSubscribe: z.string().optional().describe('Email to notify on subscribe.'),
  notifyOnUnsubscribe: z.string().optional().describe('Email to notify on unsubscribe.'),
  visibility: z.enum(['pub', 'prv']).optional().describe('`pub` (public) or `prv` (private).'),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(10)
    .describe('Page size for list-style reads. Max 1000 (Mailchimp cap).'),
  offset: z.coerce.number().int().min(0).default(0).describe('Offset for list-style reads.'),
  signupFormConfig: z
    .object({
      type: z
        .enum(['classic', 'unhosted', 'embedded', 'subscriber_popup'])
        .optional()
        .describe('Which signup form to customize.'),
      header: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Form header. Principal keys: `image_url`, `text`, `image_alt`, `image_width`.'),
      contents: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe(
          'Form content sections. Each entry: `{ section, value }` — `section` names the region (e.g. `signup_message`, `unsub_message`, `header_image`); `value` is the text/HTML to render.',
        ),
      styles: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe(
          'Form CSS overrides. Each entry: `{ selector, options: [{ property, value }] }` — `selector` targets a region (e.g. `page_label`); `options` lists CSS property/value pairs.',
        ),
    })
    .optional()
    .describe('Signup-form customization payload. Required for `customize-signup-forms`.'),
});

const AudienceStatsSchema = z
  .object({
    memberCount: z.number().optional().describe('Active subscribed members.'),
    unsubscribeCount: z.number().optional().describe('Total unsubscribes.'),
    cleanedCount: z.number().optional().describe('Bounced/invalid emails cleaned from the list.'),
    campaignCount: z.number().optional().describe('Campaigns ever sent.'),
    campaignLastSent: z.string().optional().describe('ISO 8601 timestamp of the last send.'),
    openRate: z.number().optional().describe('Mean open rate (0–1).'),
    clickRate: z.number().optional().describe('Mean click rate (0–1).'),
    lastSubDate: z.string().optional().describe('ISO 8601 of the most recent subscribe.'),
    lastUnsubDate: z.string().optional().describe('ISO 8601 of the most recent unsubscribe.'),
  })
  .describe('Audience-level aggregated stats.');

const AudienceSummarySchema = z
  .object({
    id: z.string().describe('Audience (list) ID.'),
    webId: z.number().optional().describe('Mailchimp numeric web-id (for UI deep links).'),
    name: z.string().describe('Audience display name.'),
    dateCreated: z.string().optional().describe('ISO 8601 timestamp of audience creation.'),
    listRating: z.number().optional().describe('Mailchimp list quality rating 0–5.'),
    visibility: z
      .enum(['pub', 'prv'])
      .optional()
      .describe('`pub` = publicly searchable, `prv` = private.'),
    doubleOptin: z.boolean().optional().describe('Whether double opt-in is required.'),
    stats: AudienceStatsSchema.optional(),
  })
  .describe('Summary view of one audience: identity + top-level stats.');

const OutputSchema = z.object({
  operation: OperationSchema,
  audience: AudienceSummarySchema.optional().describe('Populated for `get`, `create`, `update`.'),
  audiences: z.array(AudienceSummarySchema).optional().describe('Populated for `list`.'),
  totalItems: z.number().optional().describe('Total items from Mailchimp (for list-style reads).'),
  activity: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Per-day subscribe/unsubscribe counts. Populated for `list-activity`. Each row: `{ day: "YYYY-MM-DD", emailsSent, uniqueOpens, recipientClicks, hardBounce, softBounce, subs, unsubs, otherAdds, otherRemoves }`.',
    ),
  growth: z
    .array(
      z
        .object({
          month: z.string().describe('Year-month (`YYYY-MM`) for this bucket.'),
          subscribed: z.number().optional().describe('New subscribers in the month.'),
          unsubscribed: z.number().optional().describe('Unsubscribes in the month.'),
          existing: z.number().optional().describe('Existing members carried in.'),
          imports: z.number().optional().describe('Members added via import.'),
          optins: z.number().optional().describe('Members added via opt-in form.'),
          cleaned: z.number().optional().describe('Members cleaned (bounced) in the month.'),
        })
        .describe('One month of growth history.'),
    )
    .optional()
    .describe('Monthly growth history. Populated for `list-growth`.'),
  clients: z
    .array(
      z
        .object({
          client: z.string().describe('Email client name (e.g. `Apple Mail`, `Gmail`).'),
          members: z.number().describe('Members using this client.'),
        })
        .describe('One email-client usage row.'),
    )
    .optional()
    .describe('Email client mix. Populated for `list-clients`.'),
  abuseReports: z
    .array(
      z
        .object({
          id: z.number().describe('Abuse report ID.'),
          campaignId: z.string().describe('Campaign the report is against.'),
          email: z.string().describe('Reporting subscriber email.'),
          date: z.string().optional().describe('ISO 8601 timestamp of the report.'),
        })
        .describe('One subscriber-submitted abuse report.'),
    )
    .optional()
    .describe('Abuse reports. Populated for `list-abuse-reports`.'),
  locations: z
    .array(
      z
        .object({
          country: z.string().describe('Country name.'),
          cc: z.string().optional().describe('Two-letter ISO country code.'),
          total: z.number().optional().describe('Subscribers in this country.'),
          percent: z.number().optional().describe('Share of total subscribers (0–1).'),
        })
        .describe('One subscriber-location row.'),
    )
    .optional()
    .describe('Top subscriber locations. Populated for `list-locations`.'),
  signupForms: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Signup-form definitions. Populated for `get-signup-forms`. Each entry: `{ type, header, contents, styles }` (mirrors `signupFormConfig` input shape).',
    ),
  signupForm: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'The saved signup-form definition. Populated for `customize-signup-forms`. Same shape as `signupForms[]` entries: `{ type, header, contents, styles }`.',
    ),
});

type AudienceSummary = z.infer<typeof AudienceSummarySchema>;
type Output = z.infer<typeof OutputSchema>;

function summarize(a: Audience): AudienceSummary {
  const summary: AudienceSummary = { id: a.id, name: a.name };
  if (typeof a.web_id === 'number') summary.webId = a.web_id;
  if (a.date_created) summary.dateCreated = a.date_created;
  if (typeof a.list_rating === 'number') summary.listRating = a.list_rating;
  if (a.visibility) summary.visibility = a.visibility;
  if (typeof a.double_optin === 'boolean') summary.doubleOptin = a.double_optin;
  if (a.stats) {
    const stats: z.infer<typeof AudienceStatsSchema> = {};
    if (typeof a.stats.member_count === 'number') stats.memberCount = a.stats.member_count;
    if (typeof a.stats.unsubscribe_count === 'number')
      stats.unsubscribeCount = a.stats.unsubscribe_count;
    if (typeof a.stats.cleaned_count === 'number') stats.cleanedCount = a.stats.cleaned_count;
    if (typeof a.stats.campaign_count === 'number') stats.campaignCount = a.stats.campaign_count;
    if (a.stats.campaign_last_sent) stats.campaignLastSent = a.stats.campaign_last_sent;
    if (typeof a.stats.open_rate === 'number') stats.openRate = a.stats.open_rate;
    if (typeof a.stats.click_rate === 'number') stats.clickRate = a.stats.click_rate;
    if (a.stats.last_sub_date) stats.lastSubDate = a.stats.last_sub_date;
    if (a.stats.last_unsub_date) stats.lastUnsubDate = a.stats.last_unsub_date;
    if (Object.keys(stats).length > 0) summary.stats = stats;
  }
  return summary;
}

type Input = z.infer<typeof InputSchema>;

function requireAudienceId(input: Input): string {
  if (!input.audienceId) {
    throw validationError(`'audienceId' is required for operation '${input.operation}'.`);
  }
  return input.audienceId;
}

const CONTACT_KEYS = [
  'company',
  'address1',
  'address2',
  'city',
  'state',
  'zip',
  'country',
  'phone',
] as const;

/** Subfields Mailchimp requires whenever `contact` is sent, on create and update alike. */
const CONTACT_REQUIRED = ['company', 'address1', 'city', 'state', 'zip', 'country'] as const;

/** Caller-supplied contact subfields; `undefined` and `''` count as omitted (form clients send blanks). */
function suppliedContact(contact: Input['contact']): AudienceContact {
  const out: AudienceContact = {};
  for (const key of CONTACT_KEYS) {
    const value = contact?.[key];
    if (value) out[key] = value;
  }
  return out;
}

/** Caller-supplied campaign-default subfields in wire keys; `undefined` and `''` count as omitted. */
function suppliedCampaignDefaults(
  defaults: Input['campaignDefaults'],
): Partial<AudienceCampaignDefaults> {
  const out: Partial<AudienceCampaignDefaults> = {};
  if (defaults?.fromName) out.from_name = defaults.fromName;
  if (defaults?.fromEmail) out.from_email = defaults.fromEmail;
  if (defaults?.subject) out.subject = defaults.subject;
  if (defaults?.language) out.language = defaults.language;
  return out;
}

/**
 * Build the create/update request body. Mailchimp requires the full `contact`
 * and `campaign_defaults` objects whenever either is sent, so on `update` the
 * caller's subfields are laid over `current` (the audience as read before the
 * PATCH) and an omitted subfield is never sent blank. `create` has no current
 * values: `subject` defaults to blank and `language` to `en`.
 * @throws validationError naming every required field still missing.
 */
function buildAudienceBody(input: Input, current: Audience | undefined): Partial<Audience> {
  const isCreate = input.operation === 'create';
  const body: Partial<Audience> = {};
  const missing: string[] = [];
  if (input.name !== undefined) body.name = input.name;
  if (isCreate && !body.name) missing.push('name');

  const contactIn = suppliedContact(input.contact);
  if (isCreate || Object.keys(contactIn).length > 0) {
    const contact: AudienceContact = { ...current?.contact, ...contactIn };
    // An update re-sends what Mailchimp already stored, a blank (e.g. `state` outside the US) included.
    for (const key of CONTACT_REQUIRED) {
      if (isCreate ? !contact[key] : contact[key] === undefined) missing.push(`contact.${key}`);
    }
    body.contact = contact;
  }

  if (input.permissionReminder !== undefined) body.permission_reminder = input.permissionReminder;
  if (isCreate && !body.permission_reminder) missing.push('permissionReminder');

  const defaultsIn = suppliedCampaignDefaults(input.campaignDefaults);
  if (isCreate || Object.keys(defaultsIn).length > 0) {
    const base = isCreate ? { subject: '', language: 'en' } : current?.campaign_defaults;
    const { from_name, from_email, subject, language } = { ...base, ...defaultsIn };
    if (!from_name) missing.push('campaignDefaults.fromName');
    if (!from_email) missing.push('campaignDefaults.fromEmail');
    if (subject === undefined) missing.push('campaignDefaults.subject');
    if (!language) missing.push('campaignDefaults.language');
    if (from_name && from_email && subject !== undefined && language) {
      body.campaign_defaults = { from_name, from_email, subject, language };
    }
  }

  if (typeof input.emailTypeOption === 'boolean') body.email_type_option = input.emailTypeOption;
  if (isCreate && body.email_type_option === undefined) body.email_type_option = false;
  if (typeof input.doubleOptin === 'boolean') body.double_optin = input.doubleOptin;
  if (typeof input.useArchiveBar === 'boolean') body.use_archive_bar = input.useArchiveBar;
  if (input.notifyOnSubscribe !== undefined) body.notify_on_subscribe = input.notifyOnSubscribe;
  if (input.notifyOnUnsubscribe !== undefined)
    body.notify_on_unsubscribe = input.notifyOnUnsubscribe;
  if (input.visibility) body.visibility = input.visibility;

  if (missing.length > 0) {
    throw validationError(
      isCreate
        ? `Missing required fields for create: ${missing.join(', ')}.`
        : `Missing required fields for update: ${missing.join(', ')}. The audience has no current value for them; supply each one.`,
    );
  }
  return body;
}

/** A table cell: absent renders empty, a line break or non-string renders as JSON. */
function cell(value: unknown): string {
  if (value === undefined) return '';
  const raw = typeof value === 'string' && !/[\r\n]/.test(value) ? value : JSON.stringify(value);
  return escapeMarkdownInline(raw);
}

/** A ```json fence longer than any backtick run in the JSON. */
function jsonFence(value: unknown): string[] {
  const json = JSON.stringify(value, null, 2);
  const longestRun = Math.max(2, ...(json.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return [`${fence}json`, json, fence];
}

export const mailchimpAudiencesTool = tool('mailchimp_audiences', {
  description:
    'Manage Mailchimp audiences (the UI term for "lists"). Supports read, create/update, per-audience analytics (activity, growth, email clients, abuse reports, top locations), and signup-form configuration. Does NOT support delete — on free plan the 1-audience cap makes it catastrophic, so humans do it in the UI.',
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,
  enrichment: listEnrichment,
  enrichmentTrailer: listEnrichmentTrailer,
  errors: [
    {
      reason: 'mailchimp_unauthorized',
      thrownBy: 'service',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'Mailchimp returned 401 — API key invalid, revoked, or missing.',
      recovery:
        'Verify MAILCHIMP_API_KEY in env; rotate via Mailchimp → Account → Extras → API keys.',
    },
    {
      reason: 'mailchimp_forbidden',
      thrownBy: 'service',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Mailchimp returned 403 — paid-tier feature or insufficient permissions.',
      recovery:
        'Inspect data.requiresPlan when present; otherwise the API key lacks scope for this audience operation.',
    },
    {
      reason: 'mailchimp_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Mailchimp returned 404 — audience does not exist or has been deleted.',
      recovery: 'Re-run mailchimp_audiences operation:list to discover valid audienceId values.',
    },
    {
      reason: 'mailchimp_validation_failed',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Mailchimp returned 400 or 422 — request body failed upstream validation.',
      recovery: 'Inspect data.upstream.errors[] for field-level reasons, fix the input, and retry.',
    },
    {
      reason: 'mailchimp_rate_limited',
      thrownBy: 'service',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Mailchimp returned 429 — too many concurrent requests.',
      recovery:
        'Retry after a brief delay; reduce MAILCHIMP_CONCURRENCY_LIMIT for bulk operations.',
      retryable: true,
    },
  ] as const,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    switch (input.operation) {
      case 'list': {
        const query = { count: input.count, offset: input.offset };
        ctx.enrich({ filters: query });
        const page = await svc.audiences.list(ctx, query);
        const lists = Array.isArray(page.lists) ? (page.lists as Audience[]) : [];
        if (lists.length === 0) {
          ctx.enrich.notice(
            pageEndNotice(
              'audiences',
              query.offset,
              page.total_items,
              'This account has no audiences. Create one with `operation: "create"`.',
            ),
          );
        }
        return {
          operation: 'list',
          audiences: lists.map(summarize),
          totalItems: page.total_items,
        };
      }
      case 'get': {
        const audience = await svc.audiences.get(ctx, requireAudienceId(input));
        return { operation: 'get', audience: summarize(audience) };
      }
      case 'create': {
        const body = buildAudienceBody(input, undefined);
        const audience = await svc.audiences.create(ctx, body);
        ctx.log.info('audience created', { audienceId: audience.id, name: audience.name });
        return { operation: 'create', audience: summarize(audience) };
      }
      case 'update': {
        const id = requireAudienceId(input);
        const nestedChange =
          Object.keys(suppliedContact(input.contact)).length > 0 ||
          Object.keys(suppliedCampaignDefaults(input.campaignDefaults)).length > 0;
        const current = nestedChange
          ? await svc.audiences.get(ctx, id, { fields: ['contact', 'campaign_defaults'] })
          : undefined;
        const audience = await svc.audiences.update(ctx, id, buildAudienceBody(input, current));
        return { operation: 'update', audience: summarize(audience) };
      }
      case 'list-activity': {
        const query = { count: input.count };
        ctx.enrich({ filters: query });
        const { activity } = await svc.audiences.listActivity(ctx, requireAudienceId(input), query);
        const rows = normalizeMailchimp<Array<Record<string, unknown>>>(activity ?? []);
        if (rows.length === 0) {
          ctx.enrich.notice(
            'Mailchimp returned no daily activity for this audience; days appear once it sends campaigns or gains subscribers.',
          );
        }
        return { operation: 'list-activity', activity: rows };
      }
      case 'list-growth': {
        const query = { count: input.count, offset: input.offset };
        ctx.enrich({ filters: query });
        const { history, total_items } = await svc.audiences.listGrowthHistory(
          ctx,
          requireAudienceId(input),
          query,
        );
        if (history.length === 0) {
          ctx.enrich.notice(
            pageEndNotice(
              'months',
              query.offset,
              total_items,
              'This audience has no monthly growth history yet; Mailchimp records a month once the audience has subscriber activity.',
            ),
          );
        }
        return {
          operation: 'list-growth',
          totalItems: total_items,
          growth: history.map((h) => {
            const entry: NonNullable<Output['growth']>[number] = { month: h.month };
            if (typeof h.subscribed === 'number') entry.subscribed = h.subscribed;
            if (typeof h.unsubscribed === 'number') entry.unsubscribed = h.unsubscribed;
            if (typeof h.existing === 'number') entry.existing = h.existing;
            if (typeof h.imports === 'number') entry.imports = h.imports;
            if (typeof h.optins === 'number') entry.optins = h.optins;
            if (typeof h.cleaned === 'number') entry.cleaned = h.cleaned;
            return entry;
          }),
        };
      }
      case 'list-clients': {
        const { clients, total_items } = await svc.audiences.listClients(
          ctx,
          requireAudienceId(input),
        );
        if (clients.length === 0) {
          ctx.enrich.notice(
            'Mailchimp has recorded no email clients for this audience. Clients appear after subscribers open a sent campaign.',
          );
        }
        return {
          operation: 'list-clients',
          totalItems: total_items,
          clients: clients.map((c) => ({ client: c.client, members: c.members })),
        };
      }
      case 'list-abuse-reports': {
        const query = { count: input.count, offset: input.offset };
        ctx.enrich({ filters: query });
        const { abuse_reports, total_items } = await svc.audiences.listAbuseReports(
          ctx,
          requireAudienceId(input),
          query,
        );
        if (abuse_reports.length === 0) {
          ctx.enrich.notice(
            pageEndNotice(
              'abuse reports',
              query.offset,
              total_items,
              'No abuse reports against this audience. Deliverability is healthy; nothing to act on.',
            ),
          );
        }
        return {
          operation: 'list-abuse-reports',
          totalItems: total_items,
          abuseReports: abuse_reports.map((r) => {
            const entry: NonNullable<Output['abuseReports']>[number] = {
              id: r.id,
              campaignId: r.campaign_id,
              email: r.email_address,
            };
            if (r.date) entry.date = r.date;
            return entry;
          }),
        };
      }
      case 'list-locations': {
        const query = { count: input.count };
        ctx.enrich({ filters: query });
        const { locations, total_items } = await svc.audiences.listLocations(
          ctx,
          requireAudienceId(input),
          query,
        );
        if (locations.length === 0) {
          ctx.enrich.notice(
            'Mailchimp returned no subscriber locations for this audience; locations appear after subscribers open a campaign.',
          );
        }
        return {
          operation: 'list-locations',
          totalItems: total_items,
          locations: locations.map((l) => {
            const entry: NonNullable<Output['locations']>[number] = { country: l.country };
            if (l.cc) entry.cc = l.cc;
            if (typeof l.total === 'number') entry.total = l.total;
            if (typeof l.percent === 'number') entry.percent = l.percent;
            return entry;
          }),
        };
      }
      case 'get-signup-forms': {
        const { signup_forms, total_items } = await svc.audiences.getSignupForms(
          ctx,
          requireAudienceId(input),
        );
        if (!signup_forms?.length) {
          ctx.enrich.notice(
            'This audience has no customized signup forms. Create one with `operation: "customize-signup-forms"` and `signupFormConfig`.',
          );
        }
        return {
          operation: 'get-signup-forms',
          totalItems: total_items,
          signupForms: normalizeMailchimp<Array<Record<string, unknown>>>(signup_forms ?? []),
        };
      }
      case 'customize-signup-forms': {
        if (!input.signupFormConfig) {
          throw validationError(
            "'signupFormConfig' is required for operation 'customize-signup-forms'.",
          );
        }
        const body = {
          ...(input.signupFormConfig.type ? { type: input.signupFormConfig.type } : {}),
          ...(input.signupFormConfig.header ? { header: input.signupFormConfig.header } : {}),
          ...(input.signupFormConfig.contents ? { contents: input.signupFormConfig.contents } : {}),
          ...(input.signupFormConfig.styles ? { styles: input.signupFormConfig.styles } : {}),
        } as SignupForm;
        const saved = await svc.audiences.customizeSignupForms(ctx, requireAudienceId(input), body);
        return {
          operation: 'customize-signup-forms',
          signupForm: normalizeMailchimp<Record<string, unknown>>(saved),
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [`Operation: ${result.operation}`, ''];

    const renderSummary = (a: AudienceSummary, bullet: boolean): void => {
      const prefix = bullet ? '- ' : '';
      const indent = bullet ? '  ' : '';
      const webId = typeof a.webId === 'number' ? ` webId:${a.webId}` : '';
      const visLabel = a.visibility
        ? ` visibility:${a.visibility === 'pub' ? 'public' : 'private'}`
        : '';
      const dOpt = typeof a.doubleOptin === 'boolean' ? ` doubleOptin:${a.doubleOptin}` : '';
      lines.push(`${prefix}**${a.name}** (\`${a.id}\`)${webId}${visLabel}${dOpt}`);
      const meta: string[] = [];
      if (a.dateCreated) meta.push(`dateCreated ${a.dateCreated}`);
      if (typeof a.listRating === 'number') meta.push(`listRating ${a.listRating}/5`);
      if (meta.length > 0) lines.push(`${indent}${meta.join(' · ')}`);
      if (a.stats) {
        const s = a.stats;
        const parts: string[] = [];
        if (typeof s.memberCount === 'number') parts.push(`memberCount ${s.memberCount}`);
        if (typeof s.unsubscribeCount === 'number')
          parts.push(`unsubscribeCount ${s.unsubscribeCount}`);
        if (typeof s.cleanedCount === 'number') parts.push(`cleanedCount ${s.cleanedCount}`);
        if (typeof s.campaignCount === 'number') parts.push(`campaignCount ${s.campaignCount}`);
        if (typeof s.openRate === 'number')
          parts.push(`openRate ${(s.openRate * 100).toFixed(2)}%`);
        if (typeof s.clickRate === 'number')
          parts.push(`clickRate ${(s.clickRate * 100).toFixed(2)}%`);
        if (parts.length > 0) lines.push(`${indent}Stats: ${parts.join(', ')}`);
        const stamps: string[] = [];
        if (s.campaignLastSent) stamps.push(`campaignLastSent ${s.campaignLastSent}`);
        if (s.lastSubDate) stamps.push(`lastSubDate ${s.lastSubDate}`);
        if (s.lastUnsubDate) stamps.push(`lastUnsubDate ${s.lastUnsubDate}`);
        if (stamps.length > 0) lines.push(`${indent}${stamps.join(' · ')}`);
      }
    };

    if (result.audiences) {
      lines.push(`# Audiences (${result.audiences.length} of ${result.totalItems ?? '?'})`, '');
      for (const a of result.audiences) renderSummary(a, true);
    }

    if (result.audience) {
      if (result.audiences) lines.push('');
      lines.push(`# ${result.audience.name}`, '');
      renderSummary(result.audience, false);
    }

    if (result.growth) {
      lines.push('', `# Growth history (${result.growth.length} months)`);
      if (result.growth.length > 0) {
        lines.push(
          '',
          '| month | subscribed | unsubscribed | existing | imports | optins | cleaned |',
          '|:------|-----------:|-------------:|---------:|--------:|-------:|--------:|',
        );
      }
      for (const g of result.growth) {
        lines.push(
          `| ${cell(g.month)} | ${cell(g.subscribed)} | ${cell(g.unsubscribed)} | ${cell(g.existing)} | ${cell(g.imports)} | ${cell(g.optins)} | ${cell(g.cleaned)} |`,
        );
      }
    }

    if (result.clients) {
      lines.push('', `# Email clients (${result.clients.length})`, '');
      for (const c of result.clients) lines.push(`- ${c.client}: ${c.members} members`);
    }

    if (result.abuseReports) {
      lines.push('', `# Abuse reports (${result.abuseReports.length})`, '');
      for (const r of result.abuseReports) {
        lines.push(
          `- [id:${r.id}] \`${r.email}\` (campaignId: ${r.campaignId})${r.date ? ` at ${r.date}` : ''}`,
        );
      }
    }

    if (result.locations) {
      lines.push('', '# Top subscriber locations', '');
      for (const l of result.locations) {
        const ccPart = l.cc ? ` (cc: ${l.cc})` : '';
        const totalPart = typeof l.total === 'number' ? ` total ${l.total}` : '';
        const pctPart = typeof l.percent === 'number' ? ` (${(l.percent * 100).toFixed(1)}%)` : '';
        lines.push(`- ${l.country}${ccPart}:${totalPart}${pctPart}`);
      }
    }

    if (result.activity) {
      lines.push('', `# Per-day activity (${result.activity.length} days)`);
      if (result.activity.length > 0) lines.push('', ...renderRowTable(result.activity, ['day']));
    }

    if (result.signupForms) {
      lines.push('', `# Signup forms (${result.signupForms.length})`);
      for (const f of result.signupForms) lines.push('', ...jsonFence(f));
    }

    if (result.signupForm) {
      lines.push('', 'Signup form updated.', '', ...jsonFence(result.signupForm));
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
