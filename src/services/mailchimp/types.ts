/**
 * @fileoverview Domain types for the Mailchimp Marketing API v3.0 surface wrapped by this server.
 * Types mirror the upstream response shapes — many fields are optional because Mailchimp
 * elides them on sparse records (new audiences, pre-send campaigns, stripped reports, etc.).
 * @module services/mailchimp/types
 */

// ─── Shared envelopes ─────────────────────────────────────────────────

export interface MailchimpLink {
  href: string;
  method?: string;
  rel: string;
  schema?: string;
  targetSchema?: string;
}

export interface MailchimpErrorBody {
  detail?: string;
  errors?: Array<{ field: string; message: string }>;
  instance?: string;
  status?: number;
  title?: string;
  type?: string;
}

export interface Paged<T> {
  _links?: MailchimpLink[];
  total_items: number;
  [key: string]: unknown | T[];
}

// ─── Account ─────────────────────────────────────────────────────────

export interface AccountInfo {
  _links?: MailchimpLink[];
  account_id: string;
  account_industry?: string;
  account_name: string;
  account_timezone?: string;
  avatar_url?: string;
  contact?: {
    company?: string;
    addr1?: string;
    addr2?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  email?: string;
  first_name?: string;
  first_payment?: string;
  industry_stats?: {
    open_rate?: number;
    bounce_rate?: number;
    click_rate?: number;
  };
  last_login?: string;
  last_name?: string;
  login_id?: string;
  member_since?: string;
  pricing_plan_type?: string;
  pro_enabled?: boolean;
  role?: string;
  total_subscribers?: number;
  username?: string;
}

export interface ActivityFeedItem {
  activity: string;
  campaign_id?: string;
  list_id?: string;
  title?: string;
  type: string;
  update_time: string;
  url?: string;
}

export interface ActivityFeedResponse {
  _links?: MailchimpLink[];
  // Upstream omits `activity` on quiet accounts — treat as optional.
  activity?: ActivityFeedItem[];
  total_items?: number;
}

// ─── Audiences (lists) ───────────────────────────────────────────────

export interface AudienceContact {
  address1?: string;
  address2?: string;
  city?: string;
  company?: string;
  country?: string;
  phone?: string;
  state?: string;
  zip?: string;
}

export interface AudienceCampaignDefaults {
  from_email: string;
  from_name: string;
  language: string;
  subject: string;
}

export interface AudienceStats {
  avg_sub_rate?: number;
  avg_unsub_rate?: number;
  campaign_count?: number;
  campaign_last_sent?: string;
  cleaned_count?: number;
  cleaned_count_since_send?: number;
  click_rate?: number;
  last_sub_date?: string;
  last_unsub_date?: string;
  member_count?: number;
  member_count_since_send?: number;
  merge_field_count?: number;
  open_rate?: number;
  target_sub_rate?: number;
  unsubscribe_count?: number;
  unsubscribe_count_since_send?: number;
}

export interface Audience {
  _links?: MailchimpLink[];
  beamer_address?: string;
  campaign_defaults?: AudienceCampaignDefaults;
  contact?: AudienceContact;
  date_created?: string;
  double_optin?: boolean;
  email_type_option?: boolean;
  has_welcome?: boolean;
  id: string;
  list_rating?: number;
  marketing_permissions?: boolean;
  modules?: string[];
  name: string;
  notify_on_subscribe?: string;
  notify_on_unsubscribe?: string;
  permission_reminder?: string;
  stats?: AudienceStats;
  subscribe_url_long?: string;
  subscribe_url_short?: string;
  use_archive_bar?: boolean;
  visibility?: 'pub' | 'prv';
  web_id?: number;
}

export interface GrowthHistoryEntry {
  cleaned?: number;
  deleted?: number;
  existing?: number;
  imports?: number;
  list_id: string;
  month: string;
  optins?: number;
  pending?: number;
  reconfirm?: number;
  subscribed?: number;
  transactional?: number;
  unsubscribed?: number;
}

export interface EmailClient {
  client: string;
  members: number;
}

export interface AbuseReport {
  campaign_id: string;
  date?: string;
  email_address: string;
  email_id: string;
  id: number;
  list_id: string;
  list_is_active?: boolean;
  merge_fields?: Record<string, unknown>;
  vip?: boolean;
}

export interface AudienceLocation {
  cc?: string;
  country: string;
  percent?: number;
  total?: number;
}

export interface SignupForm {
  _links?: MailchimpLink[];
  contents?: Array<Record<string, unknown>>;
  header?: Record<string, unknown>;
  styles?: Array<Record<string, unknown>>;
  type?: 'classic' | 'unhosted' | 'embedded' | 'subscriber_popup';
}

// ─── Merge fields ────────────────────────────────────────────────────

export interface MergeField {
  _links?: MailchimpLink[];
  default_value?: string;
  display_order?: number;
  help_text?: string;
  list_id?: string;
  merge_id: number;
  name: string;
  options?: Record<string, unknown>;
  public?: boolean;
  required?: boolean;
  tag: string;
  type:
    | 'text'
    | 'number'
    | 'address'
    | 'phone'
    | 'date'
    | 'url'
    | 'imageurl'
    | 'radio'
    | 'dropdown'
    | 'birthday'
    | 'zip';
}

// ─── Subscribers (members) ───────────────────────────────────────────

export type SubscriberStatus =
  | 'subscribed'
  | 'unsubscribed'
  | 'cleaned'
  | 'pending'
  | 'transactional'
  | 'archived';

export interface SubscriberStats {
  avg_click_rate?: number;
  avg_open_rate?: number;
  ecommerce_data?: {
    total_revenue?: number;
    number_of_orders?: number;
    currency_code?: string;
  };
}

export interface SubscriberLocation {
  country_code?: string;
  dstoff?: number;
  gmtoff?: number;
  latitude?: number;
  longitude?: number;
  region?: string;
  timezone?: string;
}

export interface SubscriberTag {
  date_added?: string;
  id: number;
  name: string;
}

export interface Subscriber {
  _links?: MailchimpLink[];
  consents_to_one_to_one_messaging?: boolean;
  contact_id?: string;
  email_address: string;
  email_client?: string;
  email_type?: string;
  full_name?: string;
  id: string;
  interests?: Record<string, boolean>;
  ip_opt?: string;
  ip_signup?: string;
  language?: string;
  last_changed?: string;
  last_note?: { note_id?: number; created_at?: string; created_by?: string; note?: string };
  list_id: string;
  location?: SubscriberLocation;
  marketing_permissions?: Array<{
    marketing_permission_id: string;
    text?: string;
    enabled: boolean;
  }>;
  member_rating?: number;
  merge_fields?: Record<string, unknown>;
  sms_phone_number?: string;
  sms_subscription_status?: string;
  source?: string;
  stats?: SubscriberStats;
  status: SubscriberStatus;
  tags?: SubscriberTag[];
  tags_count?: number;
  timestamp_opt?: string;
  timestamp_signup?: string;
  unique_email_id?: string;
  unsubscribe_reason?: string;
  vip?: boolean;
  web_id?: number;
}

export interface SubscriberNote {
  _links?: MailchimpLink[];
  created_at?: string;
  created_by?: string;
  email_id?: string;
  id: number;
  list_id?: string;
  note: string;
  updated_at?: string;
}

export interface SubscriberActivityItem {
  action: string;
  campaign_id?: string;
  parent_campaign?: string;
  timestamp?: string;
  title?: string;
  type?: string;
  url?: string;
}

export interface SubscriberEvent {
  is_syncing?: boolean;
  name: string;
  occurred_at?: string;
  properties?: Record<string, unknown>;
}

export interface SubscriberGoal {
  data?: string;
  event?: string;
  goal_id: number;
  last_visited_at?: string;
}

// ─── Batch subscribe response (POST /lists/{id}) ─────────────────────

export interface BatchSubscribeRow {
  email_address: string;
  language?: string;
  merge_fields?: Record<string, unknown>;
  status?: SubscriberStatus;
  tags?: string[];
  vip?: boolean;
}

export interface BatchSubscribeResponse {
  _links?: MailchimpLink[];
  error_count: number;
  errors: Array<{ email_address: string; error: string; error_code?: string }>;
  new_members: Subscriber[];
  total_created: number;
  total_updated: number;
  updated_members: Subscriber[];
}

// ─── Segments ────────────────────────────────────────────────────────

export interface SegmentCondition {
  condition_type: string;
  extra?: string | undefined;
  field: string;
  op: string;
  value?: unknown;
}

export interface SegmentOptions {
  conditions?: SegmentCondition[] | undefined;
  match?: 'any' | 'all' | undefined;
}

export interface Segment {
  _links?: MailchimpLink[];
  created_at?: string;
  id: number;
  list_id?: string;
  member_count?: number;
  name: string;
  options?: SegmentOptions;
  type: 'saved' | 'static' | 'fuzzy';
  updated_at?: string;
}

// ─── Campaigns ───────────────────────────────────────────────────────

export type CampaignType = 'regular' | 'plaintext' | 'absplit' | 'rss' | 'variate';
export type CampaignStatus =
  | 'save'
  | 'paused'
  | 'schedule'
  | 'sending'
  | 'sent'
  | 'canceled'
  | 'canceling'
  | 'archived'
  | 'trash';

export interface CampaignRecipients {
  list_id?: string;
  list_is_active?: boolean;
  list_name?: string;
  recipient_count?: number;
  segment_opts?: {
    saved_segment_id?: number;
    prebuilt_segment_id?: string;
    match?: 'any' | 'all';
    conditions?: SegmentCondition[];
  };
  segment_text?: string;
}

export interface CampaignSettings {
  authenticate?: boolean;
  auto_footer?: boolean;
  auto_tweet?: boolean;
  drag_and_drop?: boolean;
  fb_comments?: boolean;
  folder_id?: string;
  from_name?: string;
  inline_css?: boolean;
  preview_text?: string;
  reply_to?: string;
  subject_line?: string;
  template_id?: number;
  timewarp?: boolean;
  title?: string;
  to_name?: string;
  use_conversation?: boolean;
}

export interface CampaignTracking {
  clicktale?: string;
  ecomm360?: boolean;
  goal_tracking?: boolean;
  google_analytics?: string;
  html_clicks?: boolean;
  opens?: boolean;
  text_clicks?: boolean;
}

export interface CampaignReportSummary {
  click_rate?: number;
  clicks?: number;
  ecommerce?: Record<string, unknown>;
  open_rate?: number;
  opens?: number;
  subscriber_clicks?: number;
  unique_opens?: number;
}

export interface Campaign {
  _links?: MailchimpLink[];
  ab_split_opts?: Record<string, unknown>;
  archive_url?: string;
  content_type?: string;
  create_time?: string;
  delivery_status?: { enabled?: boolean; can_cancel?: boolean; status?: string };
  emails_sent?: number;
  id: string;
  long_archive_url?: string;
  needs_block_refresh?: boolean;
  parent_campaign_id?: string;
  recipients?: CampaignRecipients;
  report_summary?: CampaignReportSummary;
  resendable?: boolean;
  rss_opts?: Record<string, unknown>;
  send_time?: string;
  settings?: CampaignSettings;
  social_card?: Record<string, unknown>;
  status: CampaignStatus;
  tracking?: CampaignTracking;
  type: CampaignType;
  variate_settings?: Record<string, unknown>;
  web_id?: number;
}

export interface CampaignContent {
  _links?: MailchimpLink[];
  archive_html?: string;
  html?: string;
  plain_text?: string;
  variate_contents?: Array<Record<string, unknown>>;
}

export interface CampaignChecklistItem {
  details: string;
  heading: string;
  id?: number;
  type: 'success' | 'warning' | 'error';
}

export interface CampaignChecklist {
  _links?: MailchimpLink[];
  is_ready: boolean;
  items: CampaignChecklistItem[];
}

// ─── Reports ─────────────────────────────────────────────────────────

export interface ReportBounces {
  hard_bounces: number;
  soft_bounces: number;
  syntax_errors: number;
}

export interface ReportForwards {
  forwards_count: number;
  forwards_opens: number;
}

export interface ReportOpens {
  last_open?: string;
  open_rate: number;
  opens_total: number;
  unique_opens: number;
}

export interface ReportClicks {
  click_rate: number;
  clicks_total: number;
  last_click?: string;
  unique_clicks: number;
  unique_subscriber_clicks?: number;
}

export interface IndustryStats {
  abuse_rate?: number;
  bounce_rate?: number;
  click_rate?: number;
  open_rate?: number;
  type?: string;
  unopen_rate?: number;
  unsub_rate?: number;
}

export interface CampaignReport {
  _links?: MailchimpLink[];
  ab_split?: Record<string, unknown>;
  abuse_reports?: number;
  bounces?: ReportBounces;
  campaign_title?: string;
  clicks?: ReportClicks;
  delivery_status?: { enabled?: boolean; can_cancel?: boolean; status?: string };
  ecommerce?: Record<string, unknown>;
  emails_sent?: number;
  facebook_likes?: Record<string, unknown>;
  forwards?: ReportForwards;
  id: string;
  industry_stats?: IndustryStats;
  list_id?: string;
  list_is_active?: boolean;
  list_name?: string;
  list_stats?: { sub_rate?: number; unsub_rate?: number; open_rate?: number; click_rate?: number };
  opens?: ReportOpens;
  preview_text?: string;
  rss_last_send?: string;
  send_time?: string;
  share_report?: { share_url?: string; share_password?: string };
  subject_line?: string;
  timeseries?: unknown[];
  timewarp?: unknown[];
  type?: CampaignType;
  unsubscribed?: number;
}

export interface ClickDetail {
  campaign_id?: string;
  click_percentage?: number;
  id: string;
  last_click?: string;
  total_clicks: number;
  unique_click_percentage?: number;
  unique_clicks: number;
  url: string;
}

export interface OpenDetail {
  campaign_id?: string;
  email_address: string;
  email_id?: string;
  list_id?: string;
  merge_fields?: Record<string, unknown>;
  opens?: Array<{ timestamp: string }>;
  opens_count?: number;
  vip?: boolean;
}

export interface LocationStat {
  country_code: string;
  opens?: number;
  region: string;
  region_name?: string;
}

export interface Unsubscribed {
  campaign_id?: string;
  email_address: string;
  email_id?: string;
  list_id?: string;
  merge_fields?: Record<string, unknown>;
  reason?: string;
  timestamp?: string;
  vip?: boolean;
}

// ─── Templates ───────────────────────────────────────────────────────

export interface Template {
  _links?: MailchimpLink[];
  active?: boolean;
  category?: string;
  created_by?: string;
  date_created?: string;
  date_edited?: string;
  drag_and_drop?: boolean;
  edited_by?: string;
  folder_id?: string;
  id: number;
  name: string;
  responsive?: boolean;
  share_url?: string;
  thumbnail?: string;
  type?: 'user' | 'base' | 'gallery';
}

export interface TemplateDefaultContent {
  _links?: MailchimpLink[];
  sections?: Record<string, unknown>;
}

// ─── File Manager ────────────────────────────────────────────────────

export type FileType = 'image' | 'file';

export interface File {
  _links?: MailchimpLink[];
  created_at?: string;
  created_by?: string;
  folder_id?: number;
  full_size_url: string;
  height?: number;
  id: number;
  name: string;
  size?: number;
  thumbnail_url?: string;
  type?: FileType;
  width?: number;
}

export interface FileFolder {
  _links?: MailchimpLink[];
  created_at?: string;
  created_by?: string;
  file_count?: number;
  id: number;
  name: string;
}

// ─── Search ──────────────────────────────────────────────────────────

export interface SearchMembersResponse {
  _links?: MailchimpLink[];
  exact_matches: { members: Subscriber[]; total_items: number };
  full_search: { members: Subscriber[]; total_items: number };
}

export interface SearchCampaignsResponse {
  _links?: MailchimpLink[];
  results: Array<{ snippet?: string; campaign: Campaign }>;
  total_items: number;
}

// ─── Service error data ──────────────────────────────────────────────

export type MailchimpErrorData = {
  status?: number;
  type?: string;
  title?: string;
  detail?: string;
  instance?: string;
  upstream?: MailchimpErrorBody;
  requiresPlan?: 'standard' | 'premium';
  [key: string]: unknown;
};
