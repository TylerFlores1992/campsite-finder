// Campflare API v2 types — https://docs-v2.campflare.com

export interface CampflareDateRange {
  starting_date: string; // YYYY-MM-DD
  nights: number;
}

export interface CampflareAvailabilityFilter {
  date_ranges: CampflareDateRange[];
  status?: string[];
  campsite_kinds?: string[];
  min_rv_length?: number;
  min_trailer_length?: number;
}

export interface CampflareAlertNotification {
  id: string;
  sent_at: string;
  campground_id: string;
  campsite_id: string;
  webhook_http_response_code: string;
  webhook_status: 'delivered' | 'error' | 'no-webhook';
  date_range: CampflareDateRange;
}

export interface CampflareAlert {
  id: string;
  status: 'active' | 'canceled' | 'expired';
  campground_ids: string[];
  parameters: CampflareAvailabilityFilter;
  created_at: string;
  canceled_at?: string;
  metadata?: Record<string, string>;
  webhook_override_url?: string;
  notifications: CampflareAlertNotification[];
}

export interface CreateAlertParams {
  campground_ids: string[];
  parameters: CampflareAvailabilityFilter;
  metadata?: Record<string, string>;
  webhook_override_url?: string;
}

export interface CampflareWebhookData {
  alert_id: string;
  notification_id: string;
  sent_at: string;
  campground_id: string;
  campsite_id: string;
  campsite_name: string;
  campground_name: string;
  reservation_url: string;
  date_range: CampflareDateRange;
  metadata?: Record<string, string>;
}

export interface CampflareWebhookPayload {
  event: 'v2-availability-alert-notification';
  data: CampflareWebhookData;
}
