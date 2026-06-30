// Campflare API types.
// IMPORTANT: These are modeled from public docs and the API evangelist repo.
// Confirm exact field names against the real API docs once you have credentials.
// Adapt client.ts accordingly — the rest of the app talks through these types.

export interface CampflareSubscription {
  id: string;           // e.g. "sub_abc123"
  status: 'active' | 'paused' | 'expired';
  facility_id: string;  // RIDB facility ID
  start_date: string;   // YYYY-MM-DD
  end_date: string;
  nights: number;
  webhook_url: string;
  metadata: Record<string, string>;
  created_at: string;
}

export interface CampflareWebhookPayload {
  event: 'availability.found' | 'subscription.expired';
  subscription_id: string;
  metadata: Record<string, string>; // includes watch_id we set on creation
  availability?: {
    facility_id: string;
    facility_name: string;
    campsite_id?: string;
    campsite_name?: string;
    campsite_type?: string;
    available_dates: string[]; // YYYY-MM-DD array
    booking_url: string;
  };
  timestamp: string;
}

export interface CreateSubscriptionParams {
  facility_id: string;
  start_date: string;
  end_date: string;
  nights?: number;
  webhook_url: string;
  metadata?: Record<string, string>;
}
