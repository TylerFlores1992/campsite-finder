# CampHawk — Dev Setup

How to work on this project from any machine.

## Prerequisites

- **Node.js 20+** and **git**
- A GitHub login (to push) — `gh auth login` or a personal access token
- Optional, only for deploying the pieces below: the **Vercel CLI** and **Fly CLI**
  (Fly CLI on Windows: `iwr https://fly.io/install.ps1 -useb | iex`, then reopen the
  shell and `flyctl auth login`; deploy commands must run from the repo root, since
  the Docker build context is the whole repo)

## 1. Get the code

```bash
git clone https://github.com/TylerFlores1992/campsite-finder.git
cd campsite-finder
npm install
```

## 2. Get the secrets (`.env.local`)

The app needs environment variables that are **not** in the repo (Supabase, Clerk,
Stripe, Mapbox, Resend, Twilio, the auto-cart token, etc.). Two ways to get them:

- **Pull from Vercel (recommended):**
  ```bash
  npm i -g vercel
  vercel login
  vercel link            # choose the campsite-finder project
  vercel env pull .env.local
  ```
- **Or copy** an existing `.env.local` from a machine that has one (via USB or a
  password-manager secure note — never email/Slack it; it contains live secrets).

> **In a Claude-web session there is no third step: the values are already injected as
> process env vars, and there is no `.env` file at all.** So `grep`ping `.env*` returns
> nothing and looks exactly like "this environment has no credentials" — it isn't.
> Check `printenv` (or `[ -n "${CLERK_SECRET_KEY:-}" ]`) instead. This cost a wrong
> "I can't build here" call on 2026-07-29 when Clerk, Stripe, Supabase and Mapbox were
> all present the whole time. Note these are the **LIVE** keys, not the test keys a
> local `.env.local` carries.

> Note: `.env.local` intentionally uses **Stripe TEST** keys for local dev, while
> Vercel Production uses LIVE keys. If you `vercel env pull`, double-check you're
> not running live Stripe against a local server.

> **Careful with anything that writes env vars for you.** `NEXT_PUBLIC_*` values are
> inlined at build time, so a wrong one sits harmless until the next build and then
> breaks the site in a way that looks like that day's code did it. A v0 integration
> put Clerk **dev** keys into Vercel Production once and took auth down on the next
> unrelated push. If auth or subscription state goes strange, check the Clerk
> hostname before anything else — see the env-var note in `docs/CONTEXT.md` for the
> full symptom list and the `/api/subscription/status` probe.

## 3. Run it

```bash
npm run dev          # http://localhost:3000
```

Only the Next.js website runs locally. The background worker and the auto-cart bot
run elsewhere (see Deploy).

> One behavioural difference locally: `GTC_AVAILABILITY_URL` is set on Vercel
> production only, so local search calls GoingToCamp **directly** instead of via the
> worker. That works from a home connection (the block is on Vercel's IPs, not
> datacenter IPs generally) — so GoingToCamp availability can look fine locally and
> still need the worker path in production.
>
> TN/SC is the mirror image: `TNSC_AVAILABILITY_URL` is set on the **Fly worker**
> only, so the worker uses the Vercel proxy while local runs and the sync call the
> portal **directly** (fine from a residential IP, and from a web session through the
> agent proxy — the portal's WAF blocks Fly, not homes). So TN availability can look fine locally and
> from Vercel, yet the worker still needs the proxy — which is exactly what bit us:
> the worker got `403 on landing` until `TNSC_AVAILABILITY_URL` was wired.

## Deploy — three separate targets

| Piece | Lives on | How to deploy |
|-------|----------|----------------|
| **Website** (Next.js) | Vercel | **Auto-deploys on every `git push` to `master`,** and `camphawk.app` auto-re-aliases to the new Production build (`autoAssignCustomDomains` is on). The old "build is `Ready` but the domain still points at the previous deployment" symptom (observed 2026-07-20) was **root-caused 2026-07-25**: pushing the *same commit SHA* to both a `claude/*` working branch and `master` made Vercel dedup by SHA — the branch preview built first and the master push then sometimes created **no** Production deployment, so auto-assign had nothing to move (and manual REST redeploys don't trigger auto-assign either). Fixed by **`vercel.json` → `git.deploymentEnabled: { "claude/*": false }`** so agent branches no longer spawn a shadowing preview; every `master` push now builds a fresh Production deployment and the domain follows on its own. So: **push to `master` and you're done — no `vercel --prod` / re-alias needed.** (If you ever *do* see a stale domain, `vercel --prod` from the repo root, or `POST /v2/deployments/<id>/aliases` with the READY Production deployment id, still forces it.) Also: **a new `SYNC_SECRET`-protected `/api/*` route 404s until it's added to `isPublicRoute` in `src/middleware.ts`** (Clerk's `auth.protect()` returns 404, not 401 — see `docs/CONTEXT.md`). |
| **Alert worker** (`worker/poller.ts`) | Fly.io app `campsite-finder-worker` | **GitHub Action `worker-deploy.yml` — this is the path now (added 2026-07-28).** It fires automatically on any push to `master` touching `worker/**`, `src/lib/{availability,sources,notifications,db}/**`, `src/lib/booking-url.ts` or the lockfile, and can be run by hand from the Actions tab (or dispatched by an agent). It builds with `--local-only` on the runner, restarts **exactly the machines that were running before** the deploy, then polls `/api/health/worker` and **fails the run if no fresh heartbeat lands in 4 minutes** — so the "deploy succeeded, alerting is dead" trap below can no longer pass silently. Needs one repo secret, `FLY_API_TOKEN` (`fly tokens create deploy -a campsite-finder-worker`). The auto-trigger is what kills the stale-worker bug: the worker compiles in the RA/UseDirect/GoingToCamp/TN-SC registries, so **adding a state used to need a deploy someone had to remember**, and a stale worker never alerts for it, silently. By hand it's still `flyctl deploy --config worker/fly.toml --dockerfile worker/Dockerfile --remote-only` from the repo root, followed by `flyctl machine start <primary-id>` — see the web-session note below for why building that way fails from a sandbox. Serves `POST /gtc/availability` for the website's search page, and calls **out** to Vercel's `/api/tnsc-availability` for TN openings (needs `TNSC_AVAILABILITY_URL` set — see the proxy note below). **TWO machines since 2026-08-02** (`SHARD_COUNT=2`, both iad), each polling a disjoint half of the campgrounds — the Action restarts both, and a deploy that leaves one down means its shard is unpolled, which `poller.shards` fails on. To add capacity: `flyctl machine clone <id> --region iad` FIRST, then raise `SHARD_COUNT` and `min_machines_running` together. |
| **Auto-cart bot** (`scripts/auto-cart-bot/`) | The mini PC only | `git push`, then EITHER click **Admin → System Health → "Update now"** (the box applies it on its next 15-second poll, re-checking its own release guard, and rolls back if the new code does not check in) OR run `mini-pc/update.bat` on the box via RustDesk. **The on-demand path took five bugs to get working and was proven end to end 2026-08-11** — see CONTEXT. **Stopping is `mini-pc/stop-all.ps1` and every start path calls it**, which is what makes "the update just added another five windows" structurally impossible; it kills by command line, clears the profile locks, kills orphaned bot Chromium, then RE-CHECKS and refuses to let anything launch on survivors. **All four bot processes run under `mini-pc/supervise.ps1`** (restart with backoff, give up loudly after 5 exits in 10 min); cloudflared is the deliberate exception, it reconnects itself. It can't run anywhere else — it drives real logged-in recreation.gov **and ReserveCalifornia** browsers. **FIVE processes since 2026-08-07**, all started by `mini-pc/start-all.bat`: tunnel, bot, broker, `rc-keepwarm.mjs`, `rc-hold-runner.mjs`. **`update.bat` and `start-all.bat` delete the Chromium profile locks before relaunching** — a hard `taskkill` never runs the lock's release, so the file survives and reads as *held* for ten minutes, during which the RC processes skip every pass; an update at 07:55 would silently cost the 8am cart. **Never type the node commands into a fresh PowerShell window** — it opens in `C:\Users\<you>` and fails with `MODULE_NOT_FOUND`, which reads like a broken install rather than a wrong directory. **LEAVE THE RESERVECALIFORNIA BROWSER WINDOW ALONE (2026-08-08).** `rc-keepwarm.mjs` is now RESIDENT: it holds a Chromium open on reservecalifornia.com permanently, because RC's SPA only renews its Okta token while a page is actually loaded — the old open-for-8-seconds-every-20-minutes loop had under a 1% chance of being present when that fired, and sessions died after about one access token. **Minimising it is fine** (it launches with Chrome's background/occluded throttling disabled, without which a hidden tab renews nothing while looking healthy). **Closing it** costs ~30s while the loop notices the dead context and reopens. It closes itself for a second or two whenever the hold runner needs the profile — that hand-off is the `.camphawk-profile-wanted` flag, and exactly one Chromium is ever open on that profile. Use `mini-pc/rc-save-password.bat` (run ONCE — stores the RC password DPAPI-encrypted so the keep-warm signs itself in ~15 min before a hold, which is what ends the every-morning sign-in; opens no browser and stops nothing, so it is safe even at 07:55), `mini-pc/rc-login.bat` (the human fallback when the auto-login reports it could not get in) and `mini-pc/rc-check.bat` (is it working?); all three `cd` themselves. **The password is never in `.env`** — that file is git-ignored but world-readable to every process on the box and ends up in screenshots from a machine that is screen-shared; `credstore.mjs` (CurrentUser DPAPI) is the store, and it is the one the rec.gov bot already used. **Never kill these by WINDOW TITLE** — `powershell -NoExit` retitles its own console, so the filter matches nothing and the old processes survive holding the RC profile; `rc-login.bat` did exactly that until 2026-08-08 and now kills by command line. `update.bat` was immune only because it also ran `taskkill /IM node.exe /F` — **no longer true and no longer needed since 2026-08-11**: it delegates to `stop-all.ps1`, which kills by command line and verifies. `rc-login.bat` keeps a narrower list on purpose (an RC sign-in must not stop the rec.gov bot or the broker) and now relaunches the pair **supervised**; until 2026-08-11 it relaunched them bare, so a hand sign-in quietly downgraded the two processes it was fixing. **Never kill by IMAGE NAME either** — `taskkill /IM chrome.exe /F` was in `update.bat` and closes the browser of whoever is sitting at the machine. **Ask the box for `memory` before blaming anything else when it misbehaves** — on 2026-08-12 `supervise.ps1` could not start a shell ("the paging file is too small", then an OutOfMemoryException), and a supervisor that cannot launch cannot restart anything; `disk-free` said 404 GB that same night, so the limit that ran out was COMMIT, not disk, and `list-processes` cannot see any Chromium by construction. `mini-pc/fix-pagefile.bat` (admin) raises the ceiling and needs a reboot, so time it like an update. **Count FIVE windows after an update, and only five** — the completion message said "three" for weeks, so a missing RC pair looked like a clean run; ten means stop-all did not do its job. |
| **Mobile app** (Capacitor) | App Store / Play Store | Thin native shell around the live site — most changes ship via the normal web deploy (the app loads `camphawk.app`); you only rebuild the binary for native/plugin/icon changes. **Neither binary needs a machine of your own** — both build on Codemagic and are started from its web UI (works on a phone): `ios-testflight` (→ TestFlight) and `android-release` (→ signed AAB + sideloadable APK). **Both run on `mac_mini_m2`** — not because Android needs a Mac, but because this Codemagic plan has no Linux instance at all; see the Android section for the one-second, zero-log failure that fact produces. Paid dev accounts still required. See **"Building the mobile app"** below. Push needs `FCM_SERVICE_ACCOUNT` on **both Vercel and the Fly worker**. |

## Catalog syncs (which campgrounds exist)

Availability is checked live per watch; the **catalog** (which campgrounds/units
exist) is populated by these syncs. Data is national and shared, so you rarely run
these by hand — but here's how each source refreshes:

