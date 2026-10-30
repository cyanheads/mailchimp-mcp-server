---
name: mailchimp-guide
description: Gates and ID chains for the mailchimp_* tools. Covers sending a campaign that already exists, finding the latest campaign, tracing who opened or clicked, targeting a tag, and adding someone who may already be subscribed. Use before sending, replicating, or analyzing a Mailchimp campaign, or before changing a subscriber, through this server.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

One Mailchimp account through its Marketing API: audiences, subscribers, tags and segments, regular/plaintext/RSS campaigns, reports, templates, and File Manager files.

Outside this server: transactional email (Mandrill), automations and customer journeys, A/B campaigns, landing pages, and interest groups. Deleting an audience, campaign, or merge field, and permanently deleting a subscriber, are things the user does in the Mailchimp UI. Say so rather than looking for a workaround.

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

- **Each `mailchimp_send_campaign` call creates a new campaign, including `draft` and `test` calls.** No tool sends an existing campaign by ID, and no tool deletes one. Calling it again in send mode after a draft or test sends a second campaign, built from your inputs, and leaves the reviewed one behind.
- **To send what the user reviewed** (a draft or test campaign, including edits they made in the Mailchimp UI), call `mailchimp_replicate_campaign` on that campaign in send mode. It sends a copy, and the original stays as a draft. If the user already approved the content in chat and doesn't want a draft, a single send-mode `mailchimp_send_campaign` call leaves nothing behind.
- **Before you finish, name the leftover draft and test campaigns** so the user can delete them in the UI.
- **Dispatch waits on a confirmation prompt in the client.** If the client can't show it, the send or schedule can't complete. Leave a draft and give the user its Mailchimp UI link so they can send it there.
- **Free plan: no scheduling.** When `mailchimp_account` info reports `forever_free`, send now or leave a draft. The send-checklist flags this only as a warning, so it won't stop a schedule attempt.
- **To send to a tag**, use the tag's ID as the segment ID.

### Finding campaigns and reports

- **"Latest" or "last" campaign:** `mailchimp_campaigns` list returns campaigns in creation order, oldest first, 10 per page by default, so once an account has more than 10 campaigns the newest aren't on page 1. For sent campaigns, `mailchimp_reports` list returns the newest send first. For drafts, filter the campaigns list by status and page to its end.
- **Only sent campaigns have reports.** `mailchimp_campaign_report` rejects an unsent campaign, and a `mailchimp_reports` slice on one comes back empty, so an empty slice is not proof of no engagement. Pick from `mailchimp_reports` list (sent campaigns only), and never send one just to get a report.

### Who opened, who clicked

- **Per-recipient engagement comes from the `email-activity` slice of `mailchimp_reports`.** It returns one row per recipient, with open, click, and bounce actions; each click names its URL.
- **"Who clicked link X":** the `click-details` slice lists per-URL totals; pass a row's `id` as `linkId` on the same slice to get the members who clicked that URL.

### Subscribers

- **Look someone up before you upsert them.** By default, the status you pass to `mailchimp_upsert_subscriber` also overwrites an existing member's status, so "adding" someone as `pending` who is already subscribed changes their status. If `mailchimp_find_subscriber` shows they already exist, keep their status unless the user asked to change it.
- **Change a subscriber only when the address matches exactly.** `mailchimp_find_subscriber` returns near-misses as fuzzy matches, often other people such as plus-addressed variants, and a search on a fragment returns every hit as fuzzy.
- **To check a single address**, use `mailchimp_find_subscriber` (across every audience) or `mailchimp_subscribers` get. The `mailchimp_subscribers` list operation pages through the audience and narrows by status only.

## Workflows

**Newsletter, start to finish:** `mailchimp_playbook` (`design-campaign` or `send`) → `mailchimp_send_campaign` as a draft or test → the user reviews it in the Mailchimp UI → `mailchimp_replicate_campaign` in send mode from the reviewed campaign (or the user sends it from the UI) → name the leftover campaigns → `mailchimp_campaign_report` once it has sent.

**Reusing a past campaign:** `mailchimp_reports` list → pick a source campaign → `mailchimp_replicate_campaign` as a draft with the new content → review → send with the replicate call from the Sending gates.

**Why did engagement change:** `mailchimp_reports` list → `mailchimp_campaign_report` (or the `post-send-review` playbook) for each campaign you're comparing → the `email-activity` slice when the question is about specific recipients.
