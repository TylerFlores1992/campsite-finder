import { query, queryOne } from '@/lib/db/client';

/**
 * Data for the admin Users list and the per-user page.
 *
 * WHY THE ACCESS COLUMNS ARE `EXISTS` AND NOT "THE LATEST SUBSCRIPTION ROW".
 * `lib/auth.hasAutocartEntitlement` carries the reason in as many words: "a user can
 * carry an old canceled row next to a live one, and which is 'latest' depends on
 * ordering trivia that entitlement must not." The first draft of this file ordered by
 * `updated_at DESC LIMIT 1` and would have shown "canceled" over a live subscription
 * for exactly those users — a dashboard confidently contradicting the gate it is
 * supposed to be reporting on. The predicates below mirror `hasActiveSubscription`
 * and `hasAutocartEntitlement`; if those change, change these.
 *
 * MEASURED 2026-08-15: only 2 of 26 real accounts have a subscription row at all, and
 * 8 have `is_beta`. A panel keyed on Stripe alone would render the owner's own account
 * — 6 watches, 530 alerts — as "no plan", which reads as a billing failure rather than
 * as the beta flag it is.
 *
 * DELIBERATELY NOT `import 'server-only'`, for the reason lib/stripe-client.ts already
 * records: it resolves to a throwing stub outside a server bundle, which would make
 * these queries unrunnable from a script — and running them from a script is how they
 * were checked against the real database before any UI existed. Client components must
 * therefore use `import type` from here; a value import would drag the db client into
 * the bundle and fail at runtime.
 *
 * ON "TRAFFIC": there is no analytics table in this database. Nothing records page
 * views or sessions, so the closest honest signal is `users.updated_at`, which
 * `syncUser` bumps on every authenticated page load. That is precisely what makes it
 * useless as "when did they change a setting" and usable as LAST SEEN — and it is
 * labelled that way in the UI on purpose, because CLAUDE.md already records someone
 * reading it the other way round.
 */

/** Clerk ids are `user_…`; the handful that are not are hand-inserted test rows.
 *  `\_` is escaped because `_` is a single-character wildcard in LIKE. */
const REAL_USER = `u.id LIKE 'user\\_%'`;

/** Mirrors lib/auth.hasActiveSubscription. */
const SUBSCRIBED = `(
  u.is_beta
  OR EXISTS (SELECT 1 FROM subscriptions s
              WHERE s.user_id = u.id AND s.status IN ('active','trialing'))
)`;

/** Mirrors lib/auth.hasAutocartEntitlement. */
const AUTOCART_ENTITLED = `(
  u.is_beta
  OR EXISTS (SELECT 1 FROM subscriptions s
              WHERE s.user_id = u.id
                AND s.status IN ('active','trialing')
                AND (s.tier = 'autocart' OR s.grandfathered))
)`;

/** The LIVE subscription, preferred over any lapsed sibling row. */
const LIVE_SUB = `LEFT JOIN LATERAL (
  SELECT s.status, s.tier, s.grandfathered, s.stripe_customer_id
    FROM subscriptions s
   WHERE s.user_id = u.id
   ORDER BY (s.status IN ('active','trialing')) DESC, s.updated_at DESC NULLS LAST
   LIMIT 1
) sub ON true`;

export interface AdminUserRow {
  id: string;
  email: string | null;
  created_at: string;
  /** users.updated_at — a LAST SEEN proxy. See the header. */
  last_seen_at: string | null;
  is_beta: boolean;
  has_phone: boolean;
  subscribed: boolean;
  autocart_entitled: boolean;
  autocart_enabled: boolean;
  autocart_connected: boolean;
  sub_status: string | null;
  sub_tier: string | null;
  grandfathered: boolean | null;
  live_watches: number;
  total_watches: number;
  alerts_sent: number;
  last_alert_at: string | null;
}

export async function listAdminUsers(): Promise<AdminUserRow[]> {
  return query<AdminUserRow>(`
    SELECT u.id,
           u.email,
           u.created_at::text            AS created_at,
           u.updated_at::text            AS last_seen_at,
           COALESCE(u.is_beta, false)    AS is_beta,
           (u.phone IS NOT NULL)         AS has_phone,
           ${SUBSCRIBED}                 AS subscribed,
           ${AUTOCART_ENTITLED}          AS autocart_entitled,
           COALESCE(u.autocart_enabled, false)   AS autocart_enabled,
           COALESCE(u.autocart_connected, false) AS autocart_connected,
           sub.status                    AS sub_status,
           sub.tier                      AS sub_tier,
           sub.grandfathered             AS grandfathered,
           COALESCE(w.live, 0)           AS live_watches,
           COALESCE(w.total, 0)          AS total_watches,
           COALESCE(n.sent, 0)           AS alerts_sent,
           n.last_alert_at::text         AS last_alert_at
      FROM users u
      ${LIVE_SUB}
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE w.active AND w.end_date > CURRENT_DATE)::int AS live,
               count(*)::int AS total
          FROM watches w WHERE w.user_id = u.id
      ) w ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS sent, max(n.created_at) AS last_alert_at
          FROM notifications n WHERE n.user_id = u.id AND n.status = 'sent'
      ) n ON true
     WHERE ${REAL_USER}
     ORDER BY u.updated_at DESC NULLS LAST`);
}