| Source | Runs | Manual re-sync |
|--------|------|----------------|
| **RIDB** (rec.gov, federal) | Nightly GitHub Action (`.github/workflows/nightly-sync.yml`) | `npx tsx scripts/run-sync.ts ALL` |
| **ReserveAmerica** (state parks) | Same nightly Action (added step) | `npx tsx scripts/run-sync-ra.ts` (all contracts), or `npx tsx scripts/run-sync-ra.ts DE` for one state — use the single-state form when adding one, a full run re-scrapes ~18 states |
| **GoingToCamp** (WA/MI/WI/MS) | On the **Fly worker** hourly (`gtcSyncIfDue` in `worker/poller.ts`, fires at 22h staleness) — NOT in the GitHub Action, because the Camis WAF blocks Vercel and the worker throttles itself | `npx tsx scripts/run-sync-gtc.ts` (all), or `... run-sync-gtc.ts WA` for one state. Needs `NEXT_PUBLIC_MAPBOX_TOKEN` — most rows are geocoded from their full street address. |
| **UseDirect** (state parks) | On the **Fly worker** hourly (`rcSyncIfDue` in `worker/poller.ts`) — NOT in the GitHub Action, because some RDR hosts WAF-block datacenter IPs and it routes through the `/api/rc-proxy` on Vercel | `npx tsx scripts/run-sync-ud.ts` (run from a **residential IP** — it forces direct, no proxy) |
| **TN/SC State Parks** (ColdFusion portal) | **Vercel Cron, daily at 09:30 UTC** — `crons` in `vercel.json` → `GET /api/cron/sync-tnsc` (2026-08-04). It runs on **Vercel** because that is the only scheduled egress this portal's WAF allows: the Fly worker is blocked (hence `/api/tnsc-availability`) and **GitHub Actions runners are blocked too** — measured, run `30878585899` with `only: tnsc` returned "0 parks, 1 error" for both states in under a second, the same answer ReserveCalifornia's WAF gives, so that step was written, tested and removed rather than shipped as a nightly red run. **`CRON_SECRET` is set on Vercel Production and the schedule is LIVE and verified end-to-end (2026-08-04: real cron call → 73 parks, 0 errors, 10.4s; three bad-credential shapes 401; `catalog.syncs` 2 stale → 0 stale).** Setting the variable was not sufficient on its own — **Vercel bakes env vars into a deployment, so production kept 401ing the CORRECT bearer until it was redeployed**; budget a redeploy for any new secret, and don't read that 401 as a wrong value. It only registers on a **production deploy from `master`** — before that was true, TN/SC had no scheduled sync and `catalog.syncs` in `/api/health/status` kept returning to `warn` 48h after each hand-run, which is what it did for twelve days. To run it by hand, `x-sync-secret: <SYNC_SECRET>` works on the same route — no need to know `CRON_SECRET`. 09:30 UTC is deliberately 30 min after the nightly Action so the two don't overlap. | `NODE_USE_ENV_PROXY=1 npx tsx scripts/run-sync-tnsc.ts TN` / `... SC` (or no arg = both). Runs from a residential IP **or from a web session** — the agent proxy reaches this portal, verified 2026-08-04 (TN 39 + SC 34 parks, 0 errors, ~9s each). **The flag is load-bearing**: Node's fetch ignores the proxy without it and the WAF answers 403, which reads as "datacenter IPs are blocked" when the proxy would have gone straight through. TN coords are embedded; **SC coords come from a curated `SC_PARK_COORDS` table** (portal ships none; name-geocoding was worthless — see `docs/CONTEXT.md`), so no Mapbox token is needed. |

**Campground photos (RIDB only).** The nightly RIDB sync now fetches media per
facility, so anything it touches arrives with photos and there is no recurring job here.
The one-time backfill for rows that predate the fix RAN 2026-07-27 (3,775 of 4,469
filled). If it's ever needed again:
`RIDB_API_KEY=... npx tsx scripts/backfill-ridb-photos.ts` — safe to re-run and to
interrupt, only touches rows whose `photos` are empty, and writes no other column.
Supports `--limit=N` and `--dry-run`.

> **`RIDB_API_KEY` lives on Vercel, NOT on the Fly worker.** Worth knowing before you
> plan where to run anything RIDB-flavoured: a web/agent session can't run this script,
> because the key isn't in the environment it can reach. The nightly sync gets it from
> the GitHub Action's secrets.

**Feature-E probe roster (not a catalog sync) — TURNED OFF 2026-07-30.** Both switches
are off: `PROBE_ENABLED = "false"` in `worker/fly.toml`, and all 502 `probe_targets`
rows are `active = false`. Nothing is being probed and nothing is accruing. The reason
was cost — the 327 UseDirect targets each spent a Vercel function invocation through
`/api/rc-proxy`, ~15,700/day, for a signal `SHOW_LIKELIHOOD` hides. **Running the seed
script below sets `active = true` again**, which is exactly what `PROBE_ENABLED` is
there to stop; flip both, deliberately, if you mean to resume.

`scripts/seed-probe-targets.ts` populates `probe_targets` — the high-demand campgrounds
the worker probes hourly for the cancellation-likelihood signal. It's a **one-time-ish
demand scan** (keeps sites booked solid on a peak weekend), run by hand per source:
`NODE_USE_ENV_PROXY=1 npx tsx scripts/seed-probe-targets.ts --source=<src>` (add `--dry`
to preview). As of 2026-07-25 the roster was **502 rows** across rec.gov, all 10
UseDirect states, and GoingToCamp (the seed's `isOpenInRange` supports all three; drop
`--source` to default to rec.gov). Seeding is data-only — the worker reads
`probe_targets` live, so no redeploy; flipping `PROBE_ENABLED` does need one.
Migrations `020_availability_history` + `021_probe_targets` first.
Sanity-check the resulting signal with `scripts/likelihood-readout.mts`. See
"Cancellation-likelihood (feature E)" in `docs/CONTEXT.md`.

Adding a state to an **existing** platform is usually a one-line registry entry —
`RA_CONTRACTS` (`src/lib/sources/reserveamerica/client.ts`), `USEDIRECT_PROVIDERS`
(`src/lib/sources/reservecalifornia/providers.ts`), `GOINGTOCAMP_PROVIDERS`
(`src/lib/sources/goingtocamp/providers.ts`), or `TNSC_PROVIDERS`
(`src/lib/sources/tnsc/providers.ts`) — plus a sync run and the coverage copy
(the `COVERAGE` constants in `src/lib/coverage.ts` — derive them with
`npx tsx scripts/coverage-readout.mts`, never by hand; the marketing home and the
signed-out footer both read from there). **South Carolina shipped 2026-07-22**
(the last cheap-ish add): it reused TN's ColdFusion backend + Vercel proxy but needed
its own `html-grid` catalog/availability branch in `client.ts` (slug-keyed, curated
coords) — see the SC recon note in `docs/CONTEXT.md`. Every remaining state needs a
brand-new adapter, not a registry entry.

**Then deploy the Fly worker.** The worker imports those registries, so a push alone
leaves it stale and the new state's watches never alert — silently, with no error.
Confirm with `scripts/e2e-gtc-alert.mts` / `scripts/e2e-tnsc-alert.mts` (they send a
real email/SMS; see `docs/CONTEXT.md`). `e2e-tnsc-alert.mts` targets `tnsc-TN-%` — swap
the id filter to `tnsc-SC-%` to re-verify SC (done once at launch, 2026-07-22), and run
it with `NODE_USE_ENV_PROXY=1` from a web session (see the session-environment section).
With SC shipped, there are **no cheap registry adds left** — every remaining state needs
a new adapter. See `docs/CONTEXT.md` before going hunting.

## Building the mobile app (Capacitor)

CampHawk ships to the App Store / Play Store as a **thin native shell** around the live
site, via Capacitor. `capacitor.config.ts` sets `server.url =
https://camphawk.app/search`, so the webview loads production — Clerk auth, Stripe, and SSR all work unchanged, and a
`git push` deploy reaches the app instantly with **no store release**. The native
surfaces are **push** (APNs/FCM) and the bridge in `src/components/NativeBridge.tsx`,
plus **status-bar / safe-area** handling (`@capacitor/status-bar`) so the webview clears
the notch (see the edge-to-edge gotcha below).

**It opens on `/search` (Explore), not `/`.** `/` is a funnel for people who haven't
installed the app yet, and it's the only page carrying Stripe checkout — which native
detection suppresses *client-side*, so it renders for one frame before hydration
replaces it. Store review takes screenshots. Don't point `server.url` back at the root.
Details in `docs/CONTEXT.md` → store-billing.

**Notifications.** Push is a THIRD alert channel next to email/SMS. The worker's
`dispatchNotifications` already fans out to it (`dispatchPush` in
`src/lib/notifications/index.ts`); it delivers via **FCM HTTP v1** (`src/lib/notifications/push.ts`),
which relays to APNs for iOS, so it's one integration + one credential. Set
**`FCM_SERVICE_ACCOUNT`** (the full service-account JSON as a single env string) on
**both Vercel AND the Fly worker** — the worker is what dispatches live alerts, so a
missing value there means push silently never fires (the usual stale-worker trap). Unset
= no-op (logs, like an unconfigured Twilio). Apply migration `023_push_tokens.sql` to
Supabase first (by hand, like 020/021). Devices register their token via
`POST /api/user/push-token` (Clerk-authed; the bridge calls it on sign-in).

