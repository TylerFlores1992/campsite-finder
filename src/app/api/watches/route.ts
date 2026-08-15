import { NextRequest, NextResponse } from 'next/server';
import { watchOpenings } from '@/lib/watch-openings';
import { query, queryOne, mutate } from '@/lib/db/client';
import { requireAuth, syncUser, hasActiveSubscription } from '@/lib/auth';
import { createAlert, cancelAlert } from '@/lib/campflare/client';
import { getOpeningRate } from '@/lib/likelihood';
import { manageTokenFor, manageLink } from '@/lib/notifications/actions';
import { WATCH_LIMIT, MAX_DIVISIONS_PER_WATCH } from '@/lib/limits';
import { cleanSiteIds } from '@/lib/watch-mutes';
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

  // The divisions each watch covers, in ONE query rather than per watch. Best-effort:
  // this is a label on a card, and a watch list that fails because a badge could not be
  // computed is a worse outcome than a missing badge.
  try {
    const ids = rows.map((w) => String(w.id));
    if (ids.length > 0) {
      const divs = await query<{ watch_id: string; campground_id: string; name: string }>(
        `SELECT wc.watch_id, wc.campground_id, c.name
           FROM watch_campgrounds wc JOIN campgrounds c ON c.id = wc.campground_id
          WHERE wc.watch_id = ANY($1::text[]) ORDER BY c.name`,
        [ids],
      );
      const byWatch = new Map<string, Array<{ id: string; name: string }>>();
      for (const d of divs) {
        const list = byWatch.get(d.watch_id) ?? [];
        list.push({ id: d.campground_id, name: d.name });
        byWatch.set(d.watch_id, list);
      }
      for (const w of rows) {
        const list = byWatch.get(String(w.id));
        if (list && list.length > 1) w.divisions = list;
      }
    }
  } catch (err) {
    console.error('[watches] divisions lookup failed:', (err as Error).message);
  }

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
  const { campgroundId, campgroundIds, startDate, endDate, minNights = 1, siteType, flexNights, flexDays, autoCart, mutedSiteIds } = body;

  // ONE watch can cover several divisions of a park (migration 070). The representative
  // stays `watches.campground_id` — what the watch is named after and what every
  // existing reader already uses — and the extra divisions go in `watch_campgrounds`.
  //
  // A single-campground request writes NO join rows at all, so it is indistinguishable
  // from a pre-070 watch everywhere downstream, including in the poller.
  const requested: string[] = Array.isArray(campgroundIds) && campgroundIds.length > 0
    ? Array.from(new Set(campgroundIds.filter((c: unknown): c is string => typeof c === 'string' && c.length > 0)))
    : (typeof campgroundId === 'string' && campgroundId ? [campgroundId] : []);

  if (requested.length === 0) {
    return NextResponse.json({ error: 'campground_required', message: 'Pick a campground to watch.' }, { status: 400 });
  }
  if (requested.length > MAX_DIVISIONS_PER_WATCH) {
    // The bound that replaces the watch cap for park watches — see lib/limits.
    return NextResponse.json(
      {
        error: 'too_many_divisions',
        message: `A watch can cover up to ${MAX_DIVISIONS_PER_WATCH} parts of a park. Pick fewer.`,
      },
      { status: 400 },
    );
  }
  // The representative is the FIRST requested id, and it must be one of them — a
  // representative outside the set would name the watch after a campground it does not
  // actually watch.
  const primaryId: string = requested[0];

  /**
   * SITES MUTED AT CREATION (2026-08-15).
   *
   * Muting used to be reachable only from /manage/<token>, which the owner reported
   * almost nobody finds — so a control the poller genuinely honours was going unused.
   * The New watch screen now offers the same list, and the ids arrive here.
   *
   * THESE ARE THE POLLER'S IDS. They come from `/api/campgrounds/<id>/availability`,
   * i.e. `getAvailabilityFromRecGov` / `getRCAvailabilityForMonth` — the same functions
   * the poller reads, and RC's emits `String(unit.UnitId)`, which is exactly what
   * `findRCOpenUnit` and `findRCHeldUnits` compare. `worker/site-mute-creation.test.mts`
   * pins that chain, because a write into a column no reader can match is the failure
   * this feature has already had once.
   *
   * Validated by the SAME `cleanSiteIds` the manage screen's batch writes go through, so
   * the two surfaces cannot disagree about what a usable id is. Anything unusable is
   * DROPPED rather than 400'd: a bad entry in this list must never cost the user the
   * watch itself, which is the thing they actually came to create.
   *
   * A PARK WATCH SENDS NONE. The picker is hidden for a multi-division park (there is no
   * single inventory it could describe) and the client gates the field on that, so this
   * arrives empty rather than carrying one division's ids into a watch covering several.
   */
  const mutedVal = cleanSiteIds(mutedSiteIds);
  // Per-watch auto-cart. Defaults TRUE when the caller says nothing, which keeps the
  // account-level setting as the effective switch for older clients (and for the web
  // app before this shipped) — the poller still requires the account to be enrolled,
  // connected and entitled, so `true` here can never turn auto-cart ON for someone
  // who hasn't set it up. `false` is what finally makes the toggle mean something.
  const autoCartVal = autoCart === undefined ? true : !!autoCart;

  if (!startDate || !endDate) {
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
    [userId, primaryId, startDate, endDate]
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
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, site_type, flex_nights, flex_days, auto_cart, muted_site_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [userId, primaryId, startDate, endDate, minNights, siteType ?? null, flexNightsVal, flexDaysVal, autoCartVal, mutedVal]
  );

  // The divisions. WRITTEN ONLY FOR A GENUINELY MULTI-CAMPGROUND WATCH — a single
  // campground writes nothing, so the row stays indistinguishable from a pre-070 watch
  // and the poller's expansion falls back to `campground_id` exactly as before.
  //
  // NOT best-effort: if these rows fail, the watch would silently cover one division
  // instead of the four the user asked for, and nothing downstream could tell. Better to
  // fail the request and let them retry than to create a watch that quietly does less
  // than it says. The watch row is removed again so a retry is clean.
  if (requested.length > 1) {
    try {
      await mutate(
        `INSERT INTO watch_campgrounds (watch_id, campground_id)
         SELECT $1, c.id FROM campgrounds c WHERE c.id = ANY($2::text[]) AND NOT c.hidden
         ON CONFLICT DO NOTHING`,
        [row.id, requested],
      );
    } catch (err) {
      await mutate(`DELETE FROM watches WHERE id = $1`, [row.id]).catch(() => {});
      console.error('[watches] could not attach divisions:', (err as Error).message);
      return NextResponse.json(
        { error: 'divisions_failed', message: "Couldn't save the parts of that park. Try again." },
        { status: 500 },
      );
    }
  }

  const webhookBase = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  // Campflare only monitors recreation.gov — non-RIDB campgrounds (e.g. ReserveCalifornia)
  // are covered exclusively by our own Fly.io poller.
  const cgSource = await queryOne<{ source: string }>(
    `SELECT source FROM campgrounds WHERE id = $1`,
    [primaryId]
  );

  // Flexible watches skip Campflare: it monitors one fixed range per arrival and can't
  // express the weekend/window constraint, so a match could fire a wrong-dates alert.
  // Our own poller enforces the flex spec precisely, so it's the sole source for flex.
  if (!isFlex && cgSource?.source === 'ridb' && webhookBase && process.env.CAMPFLARE_API_KEY) {
    try {
      const alert = await createAlert({
        campground_ids: [primaryId],
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
