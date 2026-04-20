/**
 * @fileoverview `mailchimp_audiences` tool — audience CRUD (no delete), analytics,
 * signup-form config. Deliberately excludes delete: on the 1-audience free plan
 * losing an audience is catastrophic and humans should do it in the UI.
 * @module mcp-server/tools/definitions/mailchimp-audiences.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import { normalizeMailchimp } from '@/services/mailchimp/normalize.js';
import type { Audience, SignupForm } from '@/services/mailchimp/types.js';

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
  address2: z.string().optional(),
  city: z.string().describe('City.'),
  state: z.string().describe('State/region.'),
  zip: z.string().describe('Postal code.'),
  country: z.string().describe('Two-letter country code (e.g. `US`).'),
  phone: z.string().optional(),
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
      'Audience contact info. Required fields: `company`, `address1`, `city`, `state`, `zip`, `country` — required on `create`, optional on `update`.',
    ),
  permissionReminder: z
    .string()
    .optional()
    .describe(
      'Reminder shown in email footers ("You are receiving this because…"). Required on `create`.',
    ),
  campaignDefaults: CampaignDefaultsSchema.partial()
    .optional()
    .describe('Default campaign settings. Required on `create`.'),
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
  count: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(10)
    .describe('Page size for list-style reads. Max 1000 (Mailchimp cap).'),
  offset: z.number().int().min(0).default(0).describe('Offset for list-style reads.'),
  signupFormConfig: z
    .object({
      type: z
        .enum(['classic', 'unhosted', 'embedded', 'subscriber_popup'])
        .optional()
        .describe('Which signup form to customize.'),
      header: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Form header configuration (raw Mailchimp shape).'),
      contents: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('Form content sections (raw Mailchimp shape).'),
      styles: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('Form style definitions (raw Mailchimp shape).'),
    })
    .optional()
    .describe('Signup-form customization payload. Required for `customize-signup-forms`.'),
});

const AudienceStatsSchema = z.object({
  memberCount: z.number().optional(),
  unsubscribeCount: z.number().optional(),
  cleanedCount: z.number().optional(),
  campaignCount: z.number().optional(),
  campaignLastSent: z.string().optional(),
  openRate: z.number().optional(),
  clickRate: z.number().optional(),
  lastSubDate: z.string().optional(),
  lastUnsubDate: z.string().optional(),
});

const AudienceSummarySchema = z.object({
  id: z.string(),
  webId: z.number().optional(),
  name: z.string(),
  dateCreated: z.string().optional(),
  listRating: z.number().optional(),
  visibility: z.enum(['pub', 'prv']).optional(),
  doubleOptin: z.boolean().optional(),
  stats: AudienceStatsSchema.optional(),
});

const OutputSchema = z.object({
  operation: OperationSchema,
  audience: AudienceSummarySchema.optional().describe('Populated for `get`, `create`, `update`.'),
  audiences: z.array(AudienceSummarySchema).optional().describe('Populated for `list`.'),
  totalItems: z.number().optional().describe('Total items from Mailchimp (for list-style reads).'),
  activity: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('Raw per-day subscribe/unsubscribe counts. Populated for `list-activity`.'),
  growth: z
    .array(
      z.object({
        month: z.string(),
        subscribed: z.number().optional(),
        unsubscribed: z.number().optional(),
        existing: z.number().optional(),
        imports: z.number().optional(),
        optins: z.number().optional(),
        cleaned: z.number().optional(),
      }),
    )
    .optional()
    .describe('Monthly growth history. Populated for `list-growth`.'),
  clients: z
    .array(z.object({ client: z.string(), members: z.number() }))
    .optional()
    .describe('Email client mix. Populated for `list-clients`.'),
  abuseReports: z
    .array(
      z.object({
        id: z.number(),
        campaignId: z.string(),
        email: z.string(),
        date: z.string().optional(),
      }),
    )
    .optional()
    .describe('Abuse reports. Populated for `list-abuse-reports`.'),
  locations: z
    .array(
      z.object({
        country: z.string(),
        cc: z.string().optional(),
        total: z.number().optional(),
        percent: z.number().optional(),
      }),
    )
    .optional()
    .describe('Top subscriber locations. Populated for `list-locations`.'),
  signupForms: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('Signup-form definitions. Populated for `get-signup-forms`.'),
  signupForm: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The saved signup-form definition. Populated for `customize-signup-forms`.'),
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

function requireAudienceId(input: z.infer<typeof InputSchema>): string {
  if (!input.audienceId) {
    throw validationError(`'audienceId' is required for operation '${input.operation}'.`);
  }
  return input.audienceId;
}

function buildAudienceBody(
  input: z.infer<typeof InputSchema>,
  isCreate: boolean,
): Partial<Audience> {
  const body: Partial<Audience> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.contact) {
    body.contact = {
      company: input.contact.company ?? '',
      address1: input.contact.address1 ?? '',
      city: input.contact.city ?? '',
      state: input.contact.state ?? '',
      zip: input.contact.zip ?? '',
      country: input.contact.country ?? '',
      ...(input.contact.address2 ? { address2: input.contact.address2 } : {}),
      ...(input.contact.phone ? { phone: input.contact.phone } : {}),
    };
  }
  if (input.permissionReminder !== undefined) body.permission_reminder = input.permissionReminder;
  if (input.campaignDefaults) {
    body.campaign_defaults = {
      from_name: input.campaignDefaults.fromName ?? '',
      from_email: input.campaignDefaults.fromEmail ?? '',
      subject: input.campaignDefaults.subject ?? '',
      language: input.campaignDefaults.language ?? 'en',
    };
  }
  if (typeof input.emailTypeOption === 'boolean') body.email_type_option = input.emailTypeOption;
  if (typeof input.doubleOptin === 'boolean') body.double_optin = input.doubleOptin;
  if (typeof input.useArchiveBar === 'boolean') body.use_archive_bar = input.useArchiveBar;
  if (input.notifyOnSubscribe !== undefined) body.notify_on_subscribe = input.notifyOnSubscribe;
  if (input.notifyOnUnsubscribe !== undefined)
    body.notify_on_unsubscribe = input.notifyOnUnsubscribe;
  if (input.visibility) body.visibility = input.visibility;

  if (isCreate) {
    const missing: string[] = [];
    if (!body.name) missing.push('name');
    if (!body.contact?.company) missing.push('contact.company');
    if (!body.contact?.address1) missing.push('contact.address1');
    if (!body.contact?.city) missing.push('contact.city');
    if (!body.contact?.state) missing.push('contact.state');
    if (!body.contact?.zip) missing.push('contact.zip');
    if (!body.contact?.country) missing.push('contact.country');
    if (!body.permission_reminder) missing.push('permissionReminder');
    if (!body.campaign_defaults?.from_name) missing.push('campaignDefaults.fromName');
    if (!body.campaign_defaults?.from_email) missing.push('campaignDefaults.fromEmail');
    if (!body.campaign_defaults?.language) missing.push('campaignDefaults.language');
    if (body.email_type_option === undefined) body.email_type_option = false;
    if (missing.length > 0) {
      throw validationError(`Missing required fields for create: ${missing.join(', ')}.`);
    }
  }
  return body;
}

export const mailchimpAudiencesTool = tool('mailchimp_audiences', {
  description:
    'Manage Mailchimp audiences (the UI term for "lists"). Supports read, create/update, per-audience analytics (activity, growth, email clients, abuse reports, top locations), and signup-form configuration. Does NOT support delete — on free plan the 1-audience cap makes it catastrophic, so humans do it in the UI.',
  annotations: { openWorldHint: true },
  input: InputSchema,
  output: OutputSchema,

  async handler(input, ctx): Promise<Output> {
    const svc = getMailchimpService();

    switch (input.operation) {
      case 'list': {
        const page = await svc.audiences.list(ctx, { count: input.count, offset: input.offset });
        const lists = Array.isArray(page.lists) ? (page.lists as Audience[]) : [];
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
        const body = buildAudienceBody(input, true);
        const audience = await svc.audiences.create(ctx, body);
        ctx.log.info('audience created', { audienceId: audience.id, name: audience.name });
        return { operation: 'create', audience: summarize(audience) };
      }
      case 'update': {
        const id = requireAudienceId(input);
        const body = buildAudienceBody(input, false);
        const audience = await svc.audiences.update(ctx, id, body);
        return { operation: 'update', audience: summarize(audience) };
      }
      case 'list-activity': {
        const { activity } = await svc.audiences.listActivity(ctx, requireAudienceId(input), {
          count: input.count,
        });
        return {
          operation: 'list-activity',
          activity: normalizeMailchimp<Array<Record<string, unknown>>>(activity ?? []),
        };
      }
      case 'list-growth': {
        const { history, total_items } = await svc.audiences.listGrowthHistory(
          ctx,
          requireAudienceId(input),
          { count: input.count, offset: input.offset },
        );
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
        return {
          operation: 'list-clients',
          totalItems: total_items,
          clients: clients.map((c) => ({ client: c.client, members: c.members })),
        };
      }
      case 'list-abuse-reports': {
        const { abuse_reports, total_items } = await svc.audiences.listAbuseReports(
          ctx,
          requireAudienceId(input),
          { count: input.count, offset: input.offset },
        );
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
        const { locations, total_items } = await svc.audiences.listLocations(
          ctx,
          requireAudienceId(input),
          { count: input.count },
        );
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
    const lines: string[] = [];
    if (result.operation === 'list' && result.audiences) {
      lines.push(`# Audiences (${result.audiences.length} of ${result.totalItems ?? '?'})`, '');
      for (const a of result.audiences) {
        lines.push(
          `- **${a.name}** (\`${a.id}\`) — ${a.stats?.memberCount ?? '?'} members, rating ${a.listRating ?? '—'}`,
        );
      }
    } else if (result.audience && ['get', 'create', 'update'].includes(result.operation)) {
      const a = result.audience;
      lines.push(`# ${a.name}`, '', `**ID:** ${a.id}  `);
      if (a.dateCreated) lines.push(`**Created:** ${a.dateCreated}  `);
      if (typeof a.listRating === 'number') lines.push(`**List rating:** ${a.listRating}/5  `);
      if (a.stats) {
        lines.push('', '**Stats**');
        for (const [k, v] of Object.entries(a.stats)) {
          if (v !== undefined && v !== null) lines.push(`- ${k}: ${v}`);
        }
      }
    } else if (result.operation === 'list-growth' && result.growth) {
      lines.push(`# Growth history (${result.growth.length} months)`, '');
      lines.push('| Month | Subscribed | Unsubscribed | Cleaned |');
      lines.push('|:------|-----------:|-------------:|--------:|');
      for (const g of result.growth) {
        lines.push(
          `| ${g.month} | ${g.subscribed ?? 0} | ${g.unsubscribed ?? 0} | ${g.cleaned ?? 0} |`,
        );
      }
    } else if (result.operation === 'list-clients' && result.clients) {
      lines.push(`# Email clients (${result.clients.length})`, '');
      for (const c of result.clients) lines.push(`- ${c.client}: ${c.members}`);
    } else if (result.operation === 'list-abuse-reports' && result.abuseReports) {
      lines.push(`# Abuse reports (${result.abuseReports.length})`, '');
      if (result.abuseReports.length === 0) lines.push('_None — deliverability is healthy._');
      for (const r of result.abuseReports) {
        lines.push(`- \`${r.email}\` (campaign ${r.campaignId})${r.date ? ` at ${r.date}` : ''}`);
      }
    } else if (result.operation === 'list-locations' && result.locations) {
      lines.push(`# Top subscriber locations`, '');
      for (const l of result.locations)
        lines.push(
          `- ${l.country}${l.cc ? ` (${l.cc})` : ''}: ${l.total ?? 0}${l.percent !== undefined ? ` (${(l.percent * 100).toFixed(1)}%)` : ''}`,
        );
    } else if (result.operation === 'list-activity' && result.activity) {
      lines.push(`# Per-day activity (${result.activity.length} days)`, '');
      for (const row of result.activity) {
        lines.push(`- ${JSON.stringify(row)}`);
      }
    } else if (result.operation === 'get-signup-forms' && result.signupForms) {
      lines.push(`# Signup forms (${result.signupForms.length})`, '');
      for (const f of result.signupForms) {
        lines.push(`- type=${String((f as { type?: string }).type ?? 'unknown')}`);
      }
    } else if (result.operation === 'customize-signup-forms') {
      lines.push(
        'Signup form updated.',
        '',
        '```json',
        JSON.stringify(result.signupForm, null, 2),
        '```',
      );
    } else {
      lines.push(`Operation \`${result.operation}\` completed.`);
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