> **Migrations are applied by hand** (020/021/023, and **`024_cost_items` +
> `025_cost_items_billing_period`** for the admin Costs tab; 025 applied to prod
> 2026-07-27). Also applied to prod 2026-07-30: **`026_watch_site_alerts`** (per-site
> alert cooldown — the poller depends on this table existing, so a worker deploy
> without it would throw on every claim), **`027_rls_action_tokens_canary`**,
> **`028_cost_items_one_time`**, **`029_cost_items_lifetime`** and
> **`030_cost_items_single_date`** (which drops `ended_at` that 029 had just added, and
> backfills `started_at` from `created_at` — see the Costs notes in CONTEXT).
> Note `watch_id` in 026 is TEXT, because `watches.id` is TEXT despite holding
> UUID-shaped values — a UUID column there fails with "foreign key constraint cannot
> be implemented". In a web session you can apply one directly:
> `sb.rpc('exec_dml', { query_text: <sql>, with_result: false })` with the service role —
> `exec_dml` runs DDL, so no Supabase SQL-editor round-trip needed. (PostgREST `.from()`
> won't see a brand-new table until its schema cache reloads; read back via `exec_select`.)
>
> **`exec_dml` REFUSES an `UPDATE` with no `WHERE`** — a guard against a fat-fingered
> whole-table write. A migration that legitimately backfills every row therefore needs a
> tautological-looking clause: `UPDATE subscriptions SET grandfathered = true WHERE
> grandfathered = false` (032). Write the migration file that way too, so re-applying it
> from the file doesn't fail where the by-hand run succeeded.
>
> **`039_alert_on_transition`** (2026-08-06 — `watch_site_alerts.last_seen_open_at`, so
> a site that stays open stops re-alerting every hour) and **`040_still_open_nudge`**
> (2026-08-06 — `watch_site_alerts.nudged_at`, the one 6-hour follow-up). **Both applied
> to prod 2026-08-06**, before the worker code that reads them, per the rule below.
>
> **`050_rc_hold_client_reports`** (2026-08-09 — what the injected hand-off script says
> about itself, so the two RC cart POSTs stop being unprovable on mobile),
> **`051_bot_update_requests`** (2026-08-10 — the "Update now" flag; one row, id = 1),
> **`052_autocart_nudge`** (2026-08-11 — `users.autocart_enabled_at` /
> `autocart_nudge_sent_at`) and **`053_bot_commands`** (2026-08-11 — the mini-PC
> diagnostics queue). **All applied to prod on the day.**
>
> **`058_rc_app_session_probes`** (2026-08-13 — one row per run of the in-app RC session
> probe, so "how long does the app's ReserveCalifornia session survive?" is a series rather
> than a memory. **Applied to prod 2026-08-13**, before the route that writes it, and the
> UPSERT was exercised end-to-end against prod with a sentinel `probe_id` that was deleted
> afterwards.) It needs no worker deploy and no app rebuild — the probe script is served by
> `/api/rc-precart` and the panel is web-side, so a push to `master` reaches installed apps.
>
> **052 SHIPPED FROM A PARALLEL SESSION AS `051` AND HAD TO BE RENUMBERED ON MERGE.** That
> number was already taken and already applied. It is not a cosmetic clash: a runner
> tracking applied migrations by number would treat it as done, skip it silently, and
> `/api/user/autocart` would 500 on every toggle against columns that never got created.
> **Check `ls src/lib/db/migrations/ | tail` before numbering one**, especially when two
> sessions are open.
>
> **`047_rc_session_since`** (2026-08-08 — `rc_runner_heartbeat.session_since` and
> `session_live_since`, so a session's LIFETIME is measured rather than estimated from
> when somebody happened to look; the two-column split is because `session_since` is
> overwritten by the death it records, taking the sign-in with it). **Applied to prod
> 2026-08-08.** It immediately falsified a confident hypothesis — see the keep-warm
> section of `docs/CONTEXT.md`.
>
> **`046_rc_session_health`** (2026-08-08 — `rc_runner_heartbeat.session_ok/at/detail/source`
> plus `rc_hold_requests.last_attempt_at/note`, so a runner that polls happily and cannot
> drive RC stops reading as healthy; see the RC-holds section of `docs/CONTEXT.md`).
> **Applied to prod 2026-08-08**, before the code that reads it. **It needs a mini-PC
> update to produce data** — `mini-pc/update.bat`, or the "Update now" button since
> 2026-08-10 — and until that happens
> `autocart.rc_session` correctly reads "never reported" (a warn, so the admin banner is
> amber). Unknown is not healthy.
>
> **Later migrations, all applied by hand to prod the same way:** `031_poller_shards`
> (the shard lease, 2026-07-31), `032_subscription_tiers`
> (`subscriptions.tier` + `grandfathered` — the Auto-Cart plan, 2026-08-01) and
> `033_recgov_rate_profile` (the full-day 429 profile table, 2026-08-01),
> `034_alert_prefs` (`users.email_alerts_opt_in` / `sms_consent_at` / `onboarded_at`
> for the welcome step, 2026-08-01), `035_watch_auto_cart_backfill` (2026-08-01) and
> `036_autocart_carted_history` (2026-08-03 — a partial index on
> `autocart_jobs (watch_id, campsite_id)` for the one-cart-per-site rule; index only,
> no schema change) and `037_sync_claims` (2026-08-04 — one machine runs each nightly
> catalog sync; see the sharding section of `docs/CONTEXT.md` for why both machines were
> running the whole thing).
> None needs a worker deploy by itself, but 032, 033, 035, 036 and 037 are all read by
> worker code, so ship the migration BEFORE the code that queries it.
>
> **035 is a BACKFILL whose absence would have broken production.** `watches.auto_cart`
> had existed since 001 and had never been written — every row was the `false` default —
> so making the poller honour it would have switched auto-cart off for everyone. The
> migration sets it true for exactly the active, unexpired watches of `autocart_enabled`
> accounts (the ones carting at the time), which makes the code change a no-op on
> existing data. If you ever start honouring a column that has always been ignored,
> check what's actually in it first.

> **Admin cost tracking needs migrations `024_cost_items.sql` and
> `025_cost_items_billing_period.sql`** (applied by hand, like the others; 024 to prod
> 2026-07-26, 025 on 2026-07-27). 025 **renames `monthly_cents` to `amount_cents`** and
> adds `billing_period`, so a yearly plan is stored as the invoiced figure and the
> monthly view is derived — see `docs/CONTEXT.md` for why one column, not two. It backs the editable "Fixed monthly costs"
> table in the admin **Costs** tab (`/admin`). The per-unit usage rates are non-secret env
> vars (`COST_PER_SMS_USD` etc.) with in-code defaults — see `docs/CONTEXT.md`. Nothing to
> deploy beyond a `master` push; no worker or secret involved.

**The native projects are NOT committed** (`ios/`, `android/` are git-ignored). **The
normal route is Codemagic — neither store build needs a machine of your own** (see the
two Codemagic sections below; both start from a web UI that works fine on a phone). The
local commands below are for hands-on debugging, not the usual path:

```
npx cap add ios          # needs macOS + Xcode      (or use the Codemagic workflow)
npx cap add android      # needs Android Studio     (or use the Codemagic workflow)
npm run cap:assets       # brand the icons + splash from assets/ (see below) — after cap add
npx cap sync             # or: npm run cap:sync — copies config + plugins into the native projects
npm run cap:ios          # opens Xcode   (build / archive / TestFlight there)
npm run cap:android      # opens Android Studio (build signed AAB there)
```

**Branded icons + splash are committed** as source images in `assets/` (the hawk badge
on cream — `icon-only.png`, `icon-foreground.png`/`icon-background.png` for Android
adaptive, `splash.png`, `splash-dark.png`; see `assets/README.md`). `npm run cap:assets`
(= `npx @capacitor/assets generate --assetPath assets`) expands them into every
per-platform size inside `ios/`/`android/`. Run it **after `cap add`** and re-run whenever
the `assets/` sources change — otherwise you ship Capacitor's default placeholder icon.

After that: add the **APNs key** (iOS) / **google-services.json** (Android) to Firebase,
enable Push Notifications capability in Xcode, and archive → TestFlight / Play internal
testing. **Both of those steps are automated in the Codemagic workflows below**, which is
the path to prefer — the local route above is only needed for interactive debugging.

`server.url` means you rarely rebuild the binary — only native/plugin/icon changes need a
new store build. **What that excludes is easy to get wrong:** anything in
`capacitor.config.ts` (the launch URL, `errorPath`) and any new plugin is compiled in, so
it reaches users **only** on a rebuild, however many times you deploy the website.

> **Real-world first-build gotchas (learned shipping the Android build 2026-07-25).**
> - **Build machine needs Node + git. On Windows PowerShell, `npm`/`npx` may be blocked**
>   by the execution policy (`npm.ps1 cannot be loaded … running scripts is disabled`).
>   Fix once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (or call `npm.cmd` /
>   `npx.cmd`). Reopen the terminal after installing Node so PATH refreshes.
> - **`google-services.json` goes in `android/app/`** (not the repo root). Capacitor's
>   generated `android/app/build.gradle` already **conditionally applies** the
>   `com.google.gms.google-services` plugin when that file is present, so `npx cap sync`
>   + rebuild is usually enough — no manual Gradle edits. If a sync errors with "Plugin
>   com.google.gms.google-services not found", add
>   `classpath 'com.google.gms:google-services:4.4.2'` to the **project** `build.gradle`
>   buildscript deps.
> - **`npx cap sync` does NOT rebuild the app** — it only copies web assets + native
>   config into `android/`. Native changes (a new plugin, `capacitor.config`) take effect
>   only after **▶ Run** in Android Studio rebuilds + reinstalls. **WEB changes** (under
>   `src/`) reach the app on a **reload** (it loads the live site) — no rebuild. A
>   terminal `cap sync` alone looks like "nothing changed" until you Run.
> - **Edge-to-edge / the notch.** Android 15+ (API 35+) forces edge-to-edge, so the
>   webview draws behind the status bar and the site header lands in the non-tappable
>   strip. Fixed on the **WEB side** with CSS safe-area insets: `viewportFit: 'cover'` in
>   `layout.tsx` + `padding-top: calc(env(safe-area-inset-top) + …)` on the header
>   (`page.tsx`). `@capacitor/status-bar` (`overlaysWebView:false`, dark icons) is also
>   set but can't override edge-to-edge on its own — the CSS insets are the real fix.
> - **Google/social OAuth sign-in fails in the webview** — Google blocks OAuth in
>   embedded webviews (it bounces to the system browser and errors with a Clerk
>   `authorization_invalid`). **Email/password sign-in works.**
>   > **`@capacitor/browser` now exists in the project (added 2026-07-27) but does NOT
>   > fix this on its own.** `NativeBridge`'s link handler deliberately **excludes**
>   > camphawk.app and Clerk hosts from the system-browser handoff, because sending a
>   > sign-in out to Safari/Chrome would complete the session *there* and strand the
>   > app logged out. A real fix has to hand off to the browser **and** bring the
>   > session back (Clerk's native/OAuth redirect flow), not just open a URL — so
>   > don't "fix" it by deleting the exclusion.
> - **Play Console device verification can't be done on an emulator** — it needs hardware
>   attestation (the Play Console app just white-screens on an emulator). Use a real
>   Android device (borrow one for 2 min). Identity (ID) verification is separate and
>   gates publishing, not local testing.
> - **`next build` needs the Stripe + Clerk keys in the environment.** `api/stripe/checkout`
>   inits `new Stripe(process.env.STRIPE_SECRET_KEY!.trim())` at module load, so a build
>   without them throws "Failed to collect page data" for that route. **The CampHawk web
>   session env now HAS both** (verified 2026-07-27 — `npx next build` runs clean here),
>   so a full build IS a usable check again; it was not when this note was first written.
>   Either way `next build` passing is **not** sufficient for layout/rendering changes —
>   dynamic segments aren't executed at build, so a request-time throw only shows up on a
>   real request. Smoke-test with `curl -sI camphawk.app/` after deploying.

### Android builds with NO Android Studio — Codemagic (added 2026-07-27)

The `android-release` workflow in `codemagic.yaml`: `npx cap add android`, brand,
`cap sync`, decode `google-services.json`, set the versionCode from Codemagic's build
counter, patch the signing config into Gradle, `./gradlew bundleRelease assembleRelease`,
then verify the APK actually came out signed.

> **FIRST GREEN RUN: 2026-07-28 (build 4).** This workflow was written 2026-07-27 and
> had never executed; its first four runs found four separate problems, none of them
> in the app. Recorded here because each one looks like something it isn't:
> 1. **`instance_type: linux_x2` → failed instantly, zero steps, no logs**, with "The
>    selected instance type is not available with the current billing plan". Reads like
>    a broken workflow; it is **billing**. `linux` fails the same way — **this plan has
>    NO Linux instance**, only `mac_mini_m2` (what iOS already used). A Mac runner for
>    an Android build is odd but it's the only machine available, and the macOS image
>    carries the Android SDK/JDK/Gradle, so it builds fine.
> 2. **`error: invalid source release: 21`** at `:capacitor-android:compileReleaseJavaWithJavac`,
>    **91 Gradle tasks in.** Capacitor 7's own Android library sets `sourceCompatibility 21`
>    and the image's default JDK is older. Fixed with `environment.java: 21`, pinned so an
>    image change can't move it. Surfacing that late makes it look like a project fault.
> 3. **A GREEN build that emitted `app-release-UNSIGNED.apk`** — see the signing note
>    below. This is the dangerous one: nothing failed.
> 4. Nothing — build 4 produced a signed `app-release.apk` + `.aab`, certificate
>    `CN=CampHawk, …` confirmed with `apksigner`.

It emits **both an AAB and a signed APK**. The APK is the useful one at this stage — sideload
it and you can test the Android back button, external-link handoff and offline banner
without waiting on a Play review.

**Configure in the Codemagic UI, not in the file** (both were done 2026-07-28):
- an **Android keystore** uploaded under the reference name `camphawk_upload`
  (Settings → Code signing identities → Android keystores). Alias `camphawk`; the
  keystore file + password live in the operator's password manager, nowhere else, and
  **must never be committed — this repo is public.** With Play App Signing an upload
  key is resettable through the Play Console if it's ever lost or leaked.
- an environment group `android_firebase` holding **`GOOGLE_SERVICES_JSON_B64`** — base64
  of `google-services.json` from Firebase → Project settings → Android app. If the
  *variable* is unset the build still succeeds and Android push simply stays off,
  matching iOS — but if the **whole group is missing**, Codemagic can reject the
  workflow before it builds. (`google-services.json` is not a secret; it ships inside
  every distributed APK. `FCM_SERVICE_ACCOUNT` is the one you must never paste anywhere.)

> **UPLOADING THE KEYSTORE IS NOT THE SAME AS SIGNING WITH IT — this shipped an
> unsigned APK on a GREEN build (2026-07-28).** `android_signing: [camphawk_upload]`
> makes Codemagic fetch the keystore and export `CM_KEYSTORE_PATH` / `CM_KEYSTORE_PASSWORD`
> / `CM_KEY_ALIAS` / `CM_KEY_PASSWORD`. It does **not** make Gradle use them, and
> Capacitor's generated `android/app/build.gradle` declares no `signingConfig` at all —
> so `assembleRelease` emitted `app-release-UNSIGNED.apk`, every step passed, and the
> only clue was the filename. An unsigned APK will not install and an unsigned AAB will
> not upload to Play.
>
> Two steps now handle it, and `android/` is regenerated every build so both have to
> live in the workflow rather than in a committed Gradle file:
> - **Wire the keystore into Gradle** patches `signingConfigs.release` into
>   `app/build.gradle` and points `buildTypes.release` at it. Idempotent, and it
>   **exits 1 when `CM_KEYSTORE_PATH` is empty** instead of quietly building unsigned.
> - **Verify the APK is actually signed** rejects a `*-unsigned.apk` and runs
>   `apksigner verify --print-certs`.
>
> Same lesson as the RIDB photo filter and the stopped-poller deploy: the failure mode
> that costs real time is the one where **everything reports success**.

> **THE WORKFLOW RUNS ON macOS, SO `sed -i "expr" file` SILENTLY DOES NOTHING.** BSD
> sed's `-i` requires a backup-suffix argument, so it takes the expression as the suffix,
> errors, and a trailing `|| true` hides it. The version-code step did exactly this and
> every build shipped Capacitor's default `versionCode 1`. Found 2026-08-01 when the
> first Play upload arrived as "1.aab (1.0)" instead of build 6 — the FIRST upload
> succeeds either way, and the second would have been rejected as a duplicate version
> code, most likely at the worst moment. Use `sed -i.bak` (GNU and BSD both accept an
> attached suffix), drop the `|| true`, and ASSERT the result. Applies to any other
> in-place edit added to this workflow.

Play publishing is left commented out until a Google Play service account exists, so a
half-configured integration can't fail an otherwise good build. **Adding one is the
single highest-value Codemagic change left**: with it, every build uploads itself to the
internal track and no AAB is ever hand-carried again.

**Play submission reference — listing copy, data-safety answers, reviewer credentials,
the 12-tester/14-day gate — is in `docs/PLAY-STORE.md`.** Graphics regenerate with
`npx tsx scripts/play-assets.mts`; screenshots must come off a physical device (the
sandbox reaches neither Mapbox nor recreation.gov's CDN).

**Both workflows are startable from a phone.** Codemagic → the app → Start new build →
pick the workflow. That is the whole procedure; `cap sync` inside the workflow is what
carries `capacitor.config.ts` and any new plugin across, which a web deploy never does.

### iOS builds with NO Mac — Codemagic cloud CI (SHIPPED 2026-07-26)

> **CAPACITOR 8: THE iOS BUILD MUST USE COCOAPODS. Do not "modernise" it to SPM.**
> Capacitor 8 defaults iOS to Swift Package Manager, and that default cost two builds on
> 2026-08-08 before it worked:
> - `cap add ios` on the default emits `App.xcodeproj` + `CapApp-SPM/` and **no
>   `App.xcworkspace`, no Podfile**, so `xcode-project build-ipa --workspace` fails in
>   **0.8 seconds**. That duration is the whole diagnosis — a real Xcode compile takes
>   minutes, so a sub-second failure is an argument error, not a code error. The same tell
>   was upstream and missed: "Capacitor sync" finished in 1.0s, and any step that truly
>   runs `pod install` cannot.
> - Switching the flag to `--project App.xcodeproj` got a real 48s resolve, then:
>   `Conflicting identity for app: '@capacitor/app' and '@capacitor-firebase/app' both
>   point to the same package identity 'app'`. **SPM derives identity from the last path
>   segment**, so those two collide no matter what we do. Neither is removable:
>   `@capacitor/app` is the Android back button and lifecycle events;
>   `@capacitor-firebase/app` initialises the native Firebase SDK from
>   `GoogleService-Info.plist`, so dropping it breaks push SILENTLY.
> - **The fix is `npx cap add ios --packagemanager cocoapods`**, which is first-class in
>   v8. Pods have no identity restriction (`CapacitorApp` vs `CapacitorFirebaseApp`) and
>   it is the configuration that shipped builds 5 and 8. Revisit only if upstream renames
>   one of those packages.
>
> **Android is not affected** — it builds through Gradle and never had this problem.
>
> **THE CODEMAGIC BUILD NUMBER IS NOT THE `index` THE API RETURNS.** `GET /builds`
> reports `index`, a per-workflow run counter (8 for the iOS run on 2026-08-08). What
> lands in the app is `PROJECT_BUILD_NUMBER`, a different counter that `agvtool` /
> `versionCode` write in — TestFlight showed that same run as **1.0 (15)**. Quoting
> `index` at someone checking TestFlight tells them they are on a stale build when they
> are not. Read the number from TestFlight, Play, or Settings in the app.
>
> **Builds can be triggered from a web session, not just the UI.** `CODEMAGIC_API_TOKEN`
> is in the environment:
> ```
> curl -s -X POST https://api.codemagic.io/builds -H "x-auth-token: $CODEMAGIC_API_TOKEN" \
>   -H "Content-Type: application/json" \
>   -d '{"appId":"6a6586c1ca94d01c31a8247e","workflowId":"ios-testflight","branch":"master"}'
> ```
> `workflowId` is the **key in codemagic.yaml** (`ios-testflight` / `android-release`),
> not the id the `/apps` endpoint lists — that one is the UI-configured "Default
> Workflow". Poll `GET /builds/<id>` for status and per-step durations. **There is no log
> API** (404 on every shape), but a FAILED build attaches
> `<app>_<n>_artifacts.zip` containing `App.log` — the real xcodebuild output, and the
> only place the SPM identity error appeared. Fetch it with `curl -L`; the artefact URL
> 302s to storage.googleapis.com and without `-L` you save the HTML redirect page.

The iOS app is built + shipped to TestFlight from **Codemagic** (macOS cloud runners),
so **no Mac is needed**. Config is `codemagic.yaml` (workflow `ios-testflight`); it
regenerates the git-ignored `ios/` each build (`npx cap add ios`), brands assets, signs,
and uploads. Set up in the Codemagic UI: an **App Store Connect API integration** named
`CampHawk ASC` (the `.p8` + Key ID + Issuer ID), plus these **secure env vars** in the
`ios_signing` group:
- **`CERTIFICATE_PRIVATE_KEY`** — a distribution-cert private key (PEM). `fetch-signing-files
  --create` mints the signing cert *from this key* on first build and reuses it after;
  without a private key it can't save a cert and the build fails "requires a provisioning
  profile" even though a profile got created. Generate once (`openssl genrsa 2048`), keep it.
- **`GOOGLE_SERVICE_INFO_PLIST_B64`** — base64 of `GoogleService-Info.plist` (from Firebase
  → iOS app). Decoded + registered with the App target so `@capacitor-firebase/app` can
  auto-init Firebase for push. Build skips this cleanly (no push) if the var is unset.

Hard-won gotchas from the first end-to-end run (all cost real time):
- **`missingCompliance`** post-processing failure = the export-compliance question. Fixed
  in-config by writing `ITSAppUsesNonExemptEncryption=false` into the Info.plist (the app
  is HTTPS-only / exempt), so TestFlight accepts every build with no manual prompt.
- **Push entitlement** must be re-applied each build (ios/ is regenerated): the config
  writes `App.entitlements` (`aps-environment=production`) and points
  `CODE_SIGN_ENTITLEMENTS` at it via the `xcodeproj` gem. Requires Push enabled on the
  App ID (or signing fails).
- **iOS push needs an FCM token, not an APNs token.** `@capacitor/push-notifications`
  returns a raw **APNs** token on iOS, which the FCM-based backend can't address — so iOS
  push silently never delivered. Fixed by switching the native bridge to
  **`@capacitor-firebase/messaging`** (+ `@capacitor-firebase/app` for auto
  `FirebaseApp.configure()`), which yields a real **FCM** token on both platforms.
  `firebase` is a direct dep so the plugin's web layer resolves at `next build` (lazy
  chunk, never runs in the native-only flow). **Android needs a rebuild** to pick up the
  new plugin (same FCM under the hood, so it keeps working).
- **THE APNs-key trap that ate an hour (2026-07-26).** Firebase → Cloud Messaging →
  Apple app config has **two APNs-auth-key slots: Development AND Production**. A key
  uploaded to Development only leaves Production empty — and **TestFlight builds use the
  PRODUCTION APNs environment**, so FCM returns `sent`, APNs has no prod key to auth with,
  and the message is **silently dropped with the token never pruned** (looks exactly like
  a code bug). The `.p8` auth key is the *same file* for both — upload it to **both**
  slots. Signature to recognize: email/SMS deliver, push `status=sent`, token stays in
  `push_tokens`, nothing on device even with notifications allowed + phone locked.
- **Verifying push without a Mac/device console:** the FCM token lands in `push_tokens`
  (`platform='ios'`); fire `scripts/e2e-gtc-alert.mts` (needs `NODE_USE_ENV_PROXY=1` + a
  blank `.env.local` in a web session, since it reads that file) to make the Fly worker
  dispatch a real push+email+SMS to your account. `status=sent` + no prune + no device
  delivery ⇒ the APNs-key trap above, not the code.
- **Geolocation ("use my location") is a NATIVE dep, needs a rebuild.** `navigator.geolocation`
  hangs in the iOS WKWebView, so `src/components/v2/geo.ts` routes through
  **`@capacitor/geolocation`**
  (`deviceCoords()`; native on device, browser API on web, IP fallback). CI adds the
  **`NSLocationWhenInUseUsageDescription`** Info.plist key ("Add location usage description"
  step) or iOS silently denies; Android perms come from the plugin. Like the push plugins,
  **Android also needs a rebuild** to pick this up.
- **Native-app UX fixes that are WEB-only (reach the app on reload):** social sign-in
  (Google) is **hidden in the native app** (email/pw only) — it can't complete in a webview
  and would trigger Apple's Sign in with Apple requirement (`AuthPanel` +
  `.native-hide-social` in globals.css); and iOS input-focus zoom is killed by forcing form
  controls to 16px on small screens (globals.css).

> **Store-billing rule (why the app never sells the subscription).** Apple/Google
> require digital subscriptions to go through their in-app purchase (15–30% cut). We
> keep **Stripe on the web only**: the app is free, search works for everyone, and a
> non-subscriber sees "manage your plan at camphawk.app" — never an in-app price or buy
> button. This is enforced by a **native flag** — Capacitor appends `CampHawkApp` to
> the webview User-Agent (`capacitor.config.ts`), and `NativeAppProvider`
> (`src/lib/native/context.tsx`) reads it **client-side** (`useSyncExternalStore` over
> `navigator.userAgent`) and provides it via context; the pricing surfaces are **FIVE**, not two:
> `v2/PricingSection.tsx` (the whole `/` pricing block, copy included), `v2/WatchCta.tsx`,
> `v2/Explore.tsx`, `v2/Settings.tsx` and `v2/NewWatch.tsx` — each renders a
> price-free variant when `useIsNativeApp()` is true.
>
> **An earlier version of this note listed only `Pricing` + `WatchCta`, and that
> undercount was the bug.** `Pricing` gated its own buttons while the price *headline
> around it* sat ungated in a server component, so the app showed a full pricing panel
> with the buy buttons missing — worse than either extreme. **Gating the checkout
> control is not gating the price.** Audit with
> `grep -rn '\$[0-9]\|/api/stripe' src/components/ 'src/app/(app)/'`.
>
> **Detection is CLIENT-side on purpose** — an earlier version read the UA in the root
> layout via `await headers()` and 500'd every page at runtime (see the root-layout
> gotcha in `CLAUDE.md` / `CONTEXT.md`; the Cache Components attribution there has since
> been **retracted** — that flag is not enabled — but the prohibition stands on the
> outage itself).
>
> The residual cost is a one-frame flash of the web variant *inside the app* on `/`.
> That is why **`server.url` points at `/search`**: not landing on the only page with
> checkout removes the frame, without delaying pricing for real web visitors the way a
> mounted-gate would. Don't point it back at the root.
>
> **Steering out is built but OFF** — `NATIVE_LINKOUT` in `v2/nativeSubscribe.tsx`. Both
> stores' anti-steering carve-outs are **US-storefront only**, so it stays dark until app
> availability is restricted to the US in App Store Connect and Play Console.
>
> To sanity-check the web path is unaffected, load any page with a normal browser UA (no
> `CampHawkApp`) and the two plan cards appear as before — Alerts ($2.50/mo · $20/yr)
> and Auto-Cart ($10/mo · $50/yr). Since 2026-08-01 the price-bearing surfaces also
> include `/pricing`, the `PricingLink` block on the three app tabs, and the
> AutoCartSettings upgrade gate — all native-gated; the audit grep in
> `docs/CONTEXT.md` ("Things that will bite you") covers them.

