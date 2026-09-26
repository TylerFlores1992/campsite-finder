import { query } from '@/lib/db/client';
import { getStripe, stripeConfigured } from '@/lib/stripe-client';
import { tierForPriceId } from '@/lib/stripe-plans';
import { rcHoldBetaAllows } from '@/lib/autocart-beta';
import { CANCELLING } from './queries';
import { subscriberGroup, type SubscriberGroup } from './subscriber-group';

export { SUBSCRIBER_GROUPS, sourceLabel, subscriberGroup, type SubscriberGroup } from './subscriber-group';

/**
 * The Subscribers section of the admin Users tab, and the subscription history on the
 * per-user page. READ-ONLY: nothing here writes a row, and nothing calls a Stripe write
 * API — the one Stripe call is `subscriptions.list`, the same read the MRR tile makes.
 *
 * ## Who is a subscriber
 *
 * Anyone with a `subscriptions` row, whatever its status. Beta testers and comped trials
 * are NOT subscribers — they have access without paying — and the Users list already
 * badges them. Both flags are still shown per row here, because a subscriber can also be
 * a beta tester and then the flag, not the plan, is what is granting access.
 *
 * ## One row per USER, not per subscription
 *
 * A user can carry a canceled row beside a live one (`lib/auth` says so in as many
 * words). Listing rows would put one person in Active AND Lapsed at once. So each user
 * is represented by the same row `LIVE_SUB` in queries.ts prefers — live first, then the
 * most recently updated — and the others are counted and shown on the detail page.
 *
 * ## What the database does NOT hold, and why this reads Stripe at all
 *
 * `subscriptions` stores status, tier, grandfathered, provider and the cancel fields.
 * It has NO billing interval, NO period end and NO trial end. Those come from Stripe,
 * read-only, and only for Stripe rows. A store row (App Store / Play via RevenueCat) has
 * no source for them at all, and a failed Stripe read has no answer either — both render
 * as UNKNOWN, never as a blank that reads like "no renewal" or "no trial". The same goes
 * for a Stripe row Stripe does not return: absence from Stripe is not cancellation, so
 * the group is always OUR database's state and the Stripe facts only ever add detail.
 *
 * Deliberately not `import 'server-only'`, for the reason queries.ts records.
 */

/** Facts only Stripe holds. Every field is nullable because Stripe itself leaves them
 *  null (no trial, no cancellation); `found: false` is the separate "Stripe did not
 *  return this subscription" case, which is NOT the same as all-null. */
export interface StripeFacts {
  found: boolean;
  interval: 'monthly' | 'yearly' | 'other' | null;
  price_id: string | null;
  /** What `tierForPriceId` — the webhook's own derivation — says this price means. */
  price_tier: 'base' | 'autocart' | null;
  start_date: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean | null;
  canceled_at: string | null;
  ended_at: string | null;
  stripe_status: string | null;
}

/** Why the Stripe facts are missing, when they are. Rendered, never swallowed. */
export type StripeReading =
  | { state: 'ok'; facts: Map<string, StripeFacts> }
  | { state: 'unconfigured' }
  | { state: 'failed' };

const iso = (sec: number | null | undefined) =>
  typeof sec === 'number' ? new Date(sec * 1000).toISOString() : null;

/**
 * One paginated READ of every Stripe subscription (`status: 'all'`, so canceled ones
 * are included — the MRR tile's `status: 'active'` would drop trialing and lapsed).
 * Keyed by subscription id. Tiny today; paginated so it stays correct if it is not.
 */
export async function readStripeFacts(): Promise<StripeReading> {
  if (!stripeConfigured()) return { state: 'unconfigured' };
  try {
    const stripe = getStripe();
    const facts = new Map<string, StripeFacts>();
    for await (const sub of stripe.subscriptions.list({
      status: 'all',
      limit: 100,
      expand: ['data.items.data.price'],
    })) {
      const item = sub.items.data[0];
      const ivl = item?.price?.recurring?.interval;
      const priceId = item?.price?.id ?? null;
      facts.set(sub.id, {
        found: true,
        interval: ivl === 'month' ? 'monthly' : ivl === 'year' ? 'yearly' : ivl ? 'other' : null,
        price_id: priceId,
        price_tier: priceId ? tierForPriceId(priceId) : null,
        start_date: iso(sub.start_date),
        // Moved from the subscription onto its items in Stripe's 2025 API.
        current_period_end: iso(item?.current_period_end),
        trial_end: iso(sub.trial_end),
        cancel_at: iso(sub.cancel_at),
        cancel_at_period_end: sub.cancel_at_period_end,
        canceled_at: iso(sub.canceled_at),
        ended_at: iso(sub.ended_at),
        stripe_status: sub.status,
      });
    }
    return { state: 'ok', facts };
  } catch (err) {
    // Logged, never returned: Stripe error text can carry request details.
    console.error('[admin/subscribers] Stripe read failed', err);
    return { state: 'failed' };
  }
}

export interface SubscriberRow {
  user_id: string;
  email: string | null;
  is_beta: boolean;
  autocart_trial_until: string | null;
  status: string;
  tier: string;
  grandfathered: boolean;
  provider: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  started_at: string;
  updated_at: string;
  cancelling: boolean;
  cancel_at: string | null;
  /** How many OTHER subscription rows this user has (history, shown on the detail page). */
  other_rows: number;
  /** Mirrors lib/auth.hasAutocartEntitlement — the SQL mirror in queries.ts. */
  autocart_entitled: boolean;
}

