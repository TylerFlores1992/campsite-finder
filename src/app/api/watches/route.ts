import { NextRequest, NextResponse } from 'next/server';
import { watchOpenings } from '@/lib/watch-openings';
import { query, queryOne, mutate } from '@/lib/db/client';
import { requireAuth, syncUser, hasActiveSubscription } from '@/lib/auth';
import { createAlert, cancelAlert } from '@/lib/campflare/client';
import { getOpeningRate } from '@/lib/likelihood';
import { manageTokenFor, manageLink } from '@/lib/notifications/actions';
import { WATCH_LIMIT } from '@/lib/limits';
import { currentUserIsAdmin } from '@/lib/admin';
import type { CampflareDateRange } from '@/lib/campflare/types';

const DAY_MS = 86_400_000;
const daysBetween = (fromISO: string, toISO: string) =>
  Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / DAY_MS);

function buildDateRanges(startDate: string, endDate: string, minNights: number): CampflareDateRange[] {
  const ranges: CampflareDateRange[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const cursor = new Date(start);
  while (cursor < end && ranges.length < 60) {
    ranges.push({ starting_date: cursor.toISOString().slice(0, 10), nights: minNights });
    cursor.setDate(cursor.getDate() + 1);
  }
  return ranges.length > 0 ? ranges : [{ starting_date: startDate, nights: minNights }];
}

export async function GET(request: NextRequest) {
  const userId = await requireAuth();

  // Paused watches (active = false) are HIDDEN by default so the existing
  // watches panel keeps behaving exactly as it does today — it renders every row
  // it receives as if it were running, and its quota count would jump.
  //
  // `?includeInactive=1` opts in. Without it a paused watch is invisible in the
  // app and only reachable through a magic link from an old alert, which is how
  // "pause" ended up meaning "disappear".
  const includeInactive = request.nextUrl.searchParams.get('includeInactive') === '1';

  // STARTED HERE, AWAITED AT THE RETURN, so the round trip overlaps the queries
  // below instead of adding to them. `requireAuth` reads the session token and
  // touches no network; `currentUserIsAdmin` goes through Clerk's `currentUser()`,
  // which is a real request — in series that is pure latency added to the list
  // every subscriber loads.
  //
  // Fails to NOT-admin, which shows the ordinary cap. That is the safe direction:
  // a failed lookup must never render "no limit", the same rule as `unknown` never
  // meaning "not subscribed". The catch is also what stops an unhandled rejection
  // if a query below throws before this is awaited.
  const isAdmin = currentUserIsAdmin().catch(() => false);

  const rows = await query<Record<string, unknown>>(
    `SELECT w.*, c.name AS campground_name, c.source AS campground_source
     FROM watches w
     JOIN campgrounds c ON c.id = w.campground_id
     WHERE w.user_id = $1
       AND ($2::boolean OR w.active = true)
       AND w.end_date > CURRENT_DATE
     ORDER BY w.active DESC, w.created_at DESC`,
    [userId, includeInactive]
  );

  // WHAT IS OPEN RIGHT NOW, and what is queued to release — both read from tables the
  // poller already maintains, so this costs one query and no provider traffic. See
  // lib/watch-openings for why nothing is fetched live and why the window is 15 minutes.
  // Best-effort: badges are decoration on top of a watch, never a reason to fail the list.
  try {
    const openings = await watchOpenings(rows.map((w) => String(w.id)));
    for (const w of rows) {
      const o = openings.get(String(w.id));
      if (!o) continue;
      w.open_sites = o.open;
      w.pending_holds = o.holds;
      w.carted_sites = o.carted;
    }
  } catch (err) {
    console.error('[watches] openings lookup failed:', (err as Error).message);
  }

  // Per-watch cancellation likelihood (feature E): "how often has this site had an
  // opening for a stay this far out?" — computed for THIS watch's lead time + nights,
  // attached only when enough history exists (else omitted → UI shows "still learning").
  // Best-effort: a likelihood hiccup must never break the watches list.
  const today = new Date().toISOString().slice(0, 10);
  await Promise.all(
    rows.map(async (w) => {
      try {
        const start = String(w.start_date).slice(0, 10);
        const lead = daysBetween(today, start);
        // `if (lead < 0) return` HERE RETURNED FROM THE WHOLE CALLBACK, not just the
        // likelihood step — so a watch whose stay had already begun skipped the
        // manage-token mint below and came back with no `manage_token`. WatchCard
        // renders a DISABLED Manage button in that case, so the moment a trip
        // started the user lost the only way to open, pause or delete that watch
        // from the app. Reported 2026-08-01 on a Jul 31–Aug 2 watch whose sibling
        // (Aug 14–16) was fine, which is exactly the shape of a lead-time gate.
        //
        // Scoped to the likelihood block now. Adding anything after this `try`
        // means the same trap is one stray `return` away — keep early exits inside
        // the block that owns them.
        if (lead >= 0) {
          const nights = (w.flex_nights as number | null) ?? Math.max(1, daysBetween(start, String(w.end_date).slice(0, 10)));
          const r = await getOpeningRate(w.campground_id as string, lead, { nights });
          if (r.enough && r.rate != null) w.likelihood = { rate: r.rate, samples: r.samples };
        }
      } catch {
        /* non-fatal — omit likelihood for this watch */
      }
      // Stable per-watch manage-page link for the panel's Manage button. Best-effort:
      // a mint hiccup just omits the button rather than breaking the list.
      // manage_token is the same token, unwrapped, so the redesign can route to
      // its own manage screen instead of the old page manage_url points at.
      // Both are returned: manage_url is what the existing panel reads.
      try {
        const t = await manageTokenFor(w.id as string);
        if (t) {
          w.manage_token = t;
          w.manage_url = manageLink(t);
        }
      } catch {
        /* non-fatal */
      }
    })
  );

  // null = no cap (admin). The UI must not recompute this from an email or a flag
  // of its own: lib/admin is `server-only` precisely so the roster never reaches the
  // bundle, and a second definition of "is this an admin?" is a second thing that
  // can disagree with the route actually enforcing it.
  return NextResponse.json({
    watches: rows,
    watchLimit: (await isAdmin) ? null : WATCH_LIMIT,
  });
}

export async function POST(request: NextRequest) {
  const userId = await requireAuth();

  // Ensure the users row exists BEFORE the subscription gate — beta flagging
  // and Stripe webhooks both need the row to be present.
  await syncUser(userId);

  // Require an active subscription (or beta flag) to create watches
  const subscribed = await hasActiveSubscription(userId);
  if (!subscribed) {
    return NextResponse.json(
      { error: 'subscription_required', message: 'An active subscription is required to set up campsite watches.' },
      { status: 402 }
    );
  }

  const body = await request.json();
  const { campgroundId, startDate, endDate, minNights = 1, siteType, flexNights, flexDays, autoCart } = body;
  // Per-watch auto-cart. Defaults TRUE when the caller says nothing, which keeps the
  // account-level setting as the effective switch for older clients (and for the web
  // app before this shipped) — the poller still requires the account to be enrolled,
  // connected and entitled, so `true` here can never turn auto-cart ON for someone
  // who hasn't set it up. `false` is what finally makes the toggle mean something.
  const autoCartVal = autoCart === undefined ? true : !!autoCart;

  if (!campgroundId || !startDate || !endDate) {
    return NextResponse.json({ error: 'campgroundId, startDate, endDate required' }, { status: 400 });
  }

  // Flexible dates (feature C): [startDate, endDate] is a search window and we match
  // any `flexNights` consecutive nights inside it, optionally weekends-only. NULL/absent
  // = a fixed whole-stay watch (legacy behavior). Validate the shape.
  let flexNightsVal: number | null = null;
  let flexDaysVal: 'weekend' | null = null;
  if (flexNights != null) {
    const n = Number(flexNights);
    const windowNights = Math.round(
      (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000
    );
    if (!Number.isInteger(n) || n < 1 || n > windowNights) {
      return NextResponse.json(
        { error: 'flexNights must be a positive integer no longer than the date window' },
        { status: 400 }
      );
    }
    flexNightsVal = n;
    if (flexDays != null) {
      if (flexDays !== 'weekend') {
        return NextResponse.json({ error: "flexDays must be 'weekend' or omitted" }, { status: 400 });
      }
      flexDaysVal = 'weekend';
    }
  }
  const isFlex = flexNightsVal != null;

  const existing = await queryOne<{ id: string; campflare_sub_id: string | null }>(
    `SELECT id, campflare_sub_id FROM watches
     WHERE user_id = $1 AND campground_id = $2 AND start_date = $3 AND end_date = $4 AND active = true`,
    [userId, campgroundId, startDate, endDate]
  );

  // Cap active watches per account. Replacing an existing watch (same campground +
  // dates) is fine since the net count doesn't grow.
  if (!existing) {
    // COUNT WHAT THE POLLER ACTUALLY RUNS. This used to count every `active` row,
    // including watches whose dates have passed — which the GET above hides
    // (`end_date > CURRENT_DATE`) and which `loadWatches` in the poller filters out
    // by the same rule, so they consume no capacity whatsoever. The result was an
    // account showing "4 of 6 watches running" and being refused a fifth, with the
    // three phantom rows invisible and therefore undeletable from the UI. Observed
    // on a real account 2026-08-01: 7 counted, 4 shown.
    //
    // The cap and the list must share one definition of "a watch you have"; if you
    // change the predicate here, change the GET query too.
    const cnt = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM watches
        WHERE user_id = $1 AND active = true AND end_date > CURRENT_DATE`,
      [userId]
    );
    // THE CAP IS LIFTED FOR ADMINS, and the constant is deliberately untouched.
    //
    // WATCH_LIMIT is not a billing lever — lib/limits.ts explains it as the only
    // user-facing number bounding how many rec.gov campground-months one account can
    // force onto a shard, at ~4 req/min each against a 15/min-per-IP budget. So this
    // is an exemption from a CAPACITY control, and it is worth knowing what it
    // spends: enough admin watches will push `poller.capacity` in /api/health/status
    // to warn and then fail, and past the ceiling every watch on every account just
    // gets slower. Nothing else goes red for over-capacity, so that gauge is the
    // thing to read after adding several.
    //
    // Checked server-side and not merely hidden in the UI: the client sends the
    // POST, so a hidden cap is not a cap.
    if (!(await currentUserIsAdmin()) && (cnt?.n ?? 0) >= WATCH_LIMIT) {
      return NextResponse.json(
        {
          error: 'watch_limit',
          message: `You can watch up to ${WATCH_LIMIT} campgrounds at a time. Remove one to add another.`,
        },
        { status: 409 }
      );
    }
  }

  if (existing) {
    if (existing.campflare_sub_id) {
      await cancelAlert(existing.campflare_sub_id).catch((err) =>
        console.warn('[watches] Failed to cancel old Campflare alert:', err.message)
      );
    }
    await mutate(`UPDATE watches SET active = false WHERE id = $1`, [existing.id]);
  }

  const [row] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, site_type, flex_nights, flex_days, auto_cart)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [userId, campgroundId, startDate, endDate, minNights, siteType ?? null, flexNightsVal, flexDaysVal, autoCartVal]
  );

  const webhookBase = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  // Campflare only monitors recreation.gov — non-RIDB campgrounds (e.g. ReserveCalifornia)
  // are covered exclusively by our own Fly.io poller.
  const cgSource = await queryOne<{ source: string }>(
    `SELECT source FROM campgrounds WHERE id = $1`,
    [campgroundId]
  );

  // Flexible watches skip Campflare: it monitors one fixed range per arrival and can't
  // express the weekend/window constraint, so a match could fire a wrong-dates alert.
  // Our own poller enforces the flex spec precisely, so it's the sole source for flex.
  if (!isFlex && cgSource?.source === 'ridb' && webhookBase && process.env.CAMPFLARE_API_KEY) {
    try {
      const alert = await createAlert({
        campground_ids: [campgroundId],
        parameters: {
          date_ranges: buildDateRanges(startDate, endDate, minNights),
          campsite_kinds: siteType ? [siteType] : undefined,
        },
        webhook_override_url: `${webhookBase}/api/webhooks/campflare`,
        metadata: { watch_id: row.id, user_id: userId },
      });
      await mutate(`UPDATE watches SET campflare_sub_id = $1 WHERE id = $2`, [alert.id, row.id]);
    } catch (err) {
      console.error('[watches] Campflare alert creation failed (watch still saved):', (err as Error).message);
    }
  }

  return NextResponse.json({ id: row.id, ok: true });
}

// Manage a watch's site mutes. Body: { id, unmuteSiteId } to un-mute one site, or
// { id, clearMutes: true } to clear them all. Ownership-scoped.
export async function PATCH(request: NextRequest) {
  const userId = await requireAuth();
  const body = (await request.json().catch(() => ({}))) as { id?: string; unmuteSiteId?: string; clearMutes?: boolean };
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  if (body.clearMutes) {
    await mutate(`UPDATE watches SET muted_site_ids = '{}' WHERE id = $1 AND user_id = $2`, [body.id, userId]);
  } else if (body.unmuteSiteId) {
    await mutate(
      `UPDATE watches SET muted_site_ids = array_remove(muted_site_ids, $3) WHERE id = $1 AND user_id = $2`,
      [body.id, userId, String(body.unmuteSiteId)]
    );
  } else {
    return NextResponse.json({ error: 'unmuteSiteId or clearMutes required' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireAuth();

  const watchId = request.nextUrl.searchParams.get('id');
  if (!watchId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const watch = await queryOne<{ campflare_sub_id: string | null }>(
    `SELECT campflare_sub_id FROM watches WHERE id = $1 AND user_id = $2 AND active = true`,
    [watchId, userId]
  );

  if (watch?.campflare_sub_id) {
    await cancelAlert(watch.campflare_sub_id).catch((err) =>
      console.warn('[watches] Failed to cancel Campflare alert on delete:', err.message)
    );
  }

  await mutate(
    `UPDATE watches SET active = false, campflare_sub_id = NULL WHERE id = $1 AND user_id = $2`,
    [watchId, userId]
  );

  return NextResponse.json({ ok: true });
}