## Repo layout (orientation)

```
src/app/            Next.js routes + API routes (search, stripe, auto-cart/*, webhooks/*)
                    api/rc-proxy    Vercel-side proxy for UseDirect (Fly is WAF-blocked there)
src/lib/            Core logic
  availability/     per-source availability checks (recgov, reservecalifornia,
                    reserveamerica, goingtocamp [+ goingtocamp-remote: asks the worker])
  sources/          catalog sync per platform (ridb, reservecalifornia [+UseDirect states],
                    reserveamerica, goingtocamp)
  notifications/    email + SMS + push dispatch (push.ts = FCM HTTP v1)
  native/           context.tsx  client-side native-app detection (useIsNativeApp)
  booking-url.ts    the one place that builds a booking link (site/date deep links);
                    records what each provider actually honors — see docs/CONTEXT.md
  limits.ts         WATCH_LIMIT — the account watch cap (6), server 409 + all copy
  stripe-plans.ts   price-id ↔ plan-tier mapping (server-only); the Auto-Cart tier
  sources/geocode.ts  the coordinate ladder — portal coords, then street-address
                    geocoding (Mapbox), then name lookup (OpenStreetMap). NEVER
                    name-geocode with Mapbox; see docs/CONTEXT.md
  data-sources.ts   the 14 official data sources + non-affiliation disclaimer, one
                    list feeding /sources and both store listings. ADD A SYNC
                    ADAPTER → ADD IT HERE (Play policy; see docs/PLAY-STORE.md)
  health-thresholds.ts  canary staleness + RECGOV_MONTHS_PER_MACHINE (capacity gauge)
  db/               Supabase client + migrations/
src/app/(app)/      the app itself — a route group supplying nav/backdrop/footer
                    without a path segment: / /search /pricing /welcome /watches
                    /new /settings /campground/[id] /manage/[token].
                    See docs/CONTEXT.md.
src/app/sources/    public "where our data comes from" page — the source citation
                    Google Play requires. Outside the route group; in isPublicRoute.
src/components/ui/  design primitives (Button, Chip, Tag, Card, DatePicker, …)
src/components/v2/  the screens (Explore, WatchesList, NewWatch, Settings, …)
src/components/     what's left of the pre-rewrite UI: Logo, AuthPanel, SmsOptIn,
                    BetaTesters, AdminAutoRefresh
                    NativeBridge.tsx  Capacitor push bridge (no-op on web)
worker/             Fly.io cancellation poller (poller.ts)
                    http-server.ts  POST /gtc/availability, for the Vercel search page
                    liveness.ts     self-heal watchdog signals (heartbeat + egress)
                    claim.ts        the alerting claim (separate: importing poller.ts
                                    STARTS it, which made it untestable)
                    carted-history.ts  one auto-cart per (watch, site), forever —
                                    separate for the same reason claim.ts is
                    sync-claim.ts   one machine runs each nightly catalog sync (the
                                    other shard machine must not run it too)
                    recgov-scheduler.ts  THE one rec.gov fetch lane (single-flight,
                                    TTL cache, token-bucket budget)
                    lead-time.ts    hot/cold lead-day arithmetic for that lane
                    shard.ts        campground→machine sharding + DB lease (LIVE at
                                    SHARD_COUNT=2 since 2026-08-02)
                    rate-profile.ts full-day 429 profile recorder (recgov_rate_profile)
                    (RC day-before holds live in src/lib/rc-holds.ts — the state
                    machine is shared by the poller, the /w/<token> action and the
                    mini-PC runner, so it sits with the app, not the worker)
capacitor.config.ts  native app shell config; native/shell/ offline fallback page
                    (ios/, android/ generated by `npx cap add`, git-ignored)
extension/          Optional Chrome extension ("CampHawk Quick Cart") that reads the
                    #camphawk / #camphawk-rc fragments in alert links to autofill dates
                    and add to cart, in the user's own browser. Desktop only —
                    extensions don't run in mobile Chrome. Ships OFF by default.
scripts/auto-cart-bot/  Mini-PC Playwright bots + remote sign-in broker. FIVE
                    processes: bot.mjs (rec.gov) + broker.mjs, and for RC
                    rc-keepwarm.mjs (OWNS the session, the only thing that logs
                    in, and since 2026-08-08 REPORTS whether RC still accepts it
                    — needs AUTOCART_TOKEN in .env, already there for the runner)
                    + rc-hold-runner.mjs (drives it, never logs in). Shared:
                    rc-cart.mjs (the precart/release contract, so probe and runner
                    cannot drift), profile-lock.mjs (one Chromium per profile dir),
                    load-env.mjs (every process reads .env), exit-clean.mjs (a
                    one-shot run must not die in Windows libuv teardown),
                    rc-autologin.mjs (ONE credential sign-in shortly before a
                    hold; creds live in credstore.mjs's DPAPI blob, never .env).
                    mini-pc/*.bat cd themselves — rc-save-password.bat (run once,
                    ends the morning sign-in), rc-login.bat, rc-check.bat,
                    fix-pagefile.bat (admin, run once — reports by default,
                    -Apply writes; the box exhausted COMMIT on 2026-08-12 and
                    supervise.ps1 could not start a shell at all. NOT a disk
                    problem: disk-free said 404 GB the same night. Needs a
                    REBOOT to take effect, which ends the RC session exactly
                    like update.bat — time it the same way).
scripts/            run-sync*.ts catalog syncs; e2e-gtc-alert.mts (live alert test —
                    SENDS REAL EMAIL/SMS); recgov-429-profile.mts (the rate readout);
                    rc-holds-readout.mts ("did the 8am cart fire?" — the only view of
                    the hold chain, which spans four processes and no single log);
                    likelihood-readout.mts; seo-check.mts; screenshot-component.mts;
                    play-assets.mts (Play icon + feature graphic — Play-only assets
                    with no Apple equivalent; see docs/PLAY-STORE.md)
```

