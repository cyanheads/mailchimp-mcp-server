/**
 * @fileoverview `mailchimp://account` resource — account info snapshot.
 * Supplementary to `mailchimp_account` tool; not all MCP clients render resources.
 * @module mcp-server/resources/definitions/mailchimp-account.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getMailchimpService } from '@/services/mailchimp/mailchimp-service.js';

export const mailchimpAccountResource = resource('mailchimp://account', {
  name: 'mailchimp-account',
  description: 'Mailchimp account info snapshot (profile, plan, data center, total subscribers).',
  mimeType: 'application/json',
  params: z.object({}),
  async handler(_params, ctx) {
    const svc = getMailchimpService();
    const info = await svc.account.info(ctx);
    return {
      accountId: info.account_id,
      accountName: info.account_name,
      email: info.email,
      username: info.username,
      dataCenter: svc.dataCenter,
      pricingPlanType: info.pricing_plan_type,
      totalSubscribers: info.total_subscribers,
      memberSince: info.member_since,
      lastLogin: info.last_login,
      fetchedAt: new Date().toISOString(),
    };
  },
});
