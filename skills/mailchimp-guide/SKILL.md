---
name: mailchimp-guide
description: Gates and ID chains for the mailchimp_* tools. Covers sending a campaign that already exists, finding the latest campaign, tracing who opened or clicked, targeting a tag, and adding someone who may already be subscribed. Use before sending, replicating, or analyzing a Mailchimp campaign, or before changing a subscriber, through this server.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

One Mailchimp account through its Marketing API: audiences, subscribers, tags and segments, regular/plaintext/RSS campaigns, reports, templates, and File Manager files.

Outside this server: transactional email (Mandrill), automations and customer journeys, A/B campaigns, landing pages, and interest groups. Use the Mailchimp UI to delete an audience, a campaign outside draft status, or a merge field, or to permanently delete a subscriber.

`mailchimp_assets` and `mailchimp_local_templates` exist only when the operator has configured them. Plan around them only when they appear in your tool list.

## Identifiers

| ID | Shape | Where it comes from |
|:---|:------|:--------------------|
| Audience (list) ID | short hex string | `mailchimp_audiences` list. Free accounts have one audience |
| Campaign ID | short hex string | `mailchimp_campaigns` list, `mailchimp_reports` list, `mailchimp_search` |
| webId | integer | Only for Mailchimp UI links. Passed as a campaign ID, it 404s |
| Subscriber hash | 32-char hex: MD5 of the trimmed, lowercased email | Subscriber tools take the email. The per-recipient report drill-down takes the hash: copy `subscriberId` from `mailchimp_find_subscriber` or `emailId` from a report row |
| Tag / static segment ID | integer | A tag is a static segment with the same name and ID: `mailchimp_segments` list, or a subscriber's tags |
| Merge tag | `FNAME`, `ADDRESS`, … | `mailchimp_audience_overview` or `mailchimp_merge_fields` list. Use the tag, not the display name |
| Template ID | integer | `mailchimp_templates` list. `user` holds the account's saved templates (often none); `base` holds Mailchimp's starters |

## Gates

### Sending

- **Create one draft.** `mailchimp_send_campaign` creates a new campaign on each call. Use `mode: draft` once and keep the returned `campaignId`.
- **Review and deliver the same draft.** Use `mailchimp_campaigns` to revise it with `update` or `set-content`, then preview with `send-test`, explicit `testEmails`, and `testSendType`. After authorization, use `send` or `schedule` with `confirmSend: true` and complete the confirmation round for that ID.
- **Discard a draft** with `mailchimp_campaigns` `delete` and confirmation. It is available only in `save` status.
- **Dispatch waits on a confirmation prompt in the client.** If the client can't show it, the send or schedule can't complete. Leave a draft and give the user its Mailchimp UI link so they can send it there.
- **Free plan: no scheduling.** When `mailchimp_account` info reports `forever_free`, send now or leave a draft. The send-checklist flags this only as a warning, so it won't stop a schedule attempt.
- **To send to a tag**, use the tag's ID as the segment ID.

### Finding campaigns and reports

- **"Latest" or "last" campaign:** `mailchimp_campaigns` list returns campaigns in creation order, oldest first, 10 per page by default, so once an account has more than 10 campaigns the newest aren't on page 1. For sent campaigns, `mailchimp_reports` list returns the newest send first. For drafts, filter the campaigns list by status and page to its end.
- **Post-send metrics require a sent campaign.** `mailchimp_campaign_report` rejects an unsent campaign. A `mailchimp_reports` slice can still return advice before sending; an empty slice checks send state and explains when post-send data is unavailable. If that check is temporarily unavailable, its notice leaves send state unknown. Pick from `mailchimp_reports` list for engagement analysis, and never send a campaign just to get a report.
- **Missing metrics are unknown.** The digest omits unavailable measurements, and the post-send review withholds advice that needs them. A failed digest slice or requested subscriber-tag read fails the call; it is not an empty observation.

### Who opened, who clicked

- **Per-recipient engagement comes from the `email-activity` slice of `mailchimp_reports`.** It returns one row per recipient, with open, click, and bounce actions; each click names its URL.
- **"Who clicked link X":** the `click-details` slice lists per-URL totals; pass a row's `id` as `linkId` on the same slice to get the members who clicked that URL.

### Subscribers

- **Look someone up before you upsert them.** By default, the status you pass to `mailchimp_upsert_subscriber` also overwrites an existing member's status, so "adding" someone as `pending` who is already subscribed changes their status. If `mailchimp_find_subscriber` shows they already exist, keep their status unless the user asked to change it.
- **Change a subscriber only when the address matches exactly.** `mailchimp_find_subscriber` returns near-misses as fuzzy matches, often other people such as plus-addressed variants, and a search on a fragment returns every hit as fuzzy.
- **To check a single address**, use `mailchimp_find_subscriber` (across every audience) or `mailchimp_subscribers` get. The `mailchimp_subscribers` list operation pages through the audience and narrows by status only.

## Workflows

**Newsletter, start to finish:** `mailchimp_playbook` (`design-campaign` or `send`) → `mailchimp_send_campaign` as a draft → revise, test, and send that `campaignId` with `mailchimp_campaigns` → `mailchimp_campaign_report` once it has sent.

**Reusing a past campaign:** `mailchimp_reports` list → pick a source campaign → `mailchimp_replicate_campaign` as a draft with the new content → review and dispatch the new draft ID with `mailchimp_campaigns`.

**Why did engagement change:** `mailchimp_reports` list → `mailchimp_campaign_report` (or the `post-send-review` playbook) for each campaign you're comparing → the `email-activity` slice when the question is about specific recipients.