> **Proxy directions differ per WAF'd source — don't copy one to the other.** Three
> WAF'd sources, two directions:
> - **UseDirect** — Fly blocked, Vercel fine → the worker calls **out** to
>   `/api/rc-proxy` on Vercel (forwards individual RDR requests).
> - **TN/SC** — Fly blocked, Vercel fine (same direction as UseDirect) → the worker
>   calls **out** to `/api/tnsc-availability` on Vercel, gated by `TNSC_AVAILABILITY_URL`.
>   Unlike rc-proxy it does the WHOLE batch in one hop, because the portal's CSRF
>   token + cookie are session-bound to one IP.
> - **GoingToCamp** — **Vercel** blocked, Fly fine (the reverse) → the website calls
>   **in** to the worker's `/gtc/availability`.
>
> See `docs/CONTEXT.md`.

## Screenshotting UI from a web session (component isolation)

`scripts/screenshot-component.mts` renders ONE React component into a bare static
page (project Tailwind, no Next/Clerk/data) on a plain localhost port and screenshots
it with the pre-installed Chromium. This exists because, from a Claude-web session,
the **live site can't be browsed** (the agent proxy resets headless-Chromium TLS) and
the full Next app pulls in Clerk's dev-browser redirect — isolation sidesteps both
(nothing leaves localhost, no TLS in the path). Use it to eyeball layout/spacing/
alignment before shipping.

```
npx tsx scripts/screenshot-component.mts ch-home --out=/tmp/x.png --width=1280 --height=1400
```

Add a preset to the `PRESETS` map for a component that needs realistic props; or pass
a `.tsx` path (default export, no props) ad-hoc. `npx tsx scripts/screenshot-component.mts`
with no argument lists them. Needs `playwright-core` (a devDependency) + the image's
`/opt/pw-browsers` Chromium. **Scope: presentational components only** — not real data,
auth, or full-page composition.

Two things worth knowing before you fight it:

- **Signed-in UI needs `window.__CH_SIGNED_IN = true`** in the preset's entry code.
  The Clerk stub (`scripts/harness/clerk-stub.tsx`) defaults to SIGNED OUT, so hearts,
  settings and the account menu render as nothing until you flip it. Stub `fetch` in
  the same block to feed the component data.
- **A blank PNG is usually a thrown hook, not a layout bug.** `useRouter()` and Clerk
  hooks throw outside a Next app; both are aliased to stubs in `scripts/harness/`, and
  the harness logs `pageerror`/console output so a throw can't masquerade as an empty
  page. If you add a component that imports something else Next-only, alias it there too.