/** How many rows the list leaves out, so the exclusion is never silent. */
export async function countTestUsers(): Promise<number> {
  const r = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM users u WHERE NOT (${REAL_USER})`,
  );
  return r?.n ?? 0;
}

export interface AdminUserWatch {
  id: string;
  campground_id: string;
  campground_name: string | null;
  source: string | null;
  start_date: string;
  end_date: string;
  min_nights: number;
  site_type: string | null;
  flex_nights: number | null;
  flex_days: number | null;
  active: boolean;
  auto_cart: boolean;
  created_at: string;
  muted_count: number;
  expired: boolean;
}

export interface AdminUserChannel {
  channel: string;
  sent: number;
  failed: number;
  delivered: number;
  dropped: number;
}

export interface AdminUserAlert {
  created_at: string;
  channel: string;
  status: string;
  delivery_status: string | null;
  campground_id: string | null;
  kind: string | null;
}

export interface AdminUserHold {
  id: string;
  status: string;
  release_at: string | null;
  offered_at: string | null;
  unit_id: string | null;
  campground_name: string | null;
}

export interface AdminUserDetail {
  user: AdminUserRow & {
    email_alerts_opt_in: boolean | null;
    sms_consent_at: string | null;
    onboarded_at: string | null;
    autocart_verified_at: string | null;
    stripe_customer_id: string | null;
  };
  watches: AdminUserWatch[];
  channels: AdminUserChannel[];
  recentAlerts: AdminUserAlert[];
  holds: AdminUserHold[];
  favorites: number;
  pushTokens: number;
}

export async function getAdminUser(id: string): Promise<AdminUserDetail | null> {
  const user = await queryOne<AdminUserDetail['user']>(
    `SELECT u.id,
            u.email,
            u.created_at::text          AS created_at,
            u.updated_at::text          AS last_seen_at,
            COALESCE(u.is_beta, false)  AS is_beta,
            (u.phone IS NOT NULL)       AS has_phone,
            ${SUBSCRIBED}               AS subscribed,
            ${AUTOCART_ENTITLED}        AS autocart_entitled,
            COALESCE(u.autocart_enabled, false)   AS autocart_enabled,
            COALESCE(u.autocart_connected, false) AS autocart_connected,
            u.email_alerts_opt_in,
            u.sms_consent_at::text      AS sms_consent_at,
            u.onboarded_at::text        AS onboarded_at,
            u.autocart_verified_at::text AS autocart_verified_at,
            sub.status                  AS sub_status,
            sub.tier                    AS sub_tier,
            sub.grandfathered           AS grandfathered,
            sub.stripe_customer_id      AS stripe_customer_id,
            COALESCE(w.live, 0)         AS live_watches,
            COALESCE(w.total, 0)        AS total_watches,
            COALESCE(n.sent, 0)         AS alerts_sent,
            n.last_alert_at::text       AS last_alert_at
       FROM users u
       ${LIVE_SUB}
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE w.active AND w.end_date > CURRENT_DATE)::int AS live,
                count(*)::int AS total
           FROM watches w WHERE w.user_id = u.id
       ) w ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS sent, max(n.created_at) AS last_alert_at
           FROM notifications n WHERE n.user_id = u.id AND n.status = 'sent'
       ) n ON true
      WHERE u.id = $1`,
    [id],
  );
  if (!user) return null;

  // Each of these is independently non-fatal at the page level; a user with no push
  // tokens and a user whose token query failed must not look the same, so they are
  // separate queries rather than one join that can fail as a unit.
  const [watches, channels, recentAlerts, holds, favorites, pushTokens] = await Promise.all([
    query<AdminUserWatch>(
      `SELECT w.id, w.campground_id, c.name AS campground_name, c.source,
              w.start_date::text AS start_date, w.end_date::text AS end_date,
              w.min_nights, w.site_type, w.flex_nights, w.flex_days,
              COALESCE(w.active, false) AS active,
              COALESCE(w.auto_cart, false) AS auto_cart,
              w.created_at::text AS created_at,
              COALESCE(array_length(w.muted_site_ids, 1), 0) AS muted_count,
              (w.end_date <= CURRENT_DATE) AS expired
         FROM watches w
         LEFT JOIN campgrounds c ON c.id = w.campground_id
        WHERE w.user_id = $1
        ORDER BY w.active DESC, w.end_date DESC`,
      [id],
    ),
    query<AdminUserChannel>(
      `SELECT channel,
              count(*) FILTER (WHERE status = 'sent')::int   AS sent,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE delivery_status IN ('delivered'))::int AS delivered,
              count(*) FILTER (WHERE delivery_status IN ('undelivered','failed'))::int AS dropped
         FROM notifications WHERE user_id = $1
        GROUP BY channel ORDER BY channel`,
      [id],
    ),
    query<AdminUserAlert>(
      `SELECT created_at::text AS created_at, channel, status, delivery_status,
              campground_id, payload->>'kind' AS kind
         FROM notifications WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [id],
    ),
    query<AdminUserHold>(
      `SELECT h.id, h.status, h.release_at::text AS release_at,
              h.offered_at::text AS offered_at, h.unit_id, c.name AS campground_name
         FROM rc_hold_requests h
         JOIN watches w ON w.id = h.watch_id
         LEFT JOIN campgrounds c ON c.id = w.campground_id
        WHERE w.user_id = $1
        ORDER BY h.release_at DESC NULLS LAST LIMIT 10`,
      [id],
    ),
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM favorites WHERE user_id = $1`, [id]),
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM push_tokens WHERE user_id = $1`, [id]),
  ]);

  return {
    user,
    watches,
    channels,
    recentAlerts,
    holds,
    favorites: favorites?.n ?? 0,
    pushTokens: pushTokens?.n ?? 0,
  };
}