export interface Subscriber extends SubscriberRow {
  group: SubscriberGroup;
  rc_hold_beta: boolean;
  /** null when there is no Stripe answer for this row — see `stripe_state`. */
  stripe: StripeFacts | null;
}

export interface SubscribersData {
  rows: Subscriber[];
  counts: Record<SubscriberGroup, number>;
  /** Whether the Stripe-only columns could be filled at all. */
  stripe_state: StripeReading['state'];
  /** The DATABASE read failed, so `rows` is empty for want of an answer, not for want of
   *  subscribers. Set only by the page's catch. */
  db_failed?: boolean;
}

export async function listSubscribers(): Promise<SubscribersData> {
  const [rows, reading] = await Promise.all([
    query<SubscriberRow>(`
      SELECT u.id                          AS user_id,
             u.email,
             COALESCE(u.is_beta, false)    AS is_beta,
             u.autocart_trial_until::text  AS autocart_trial_until,
             s.status, s.tier,
             COALESCE(s.grandfathered, false) AS grandfathered,
             s.provider,
             s.stripe_customer_id, s.stripe_subscription_id,
             s.created_at::text            AS started_at,
             s.updated_at::text            AS updated_at,
             ${CANCELLING('s')}            AS cancelling,
             s.cancel_at::text             AS cancel_at,
             (SELECT count(*)::int FROM subscriptions o
               WHERE o.user_id = u.id AND o.id <> s.id) AS other_rows,
             -- Each arm COALESCEd: NULL > NOW() is NULL, and false OR NULL is NULL,
             -- so a user with no trial would otherwise read as "unknown" rather than no.
             (   COALESCE(u.is_beta, false)
              OR COALESCE(u.autocart_trial_until > NOW(), false)
              OR EXISTS (SELECT 1 FROM subscriptions e
                          WHERE e.user_id = u.id
                            AND e.status IN ('active','trialing')
                            AND (e.tier = 'autocart' OR e.grandfathered))
             )                             AS autocart_entitled
        FROM users u
        JOIN LATERAL (
          SELECT * FROM subscriptions x
           WHERE x.user_id = u.id
           ORDER BY (x.status IN ('active','trialing')) DESC, x.updated_at DESC NULLS LAST
           LIMIT 1
        ) s ON true
       ORDER BY s.updated_at DESC NULLS LAST`),
    readStripeFacts(),
  ]);

  const counts: Record<SubscriberGroup, number> = { active: 0, trialing: 0, cancelling: 0, lapsed: 0 };
  const out = rows.map((r): Subscriber => {
    const group = subscriberGroup(r);
    counts[group]++;
    const stripe =
      reading.state === 'ok' && r.stripe_subscription_id
        ? (reading.facts.get(r.stripe_subscription_id) ?? { ...NOT_FOUND })
        : null;
    return { ...r, group, rc_hold_beta: rcHoldBetaAllows(r.user_id), stripe };
  });
  return { rows: out, counts, stripe_state: reading.state };
}

const NOT_FOUND: StripeFacts = {
  found: false,
  interval: null,
  price_id: null,
  price_tier: null,
  start_date: null,
  current_period_end: null,
  trial_end: null,
  cancel_at: null,
  cancel_at_period_end: null,
  canceled_at: null,
  ended_at: null,
  stripe_status: null,
};

export interface SubscriptionHistoryRow {
  id: string;
  status: string;
  tier: string;
  grandfathered: boolean;
  provider: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  store_transaction_id: string | null;
  created_at: string;
  updated_at: string;
  cancelling: boolean;
  /** The raw flag, shown beside `cancel_at` so a disagreement between them is visible. */
  cancel_flag: boolean;
  cancel_at: string | null;
}

export interface SubscriptionHistory {
  rows: Array<SubscriptionHistoryRow & { group: SubscriberGroup; stripe: StripeFacts | null }>;
  stripe_state: StripeReading['state'];
}

/** EVERY subscription row for one user, newest first — history, not just the latest. */
export async function getSubscriptionHistory(userId: string): Promise<SubscriptionHistory> {
  const rows = await query<SubscriptionHistoryRow>(
    `SELECT s.id::text AS id, s.status, s.tier,
            COALESCE(s.grandfathered, false) AS grandfathered,
            s.provider, s.stripe_customer_id, s.stripe_subscription_id,
            s.store_transaction_id,
            s.created_at::text AS created_at, s.updated_at::text AS updated_at,
            ${CANCELLING('s')} AS cancelling,
            COALESCE(s.cancel_at_period_end, false) AS cancel_flag,
            s.cancel_at::text AS cancel_at
       FROM subscriptions s
      WHERE s.user_id = $1
      ORDER BY (s.status IN ('active','trialing')) DESC, s.updated_at DESC NULLS LAST`,
    [userId],
  );
  // Only worth a Stripe round trip when there is a Stripe row to describe.
  const stripeReading: StripeReading = rows.some((r) => r.stripe_subscription_id)
    ? await readStripeFacts()
    : { state: 'ok', facts: new Map() };
  return {
    rows: rows.map((r) => ({
      ...r,
      group: subscriberGroup(r),
      stripe:
        stripeReading.state === 'ok' && r.stripe_subscription_id
          ? (stripeReading.facts.get(r.stripe_subscription_id) ?? { ...NOT_FOUND })
          : null,
    })),
    stripe_state: stripeReading.state,
  };
}