- **Subscription-dependent UI is a fetch stub, not a flag.** Anything reading
  `useSubscription` branches on `/api/subscription/status`, so the preset must return
  the shape it expects — `{ active, everSubscribed, autocart, autocartPlanAvailable }`.
  The pricing presets show all three states worth eyeballing: `ch-pricing` (signed out,
  the two-plan comparison), `ch-pricing-signedin` (checkout buttons) and
  `ch-upgrade-nudge` (an Alerts-plan subscriber's upgrade block). Omitting `autocart`
  silently renders the non-subscriber variant, which looks plausible and is wrong.
  Same for the welcome step: `ch-welcome-basic` (new account, no plan — the common
  case) and `ch-welcome` (an Auto-Cart subscriber, which adds the Recreation.gov
  sign-in card), plus `ch-account-wall` for the Watches signed-out stack, which needs
  `/api/watches` stubbed to 401 or the harness fetches the real route, gets the HTML
  shell and throws.

## Screenshotting whole PAGES (App Store submission)

Different script, different job: `scripts/app-store-shots.mts` renders the **real
production build** — full pages, real data, real Clerk — with the native
User-Agent, so the store gating applies exactly as it does in the app. The run reports
whether any price text appeared and whether the shot was caught mid-request.

```
NODE_USE_ENV_PROXY=1 npx next build
NODE_USE_ENV_PROXY=1 npx next start -p 3100 &
SHOTS_SIZE=6.9 SHOTS_OUT=/tmp/shots NODE_USE_ENV_PROXY=1 npx tsx scripts/app-store-shots.mts
```

`SHOTS_SIZE` picks the device: `6.9` (1320 × 2868, the size Apple requires), `6.5`
(1284 × 2778, optional), `ipad13` (2064 × 2752). **App Store Connect has one upload box
per display size and rejects anything whose pixel dimensions don't match that box
exactly** — a 6.9" file dropped on the 6.5" box is a hard error, not a resize. iPad is
required only because the Capacitor build declares iPad support.

Three traps, all of which produced a bad screenshot before being fixed:

- **The keys come from process env vars in a web session, NOT `.env` files.** Grepping
  for `.env` finds nothing and reads as "no credentials available" — it isn't. Check
  `printenv`. Without real Clerk keys every page 500s at request time while
  `next build` still passes.
- **Waiting 6s for `/search` is not enough.** A 50-mile availability sweep was still
  running, so the shot showed a "Searching..." button over an empty result card. Not an
  error, which is exactly why it shipped once. Settle is now 14s and the run logs
  whether the page is still loading.
- **Maps render as a blank grey box, and cannot be fixed from here.** Chromium can't
  reach `api.mapbox.com` through the agent proxy (`ERR_CONNECTION_RESET`, confirmed
  2026-07-29) — the same TLS reset that stops the live site being browsed.
  `NODE_USE_ENV_PROXY=1` does **not** help: it only affects Node's `fetch`, not the
  browser. This is why the iPad set stays on map-free pages — at iPad width `/search`
  is two columns and the results column leads with the map. Same reason the campground
  detail page is in no set: its photo strip comes from recreation.gov's CDN. Capture
  those on a real device; screenshots can be replaced without submitting a new build.

Full submission reference — privacy answers, review notes, listing copy — is in
`docs/APP-STORE.md`.

## Verifying a change — `npm run verify`

```
npm run verify           # typecheck (both configs) → tests → build. ~2.5 min.
```

**One recipe, run locally and in CI**, so the two cannot drift into checking different
things. `.github/workflows/verify.yml` runs this exact command on every push to `master`
and to `claude/**`, and on PRs. Cheapest check first, so the fastest signal fails first.

Before 2026-08-11 nothing ran `typecheck` or `test` automatically — all five workflows
were ops (canary, watchdog, deadman, nightly sync, worker deploy). `worker-deploy.yml`
verifies the poller's heartbeat after deploying, which catches **dead** but not **wrong**,
and the worker deploys on a push to `master` with no test gate at all.

**`npm run lint` is deliberately NOT in it.** It was triaged on 2026-08-12 from 39 errors
to **15**: all 13 `no-html-link-for-pages` handled (12 converted to `<Link>` — an `<a>` to
an internal route is a full page reload, which inside the Capacitor webview is a visible
bug; `app/error.tsx` keeps its `<a>` deliberately and says why), all 9 `no-explicit-any`
replaced by a named type in `scripts/seo-check.mts`, plus `no-assign-module-variable` and a
`prefer-const` that turned out to be dead code.

The remaining **15 errors are all `react-hooks/set-state-in-effect` (11) and
`react-hooks/refs` (4)**, and they are not style: each is a claim about cascading renders or
stale refs in live UI, needing per-component judgment. Fixing them mechanically trades a
lint warning for a behaviour regression nobody sees until a user does. So lint stays out
until they are done properly — a gate that is red the day it lands is one people learn to
ignore, and mass-disabling would be worse than leaving them, because a disabled rule looks
handled. Once clean, add `lint` to the `verify` script; it costs ~17s.

`npm run build` is last because it is the slowest and the **weakest** signal — dynamic
segments are not executed at build, so it cannot catch the request-time layout throw that
cost a production outage on 2026-07-24. It earns its place because **`master`
auto-deploys to Vercel**, so a build break reaching `master` is a failed production
deploy. It is still not a substitute for smoke-testing a real page after deploying.

## Typechecking

```
npm run typecheck        # BOTH configs — the plain `tsc` misses half the system
```

**`tsc --noEmit` alone does NOT cover the worker.** The root `tsconfig.json` excludes
`worker` and `scripts` (Next.js owns that config and must not compile a long-running
Node process into the app build), so the poller — the code that decides whether anyone
gets alerted — was typechecked by nothing at all.

Found on 2026-07-31 by widening one return type to `boolean | null`: `tsc` and
`next build` both passed clean while `worker/poller.ts` had a hard type error at the
call site, plus a second in `scripts/seed-probe-targets.ts`. Both would have shipped.
`tsconfig.worker.json` covers `worker/` + `scripts/`; `npm run typecheck` runs both.

Same family as the "`next build` passing is NOT enough" rule for layout changes — a
green build says nothing about the parts Next.js does not compile.

## Running the tests

```
npm test
```

**`node:test` via tsx — no test framework dependency.** Files are `*.test.mts` under
**`worker/` AND `src/`** — the script globs both, so a suite next to the code it covers
(`src/lib/notifications/*.test.mts`) is picked up too. Added 2026-07-30; before that the
repo had no test script, no framework and no test files. **459 tests as of 2026-08-12** (329 on 2026-08-11, when the serial measurement below was taken).

> **`--test-concurrency=1` IS LOAD-BEARING — do not "speed this up" by removing it
> (2026-08-11).** `node:test` runs test FILES in parallel by default, and the nine
> DB-backed suites share fixture rows in the one real database, so they race each
> other. Measured over three parallel runs of an unchanged tree, at 329 tests: **329 pass, then 6
> fail, then 3 fail** — `rc-client-reports` ("reports append, and never move status or
> updated_at") and `sync-claim` ("renew extends OUR claim and refuses someone else's"),
> i.e. suites asserting that a row did NOT change while another file was changing it.
> Serial: **three consecutive 329/329 runs.** The cost was 36s → 87s then, ~60s at 459
> tests now, which is the right
> trade — a suite that fails 2 runs in 3 for reasons unrelated to the code teaches you
> to ignore it, and these are the suites guarding the alerting claim.
>
> The better fix is per-file fixture namespacing so parallelism is safe again (it buys
> back ~50s), and it is real work rather than a drive-by: it touches the most
> load-bearing test code in the repo, so it needs the usual validation — break the
> code, watch the suite fail. Until then, serial.
>
> Residual risk worth knowing: `sync-claim` and `shard-lease` write tables the two
> **live** Fly machines are actively renewing. Serial execution removes the
> test-vs-test race, not a test-vs-production one. `shard-lease` already dodges this by
> using indices ~9000; the fixture-namespacing work should give the others the same
> property.

The suites, chosen because a silent wrong answer in each is expensive:
`worker/claim.test.mts` (the alerting claim — where a bug costs a user a campsite),
`worker/costs.test.mts` (admin cost arithmetic — net margin),
`worker/health-thresholds.test.mts` (canary staleness — the banner that cried wolf),
`worker/recgov-breaker.test.mts` (the rec.gov throttle breaker — which decides whether
rec.gov watches get checked at all, and whose half-open probe was a comment rather than
code until 2026-07-30; needs no credentials — a 1ms timeout counts as a throttle, so it
drives the real 429 path without rec.gov cooperating),
`worker/recgov-scheduler.test.mts` + `worker/recgov-budget-defaults.test.mts` (the
token-bucket fetch lane: burst sizing, the breaker-skip DEADLOCK transition, counter
windows — the defaults suite is a separate FILE because the sibling suite overrides the
env at module load),
`worker/shard.test.mts` (pure hash: stability, range, even split, month independence) +
`worker/shard-lease.test.mts` (real DB: mutual exclusion, renewal, expiry takeover,
concurrent race — uses shard indices ~9000 so it can't disturb a live lease),
`worker/lead-time.test.mts` (the hot/cold lead-day arithmetic, validated by mutation),
`worker/sync-claim.test.mts` (real DB: only one machine may run a nightly catalog sync
— an expired claim is takeable so a dead machine cannot block the catalog, a renewal
extends only OUR claim, the claim is released even when the sync THROWS, and eight
DIFFERENT machine ids racing for a free job produce exactly one winner),
`worker/ridb-photos.test.mts` (real DB, guards a DATA-DESTRUCTIVE edge: skipping the
RIDB media call must not erase the 3,775 rows that already have photos, while a real
empty result still clears them),
`worker/geocode.test.mts` (null-island rejection, the 50-state box, PO-box refusal, and
the non-campground filter),
`worker/rc-holds.test.mts` (real DB: the RC day-before hold state machine — above all
that an `offered` row is **never** due, because only a tap may authorise a cart),
`worker/rc-held-flex.test.mts` (pure: which held nights we claim for a flexible watch,
and that `availableAt` is the LATEST lock of the CLAIMED run),
and `worker/carted-history.test.mts` (real DB: the one-cart-per-(watch, site) rule —
that a carted site blocks a second cart, that a DIFFERENT site on the same watch does
not, that a NEW watch starts over, that a late `carted` report still blocks even when
the reconciler already resolved the job as `alerted`, and that a FAILED attempt does
not block a retry).

**Four suites need neither network nor credentials** and are the fastest feedback in the
repo — they guard the mini-PC bot, whose code can be deployed from here (the "Update now"
flag) but never *exercised* from here, because Playwright is not installed next to it and
both providers refuse headless:
`worker/profile-lock.test.mts` (mutual exclusion, stale takeover, renewal holding a long
job, and the error path not stripping another process's lock),
`worker/bot-env.test.mts` (parses `mini-pc/start-all.bat`, resolves its npm scripts to
files, and asserts **every process launched at boot reads `.env`** — the gap that made
`rc-hold-runner` answer `feed 401` against a perfect config file),
`worker/rc-runner-cli.test.mts` (**executes the CLI**, with `playwright` stubbed, to prove
`--once` runs one pass and terminates — it caught a fall-through that `node --check`
could not see, introduced while fixing a Windows libuv exit assertion),
and `worker/geocode.test.mts`.
Plus `src/lib/notifications/{dates,sms-fit,twilio-signature}.test.mts`.

> **The rest hit the REAL database and need credentials**, so run with
> `NODE_USE_ENV_PROXY=1` in a web session. That is deliberate, not laziness: the
> claim's correctness lives entirely inside one `INSERT .. ON CONFLICT .. WHERE`, so a
> mocked client would test a fake instead of the thing that decides.
>
> **Nothing they write can affect production alerting.** The fixture watch is dated
> **2020** — `claimNotification` needs only `active = true`, but the poller's candidate
> query needs `end_date > CURRENT_DATE`, so the row is claimable by the test and
> invisible to the poller. It is deleted on the way out and `watch_site_alerts`
> cascades with it. If you add a test that writes, keep that property.

> **Prove a regression test can fail.** The claim suite was validated by reverting
> `worker/claim.ts` to the pre-026 per-watch logic — 4 of 9 failed, including the one
> naming the bug. A test that also passes on the broken version is decoration.
> The carted-history suite was validated against BOTH ways it could be wrong: stubbing
> the lookup to `false` (the original re-carting bug) failed 2 tests, and dropping
> `campsite_id` from the predicate (a per-WATCH key, which would silence every other
> site) failed a different one. Breaking it one way only proves half of it.
> The sync-claim suite was validated the same way: removing the `WHERE` (every machine
> wins) failed 3, removing the expiry (a dead machine blocks forever) failed 4.
> **And watch what the test is actually pointed at.** The first version of its race test
> re-typed the claim SQL inline and passed happily while the module was broken — a copy
> cannot notice a change to the thing it is guarding. `claimSyncJob` takes an optional
> `machineId` purely so the real function can be raced by eight machines.

## Checking the SEO surfaces

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/seo-check.mts
```

Guards three things that regress silently and break no test: the campground page
reverting to client-rendered (a human sees it load fine; a crawler gets a skeleton),
titles or descriptions colliding across the 8,013 pages, and structured data claiming
values the catalog can't support. It renders the real component through
`renderToStaticMarkup` and sweeps every row's metadata. Run it after touching
`lib/seo.ts`, `lib/jsonld.ts`, `richText.tsx` or the campground page.

## Front-end changes via v0

The UI is iterated in **v0** (linked to this GitHub repo). Setup that keeps the
production backend safe (established 2026-07-21):

- **Branch protection: tried, then turned OFF (2026-07-21).** A `master` ruleset
  requiring a PR was set up so v0 changes got reviewed, but with a solo dev it added
  more friction than it was worth, so it's **disabled** (the ruleset still exists in
  GitHub → Settings → Rules → Rulesets, set to Disabled — flip to Active to re-enable).
  Current workflow: **changes go straight to `master`** (Claude commits directly; v0
  can too). Trade-off: a bad push reaches production directly, so the safety net is
  "look before you push." Re-enable the ruleset if v0 or a second agent starts
  clobbering `master`.
- **Review the diff before it hits `master` — v0 regenerates whole files** and can
  silently drop backend wiring. Danger files to eyeball every time: `src/middleware.ts`
  (auth gate + the `/api/rc-proxy` and `/api/tnsc-availability` allowlists),
  `src/app/api/**`, `src/lib/**`, `src/app/layout.tsx` (the `<ClerkProvider>` wrapper),
  `next.config.ts`, `package.json`. A clean v0 PR touches only components/styles/assets.
- **Two load-bearing UI details a v0 regen has dropped before (2026-07-21):**
  (1) the **`export const viewport`** in `src/app/layout.tsx` — without it phones open
  zoomed in and off-center (Next won't emit the viewport meta on its own here); and
  (2) the landing must **scroll as a normal document** — only the *search-results*
  view uses the fixed-viewport app layout (`md:h-screen` + inner `overflow-y-auto`),
  gated on `searchState` in `src/app/page.tsx`. If the whole page gets `md:h-screen`
  again, the landing gets the "ugly nested scrollbar" back. `Logo` is also fluid
  (`clamp()`), so it shrinks on phones — don't hard-code a big fixed size in the header.
  (3) **"Manage subscription" lives ONLY inside the Clerk `UserButton` dropdown**
  (a custom `<UserButton.Action>` in `src/app/page.tsx`, subscribers-only, calling
  `openBillingPortal` → `/api/stripe/portal`). It used to be a standalone header button;
  a v0 regen that rewrites the `UserButton` back to a bare `<UserButton />` silently
  removes a subscriber's only path to the Stripe billing portal (i.e. no way to
  cancel/update payment) — keep the `MenuItems`/`Action` children.
- **v0's preview needs Clerk keys or it crash-loops.** The whole app is wrapped in
  `<ClerkProvider>` and `clerkMiddleware()` runs on every request, and **both throw
  without keys** — the publishable key alone stops the provider crash but the
  middleware then errors on a missing `CLERK_SECRET_KEY`, and v0 flash-refreshes
  forever. Fix: in **v0's** env settings add a **matched Clerk _development_-instance
  pair** — `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…` **and**
  `CLERK_SECRET_KEY=sk_test_…` (they must be from the same instance, or Clerk rejects
  the mismatch). Dev-instance keys govern a throwaway user table, so this is safe.
- **NEVER let v0 sync env vars to Vercel Production.** Dev keys belong in v0's preview
  only. Dev keys reaching Production is exactly the outage in `docs/CONTEXT.md`'s
  env-var note — it's the same failure class, just the opposite direction.
- **There is ONE Vercel project — `campsite-finder` — and it owns camphawk.app.**
  It's linked to this GitHub repo, so every push to `master` auto-builds here. v0 once
  renamed it to `v0-frontend`, which caused a long "nothing I deploy shows up" hunt
  (it looked like two projects fighting over the domain); it's since been renamed back
  to `campsite-finder`. Don't create a second Vercel project for this app, and don't
  let v0 spin up its own — the domain must stay on the one GitHub-connected project.
- **The production alias is flaky — a `master` push builds but doesn't always
  repoint camphawk.app to the new build.** Symptom: `vercel ls` shows the new deploy
  `Ready`, but camphawk.app still serves the old one (incognito confirms it's not
  cache). Fix: **Deployments → the newest `master` build → ⋯ → Promote to Production**.
  Worth fixing the project's auto-assign setting so this stops recurring.

> **A front-end-only merge to `master` can still break the backend.** Learned the
> hard way 2026-07-21: production had the `/api/tnsc-availability` middleware fix only
> via a manual `vercel --prod` from a branch that was *ahead* of `master`. Merging an
> unrelated v0 UI PR then auto-deployed `master` (which still lacked that allowlist
> line) and 404'd the route → TN alerting went down until the middleware PR was merged.
> **Lesson: `master` must be the source of truth — don't let a manual `vercel --prod`
> from a branch outrun what's merged, and after any merge re-check that camphawk.app
> serves the routes you expect (the auto-alias is flaky — see the Website deploy row).**

> **"Merged" ≠ "on `master`" ≠ "deployed" ≠ "what the user sees" — verify the whole
> chain.** A whole session was lost describing UI fixes the user couldn't see because
> they never actually reached the deployed `master`: the fixes were committed to a
> shared feature branch that a *second agent* was also editing, and the PR that got
> merged captured a different snapshot. Two habits that would've caught it in seconds:
> (1) after pushing, confirm the change is really on `master`
> (`git show origin/master:<file> | grep <the-change>`), not just on a branch; and
> (2) don't run two agents/sessions on the same branch at once — parallel edits to
> one branch are how the fixes got stranded and the history became a tangle. With
> branch protection off, prefer committing straight to `master` so there's no branch
> to fall out of sync.

## Working from another device — quickest paths

- **Just keep directing changes (like via Claude Code):** clone the repo on the
  device and open the folder in the Claude Code desktop app (or use claude.ai/code /
  GitHub Codespaces — no local setup). Chat history and Claude's memory do **not**
  sync across devices, so read `docs/CONTEXT.md` for the full picture.
- **Run/poke at the site yourself:** Path in sections 1–3 above.

## Claude Code on the web — session environment

Web sessions run in an ephemeral Anthropic-managed sandbox. Behaviour is governed by
the **environment** you pick in the session's environment selector (the **cloud icon**
next to where you start a task — there is no separate "Environments" page; hover an
entry and click its gear to edit). An environment sets a network-access level, env
vars, and a setup-script field.

- **Deps:** a SessionStart hook (`.claude/hooks/session-start.sh`, registered in
  `.claude/settings.json`) runs `npm install` so typecheck/lint/build work without a
  manual install. It's remote-only (`CLAUDE_CODE_REMOTE`), **synchronous** (~30s the
  first time; the container caches after), and **restores `package-lock.json`** after
  install — npm re-normalizes the lockfile in the sandbox, which would otherwise leave
  the repo dirty every session. Leave the environment's own "Setup script" field empty;
  this committed hook is the setup. A real dependency change goes through a
  `package.json` edit + commit, not the hook.
- **Network access levels** (per environment): **None** / **Trusted** (default —
  package registries + GitHub only) / **Full** (any domain) / **Custom** (your
  allowlist, optionally plus the defaults). Under **Trusted**, `camphawk.app`,
  `*.fly.io`/`api.machines.dev`, and `*.supabase.co` are all **blocked** — so a default
  session can read/build/lint and push to GitHub, but cannot deploy the Fly worker, run
  the catalog syncs against Supabase, or hit the live app. GitHub always works (separate
  proxy), no token needed.
- **To make a web session fully able to deploy/sync (e.g. add a state end-to-end):**
  (1) set the environment's network access to **Full** (or **Custom** with the provider
  host + `api.mapbox.com` + `*.supabase.co` + `*.fly.io` + `api.machines.dev`);
  (2) add env vars — `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (the sync
  scripts authenticate via `getSupabaseAdmin`), `NEXT_PUBLIC_MAPBOX_TOKEN` (geocoding),
  and `FLY_API_TOKEN` (a **deploy**-scoped token: `fly tokens create deploy -a
  campsite-finder-worker`, not org-admin — so a leak only risks that one app, and an
  interactive `fly auth login` elsewhere is unaffected by revoking it). **Rotating it
  now has TWO places to update, not one** — this env config **and** the
  `FLY_API_TOKEN` repo secret that `worker-deploy.yml` uses (added 2026-07-28; see the
  deploy table above). This bullet used to say rotation was self-contained because no
  workflow deployed to Fly, which was true until that Action existed: miss the repo
  secret and the next `worker/**` push fails its deploy with an auth error that looks
  nothing like a rotated token. (3) set `ENABLE_OPS_TOOLS=1` so the hook
  installs flyctl + the Supabase CLI. The Supabase CLI comes from npm and installs
  fine; **flyctl does NOT** — see the next bullet.
- **Rendering a real PAGE (not just a component) needs Clerk keys — the CampHawk
  environment now has them (added 2026-07-27).**
  > **They are LIVE keys, not dev-instance ones (verified 2026-07-28: `pk_live_…` /
  > `sk_live_…`).** So a `next build` in a web session bakes the **production**
  > publishable key, and anything a session runs with `CLERK_SECRET_KEY` acts on the
  > real user table — not a throwaway one. Worth swapping to a dev-instance pair unless
  > that's deliberate; the reason to render a page here is layout, which dev keys serve
  > equally well. (`STRIPE_SECRET_KEY` there is an `rk_live_` restricted key.)

  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
  and `CLERK_SECRET_KEY` are set there, so `npm run build && npx next start` serves
  the whole app and `curl localhost:3000/<route>` returns real HTML. That is the way
  to check a full page from a web session; the component harness above is the
  fallback, not the ceiling.

  **What keys still do NOT give you: a signed-in session.** `/watches` and
  `/settings` render their signed-out shells. Watch creation, Stripe checkout, the
  phone save and the auto-cart toggle can't be exercised here — those need a human
  clicking through the deploy.

  In any environment WITHOUT the keys, every page 500s with "Missing publishableKey"
  while `next build` still succeeds, which makes it easy to misdiagnose as a code
  fault. Two things learned the hard way when that happened (2026-07-27):
  - **A dummy key does not work.** A syntactically valid `pk_test_<base64>` is still
    rejected; Clerk validates it for real. Use the actual **dev-instance** keys.
  - **`NEXT_PUBLIC_*` is inlined at BUILD time.** Setting it in the environment and
    running `next start` changes nothing — the old value is already baked into the
    bundle. You must **rebuild** after adding it.

- **Three web-session gotchas that cost real time (2026-07-22, shipping SC end-to-end).**
  Even with **Full** network, `ENABLE_OPS_TOOLS=1`, and `FLY_API_TOKEN` all set, the
  out-of-the-box path still fails at three spots. All have workarounds that DO work
  fully from a web session (SC was deployed + e2e-alerted this way):
  - **flyctl won't install — but CHECK `~/.fly/bin` FIRST; the hook's WARN lies.** The
    SessionStart hook logs `WARN: flyctl install failed (network policy still blocking
    fly.io?)`, which reads as "you have no flyctl." **Do not trust it** — observed
    2026-07-23 that `~/.fly/bin/flyctl` was already present and fully working (v0.4.74,
    `flyctl auth whoami` OK via `FLY_API_TOKEN`), and a full worker deploy ran from that
    binary. So before assuming you can't deploy, run `export PATH="$HOME/.fly/bin:$PATH";
    flyctl version`. (This misleading warning cost real time across several sessions —
    the CLI kept insisting it "couldn't deploy Fly" when it could.) Only if flyctl is
    genuinely absent do you need the fallback below.
    The reason the hook's own install fails: `fly.io/install.sh` resolves the binary to
    a **GitHub release asset**, and web-session `github.com` traffic is **per-repo
    gated** by Anthropic's GitHub proxy (403 "GitHub access to this repository is not
    enabled for this session") — it only allows the repos added to the session, and
    `superfly/flyctl` isn't one. `add_repo` can't help either (cross-owner adds are
    rejected). Fallback when `~/.fly/bin` really is empty: pull flyctl out of its
    **Docker Hub image** (Docker Hub is reachable), which needs no GitHub: fetch the
    `flyio/flyctl:latest` manifest + layers from `registry-1.docker.io` (anon token from
    `auth.docker.io`), untar the layers, and the binary is at `/flyctl` — drop it on
    `PATH`. It authenticates via `FLY_API_TOKEN` (`flyctl auth whoami` confirms).
  - **Node's `fetch` ignores the agent proxy**, so any sync/e2e script that reaches
    the reservation portal, Mapbox, or Supabase gets a connection error or a WAF 403
    (the sandbox's direct egress IP is datacenter-blocked). Run every `npx tsx`
    sync/e2e with **`NODE_USE_ENV_PROXY=1`** so Node routes through the proxy (which is
    allowlisted). `curl` already uses the proxy; only Node needs this.
  - **Neither Fly remote builder works from the sandbox, so `flyctl deploy` (which
    builds) can't run here.** **Since 2026-07-28 you should not need any of this —
    dispatch the `worker-deploy.yml` Action instead** (GitHub runners build fine, and
    the Action also restarts the machine and verifies the heartbeat, which this manual
    path leaves to you). Keep the workaround below for when the Action itself is what's
    broken. The **depot** builder (the default) fails its gRPC TLS
    handshake — the agent proxy MITMs it and depot's client bundles its own CA roots,
    so it ignores both `SSL_CERT_FILE` and the system trust store (unfixable). The
    **classic** builder (`--depot=false`) returns `unauthorized` — the app-scoped
    `FLY_API_TOKEN` can't provision a builder machine. Workaround: **build locally and
    deploy the pre-built image.** A `docker` CLI + buildx are present; start the daemon
    by hand (`dockerd &` — you're root) and it uses the proxy for its own registry
    pulls/pushes fine. But **buildkit's `RUN` steps run in an isolated netns that can't
    reach the proxy**, so an in-build `npm ci` has no network — instead build an image
    that **COPYs the already-installed `node_modules`** (the SessionStart hook ran
    `npm install`, and the worker runs via `tsx`, so dev+prod deps are already there):
    ```
    # Dockerfile.deploy (throwaway; do NOT commit — canonical worker/Dockerfile does npm ci)
    FROM node:22-slim
    WORKDIR /app
    COPY package.json package-lock.json tsconfig.json ./
    COPY node_modules ./node_modules
    COPY src ./src
    COPY worker ./worker
    CMD ["npx","tsx","worker/poller.ts"]
    ```
    Then `flyctl auth docker`, `docker build -f Dockerfile.deploy -t registry.fly.io/campsite-finder-worker:<tag> .`
    (a Dockerfile-specific `Dockerfile.deploy.dockerignore` that keeps `node_modules`,
    since the repo `.dockerignore` excludes it), `docker push …` (retry on a transient
    502 — the layers resume), then **`flyctl deploy --image registry.fly.io/campsite-finder-worker:<tag> --config worker/fly.toml`**.
    Observed 2026-07-22: the `--image` deploy brought the primary back **started** on
    its own (the rolling restart left it up) — but still `flyctl status` and confirm a
    `[poller] heartbeat` after, because the build-path deploy's "leaves it stopped"
    warning above is the safe assumption. **Re-confirmed 2026-07-23** shipping the SMS
    link + auto-cart session-guard changes (tag `ehealth-987bbfd`): same flow worked
    end-to-end, primary came back `started`, `worker_heartbeat` fresh within seconds.
    One time-saver learned that run: `docker build`'s final "exporting layers" step for
    the large `node_modules` layer easily exceeds a 2-min foreground timeout — run the
    build (and the push) in the background and poll, rather than assuming a hang.
- **Vercel env vars are manageable FROM a web session — you don't have to type them
  into the dashboard (verified 2026-07-28).** The environment carries `VERCEL_TOKEN`,
  `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, and the token has **read *and* write** on
  `/v10/projects/<id>/env` (confirmed by creating and deleting a scratch var). So
  adding, rotating or auditing a Vercel env var is an agent task, not an errand. Fly
  secrets are readable the same way (`flyctl secrets list`). **GitHub Actions secrets
  are the one exception** — the session's GitHub token 403s on `/actions/secrets` and no
  MCP tool writes them, so those must be added by hand, once, per secret.
- **No secrets store yet:** env vars are stored in the environment config as plaintext,
  visible to anyone who can edit it. Keep the Fly token deploy-scoped, prefer a
  least-privilege Supabase role over the full service-role key where practical, and
  rotate after. Never put these in `NEXT_PUBLIC_*` build settings.
- Network level and env vars are **persistent per environment** (set once, apply to
  every future session) but changes only take effect in a **new** session — the running
  container keeps the policy it started with.
- The **mini-PC bot** can never be driven from a web session regardless — it needs a
  headed browser on the residential box (RustDesk). Corollary worth stating plainly:
  **its code cannot be smoke-tested from here**, because Playwright is not installed next
  to it and RC/rec.gov both refuse headless. That is exactly why
  `worker/{profile-lock,bot-env,rc-runner-cli}.test.mts` exist and stub the browser — they
  are the only mechanism that can catch a broken boot script before a human runs
  `update.bat`. Two real bugs shipped to that box on 2026-08-07 before they existed.
- **You CAN ASK THE BOX A QUESTION from a web session since 2026-08-11** (migration 053):
  `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts tail-log auto-update`, or Admin →
  System Health → "Ask the mini-PC". It rides the hold runner's existing 15-second poll.
  **The list of diagnostics is fixed and the box owns it** — `bot-commands.mjs` implements
  each kind and refuses anything else by name, so this is not and must not become a way to
  run commands on a machine holding the RC session and the credential store. Adding a kind
  means editing that file, not passing a different string. Six round-trips of "please paste
  that log" went into building it.
- **You CAN see the RC hold flow's state from a web session**, even though the bot is
  unreachable: `NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts`. It reads the
  database, so it works from anywhere, and it is the fastest answer to "did the 8am cart
  fire?" — `requested` with the release time already past means the runner is down.

See `docs/CONTEXT.md` for architecture and the decisions/gotchas behind the code.

## Repo tooling for agent sessions (added 2026-08-12)

Four small things, none of which touch runtime code. They exist because the same handful of
mistakes kept recurring and none of them was mechanically caught.

### `.claude/hooks/stop-typecheck.sh` — typecheck on Stop

Runs `npm run typecheck` (~25s, BOTH tsconfigs) when a turn ends and prints the failure.
**It always exits 0** — it reports, it does not gate. A hook that can refuse to end a turn
will eventually be in the way during an incident.

Not the full `npm run verify`: the tests hit the production database on purpose and two
minutes per Stop is too heavy. CI carries the full recipe. It has already earned its keep
twice — an invented `isAdmin`, and three module-scope Stripe helpers an edit left behind
that `npm test` alone would have waved through as a runtime error on the billing path.

**Do not over-trust it.** The same week it passed clean on a file `next build` rejected
(backticks inside a template literal), and `next build` passing is itself not enough for
layout changes.

### `scripts/deploy-scope.mts` — which of the three routes does this change need?

```bash
npx tsx scripts/deploy-scope.mts                    # working tree
npx tsx scripts/deploy-scope.mts origin/master..HEAD
```

Web is instant (Vercel), the worker is minutes (Fly), the mini-PC is **hours** and refuses
within six hours of a release. A change spanning web + mini-PC is live on one half and not
the other for that whole window — which is what produced the T−30/T−25 alarm gap on
2026-08-11. Run it against `bb426bd` to see it flag exactly that commit.

**Informational only; exit code is always 0.** A `Deploy-Targets:` commit trailer enforced
in CI was considered and rejected — it is a process gate a human has to remember, and it
would be forgotten in precisely the rushed commit that needs it. `autocart.bot_version`
catches the drift mechanically after the fact; this answers the question before the push.

### `.claude/skills/rc-status/` — the daily RC check

Encodes the reading rules, which is the part that goes wrong: `offered` is not a fault,
`requested` with the release past is the one broken state, a **stale** session verdict is not
a **dead** one, and `autocart.bot` being green says nothing about RC. The two Routines cover
the scheduled cases; this covers the ad-hoc one.

### `.mcp.json` — Sentry and Vercel only

Two servers, deliberately not five. Skipped: Supabase MCP (redundant with the interpreted
`tsx` readouts, and it tempts ad-hoc SQL that skips the judgment those scripts encode), Fly
(the session hook already installs `flyctl`), GitHub (already wired), and Playwright /
Chrome DevTools MCP (useless for portal debugging from a web session — the agent proxy
resets headless-Chromium TLS; fine against localhost or from your own CLI).

> **Confirm the two URLs on first connect.** They are the documented hosted endpoints, but
> they were written here without a way to reach them from this environment, and this project
> has been bitten twice by a URL recalled rather than read. A wrong one fails to connect and
> costs nothing else.

## Testing which SMS link shapes survive the carrier — `scripts/sms-link-test.mts`

**Why it exists.** `camphawk.app` came out of every SMS on 2026-08-05 to stop losing texts
(27 sent / 13 undelivered that day, then 71 sent / 71 delivered over the next week). That
was a **stopgap**, not the design — managing a watch, stopping alerts and claiming a hold
only exist on our own site, so the links have to come back. The question is not "does our
domain get filtered" but **which SHAPE of our link gets filtered**, and that was never
measured.

Every filtered message carried `camphawk.app/b/<token>`, and `/b/` is a **302 redirect**.
T-Mobile's Code of Conduct §4.8 is literally "URL Redirects/Forwarding" — the only
*documented* violation anywhere in this picture. The 08-05 experiment kept that link and
dropped `Manage:`, so **a plain non-redirecting URL on our domain has never been sent.**
`camphawk.app/manage/<token>` may deliver today with no campaign edit at all.

### Running it

```bash
npx tsx scripts/sms-link-test.mts                                  # DRY RUN, sends nothing
NODE_USE_ENV_PROXY=1 npx tsx scripts/sms-link-test.mts --with-redirect --send
# wait ~1 minute for the carrier receipts
NODE_USE_ENV_PROXY=1 npx tsx scripts/sms-link-test.mts --read
```

**`--read` needs only the database**, so results can be pulled from any session. Only
`--send` needs Twilio.

### The 2026-08-12 run — 4 of 4 delivered, and therefore inconclusive

Provider-only, bare `camphawk.app`, `camphawk.app/manage/<token>` and the `/b/<token>`
positive control **all delivered**, no error codes. The control is the reading: `/b/` was
filtered 13 for 13 on 08-05 and it arrived, so **filtering is simply not being applied
right now** and the run cannot rank shapes. This is the confound `--with-redirect` exists
to catch, and it is consistent with Twilio's "no filtering since August 5th".

Do not quote it as "our links are safe now" — it supports "our domain was not filtered on
2026-08-12", a claim about the day, not the shape. Choose the sample shape on the
documented rule instead (T-Mobile §4.8 names redirects): `/manage/<token>` in, `/b/` out.

**The run also found the instrument broken three ways**, none of which had ever been
exercised because the script had never run with real credentials: a **leading space** on
the Twilio credentials (all four sends rejected as `Authentication Error - invalid
username`); `notifications.user_id` **NOT NULL**, so all four rows failed *after* the texts
were sent while the summary read `Sent 4 of 4`; and `channel = 'sms_test'` **rejected by
the CHECK constraint**, so the isolation the script documents was never possible. Fixed by
`lib/notifications/twilio-env.ts` (+ `worker/twilio-env.test.mts`), a pre-flight on the
row, and **migration 057**. The results were recovered from Twilio's Messages API.

### What it needs, and what it refuses without

| Variable | Where |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio Console home — `AC` + 32 hex |
| `TWILIO_AUTH_TOKEN` | Same page, behind the "show" toggle |
| `TWILIO_MESSAGING_SERVICE_SID` | **Already in `docs/a2p-campaign.md`** — `MG7bf4f78c06ea99f61efcbccd8fe47b5b` ("Camp Hawk Alerts") |

**It REFUSES to send without the Messaging Service**, even though `sendSms` would fall back
to a bare `From` number. The A2P campaign hangs off the Messaging Service, so a bare number
sends under different campaign context and "delivered" would say nothing about the campaign
we actually send under. An uninterpretable result is worse than none: a number in a table
gets quoted later without its caveat.

**`--with-redirect` is not optional in practice.** It adds the `/b/<token>` positive
control. Without it, an all-delivered run cannot distinguish "the shape matters" from "the
filter is no longer being applied" — and Twilio has said no filtering has occurred since
08-05, so that confound is live.

### Two deliberate departures from the production path

1. **It posts to Twilio directly rather than through `sendSms`.** `sendSms` *refuses* any
   body containing an APP_HOST link — that guard is the regression detector standing between
   us and silently reintroducing the 08-05 bug, and a test flag through it would be a hole
   in the one thing that works.
2. **Rows are written `channel = 'sms_test'`, never `'sms'`.** The admin "Did the texts
   arrive?" panel counts `channel = 'sms'`, and this deliberately sends messages some of
   which are *expected* to be filtered — logging them normally would turn the regression
   detector red by running the experiment. The Twilio webhook matches on `provider_id` with
   no channel filter, so the receipts still land.

### Safety notes

- It sends to `SMS_TEST_TO`, defaulting to the owner's handset (`+18058235957`), the same
  number the daily delivery canary already texts.
- **No state-changing action link is ever sent.** The manage URL is minted with
  `manageUrlFor()` (`/manage/<token>`, a page), NOT `actionUrlFor()` — the latter returns
  `/w/<token>`, the one-tap action link, and a link scanner following one of those would
  stop or mute a real watch. The first draft of this script had that wrong.
- **`TWILIO_AUTH_TOKEN` is full account access** — send to any number, read every message
  body ever sent, spend money. If it was added to an agent environment for this one-off,
  remove it afterwards, or use a scoped `SK…` API key instead (revocable in one click, and
  not the token that signs the delivery webhooks).
