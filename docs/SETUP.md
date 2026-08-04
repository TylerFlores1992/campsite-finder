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
| **Auto-cart bot** (`scripts/auto-cart-bot/`) | The mini PC only | `git push`, then run `mini-pc/update.bat` on the mini PC (via RustDesk). It can't run anywhere else — it drives a real logged-in recreation.gov browser. |
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
| **TN/SC State Parks** (ColdFusion portal) | **No scheduled sync yet** — TN shipped 2026-07-20 (39 parks), SC 2026-07-22 (34 camping parks); there is no worker `*SyncIfDue` for either, so the catalog only refreshes when you run it by hand. **So `catalog.syncs` in `/api/health/status` goes `warn` every 48h and stays there** — it read "2 stale" for twelve days until a hand-run on 2026-08-04, and it will do it again. Running the sync resets the clock, it does not fix the cause; the fix is a scheduled sync, and now that the agent proxy is known to reach this portal the **nightly GitHub Action** is a candidate the way it already is for RIDB and ReserveAmerica (the Fly worker still can't, which is why there's no `*SyncIfDue`). | `NODE_USE_ENV_PROXY=1 npx tsx scripts/run-sync-tnsc.ts TN` / `... SC` (or no arg = all verified). Runs from a residential IP **or from a web session** — the agent proxy reaches this portal, verified 2026-08-04 (TN 39 + SC 34 parks, 0 errors, ~9s each). **The flag is load-bearing**: Node's fetch ignores the proxy without it and the WAF answers 403, which reads as "datacenter IPs are blocked" when the proxy would have gone straight through. What is blocked is **Fly**, which is why the worker uses `/api/tnsc-availability`. TN coords are embedded; **SC coords come from a curated `SC_PARK_COORDS` table** (portal ships none; name-geocoding was worthless — see `docs/CONTEXT.md`), so no Mapbox token is needed. |

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
> **Later migrations, all applied by hand to prod the same way:** `031_poller_shards`
> (the shard lease, 2026-07-31), `032_subscription_tiers`
> (`subscriptions.tier` + `grandfathered` — the Auto-Cart plan, 2026-08-01) and
> `033_recgov_rate_profile` (the full-day 429 profile table, 2026-08-01),
> `034_alert_prefs` (`users.email_alerts_opt_in` / `sms_consent_at` / `onboarded_at`
> for the welcome step, 2026-08-01), `035_watch_auto_cart_backfill` (2026-08-01) and
> `036_autocart_carted_history` (2026-08-03 — a partial index on
> `autocart_jobs (watch_id, campsite_id)` for the one-cart-per-site rule; index only,
> no schema change).
> None needs a worker deploy by itself, but 032, 033, 035 and 036 are all read by
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
                    recgov-scheduler.ts  THE one rec.gov fetch lane (single-flight,
                                    TTL cache, token-bucket budget)
                    lead-time.ts    hot/cold lead-day arithmetic for that lane
                    shard.ts        campground→machine sharding + DB lease (LIVE at
                                    SHARD_COUNT=2 since 2026-08-02)
                    rate-profile.ts full-day 429 profile recorder (recgov_rate_profile)
capacitor.config.ts  native app shell config; native/shell/ offline fallback page
                    (ios/, android/ generated by `npx cap add`, git-ignored)
extension/          Optional Chrome extension ("CampHawk Quick Cart") that reads the
                    #camphawk / #camphawk-rc fragments in alert links to autofill dates
                    and add to cart, in the user's own browser. Desktop only —
                    extensions don't run in mobile Chrome. Ships OFF by default.
scripts/auto-cart-bot/  Mini-PC Playwright bot + remote sign-in broker
scripts/            run-sync*.ts catalog syncs; e2e-gtc-alert.mts (live alert test —
                    SENDS REAL EMAIL/SMS); recgov-429-profile.mts (the rate readout);
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
`worker/`. Added 2026-07-30; before that the repo had no test script, no framework and
no test files.

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
and `worker/carted-history.test.mts` (real DB: the one-cart-per-(watch, site) rule —
that a carted site blocks a second cart, that a DIFFERENT site on the same watch does
not, that a NEW watch starts over, that a late `carted` report still blocks even when
the reconciler already resolved the job as `alerted`, and that a FAILED attempt does
not block a retry).

> **They hit the REAL database and need credentials**, so run with
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
  headed browser on the residential box (RustDesk).

See `docs/CONTEXT.md` for architecture and the decisions/gotchas behind the code.
