/**
 * @fileoverview Shared `.describe()` copy for the `templateSections` input
 * field used by `mailchimp_send_campaign`, `mailchimp_campaigns`
 * (`set-content`), and `mailchimp_replicate_campaign`. Keeping the text in
 * one place prevents the three tools from drifting out of sync as the
 * per-section override contract evolves.
 * @module mcp-server/tools/shared/template-sections-doc
 */

export const TEMPLATE_SECTIONS_DOC = [
  'Per-section HTML overrides for campaigns built from a saved template.',
  'Keys are edit-region IDs — the `mc:edit="…"` attribute values in the template HTML,',
  'or the section IDs returned by `mailchimp_templates` with `operation: get-default-content`.',
  'Values are HTML strings that replace the default content for that region.',
  'Only applied when `templateId` is also set; ignored otherwise.',
  'Example: `{ "header": "<h1>Welcome</h1>", "body": "<p>…</p>" }`.',
  'Note: Mailchimp only returns populated sections for drag-and-drop templates.',
  'For user-uploaded HTML templates that use `mc:edit`, `get-default-content` often',
  'returns an empty map; in that case, discover the region names by reading the',
  "template's HTML (`mailchimp_templates` with `operation: get`) and pull the",
  '`mc:edit` attribute values.',
].join(' ');
