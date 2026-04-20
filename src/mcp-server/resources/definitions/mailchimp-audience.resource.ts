/**
 * @fileoverview `mailchimp://audiences/{audienceId}` resource — audience snapshot.
 * @module mcp-server/resources/definitions/mailchimp-audience.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';
import { normalizeMailchimp } from '@/services/mailchimp/normalize.js';

export const mailchimpAudienceResource = resource('mailchimp://audiences/{audienceId}', {
  name: 'mailchimp-audience',
  description: 'Audience (list) snapshot — name, contact, stats, double-opt-in status.',
  mimeType: 'application/json',
  params: z.object({
    audienceId: z.string().describe('Audience (list) ID.'),
  }),
  async handler(params, ctx) {
    const svc = getMailchimpService();
    const a = await svc.audiences.get(ctx, params.audienceId);
    return {
      id: a.id,
      name: a.name,
      dateCreated: a.date_created,
      visibility: a.visibility,
      doubleOptin: a.double_optin,
      listRating: a.list_rating,
      stats: a.stats ? normalizeMailchimp(a.stats) : undefined,
      contact: a.contact ? normalizeMailchimp(a.contact) : undefined,
      campaignDefaults: a.campaign_defaults ? normalizeMailchimp(a.campaign_defaults) : undefined,
      permissionReminder: a.permission_reminder,
      subscribeUrl: a.subscribe_url_long,
    };
  },
});
