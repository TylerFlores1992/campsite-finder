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
> portal **directly** (fine from a residential IP — the portal's WAF blocks
> datacenter IPs, i.e. Fly, not homes). So TN availability can look fine locally and
> from Vercel, yet the worker still needs the proxy — which is exactly what bit us:
> the worker got `403 on landing` until `TNSC_AVAILABILITY_URL` was wired.

## Deploy — three separate targets

| Piece | Lives on | How to deploy |
|-------|----------|----------------|
| **Website** (Next.js) | Vercel | **Auto-deploys on every `git push` to `master`,** and `camphawk.app` auto-re-aliases to the new Production build (`autoAssignCustomDomains` is on). The old "build is `Ready` but the domain still points at the previous deployment" symptom (observed 2026-07-20) was **root-caused 2026-07-25**: pushing the *same commit SHA* to both a `claude/*` working branch and `master` made Vercel dedup by SHA — the branch preview built first and the master push then sometimes created **no** Production deployment, so auto-assign had nothing to move (and manual REST redeploys don't trigger auto-assign either). Fixed by **`vercel.json` → `git.deploymentEnabled: { "claude/*": false }`** so agent branches no longer spawn a shadowing preview; every `master` push now builds a fresh Production deployment and the domain follows on its own. So: **push to `master` and you're done — no `vercel --prod` / re-alias needed.** (If you ever *do* see a stale domain, `vercel --prod` from the repo root, or `POST /v2/deployments/<id>/aliases` with the READY Production deployment id, still forces it.) Also: **a new `SYNC_SECRET`-protected `/api/*` route 404s until it's added to `isPublicRoute` in `src/middleware.ts`** (Clerk's `auth.protect()` returns 404, not 401 — see `docs/CONTEXT.md`). |
| **Alert worker** (`worker/poller.ts`) | Fly.io app `campsite-finder-worker` | `flyctl deploy --config worker/fly.toml --dockerfile worker/Dockerfile --remote-only` (needs Fly login, and run it from the repo root — the build context is the whole repo). **The deploy leaves the poller stopped; you must `flyctl machine start <primary-id>` afterward, or alerting stays dead silently — see `docs/CONTEXT.md`.** Only needed when you change `worker/` or `src/lib` it uses — **including adding a ReserveAmerica contract, GoingToCamp tenant, or TN/SC provider**, since the worker imports those registries and a stale worker silently never alerts for the new state. **From a Claude-web session `flyctl deploy` can't build** (both Fly remote builders fail from the sandbox) — use the build-locally-and-deploy-the-image workaround in the web-session gotchas below; that's how the flexible-dates worker change shipped 2026-07-22. Serves `POST /gtc/availability` for the website's search page, and calls **out** to Vercel's `/api/tnsc-availability` for TN openings (needs `TNSC_AVAILABILITY_URL` set — see the proxy note below). |
| **Auto-cart bot** (`scripts/auto-cart-bot/`) | The mini PC only | `git push`, then run `mini-pc/update.bat` on the mini PC (via RustDesk). It can't run anywhere else — it drives a real logged-in recreation.gov browser. |
| **Mobile app** (Capacitor) | App Store / Play Store | Thin native shell around the live site — most changes ship via the normal web deploy (the app loads `camphawk.app`); you only rebuild the binary for native/plugin/icon changes. **Neither binary needs a machine of your own** — both build on Codemagic and are started from its web UI (works on a phone): `ios-testflight` (macOS runner → TestFlight) and `android-release` (Linux → signed AAB + sideloadable APK). Paid dev accounts still required. See **"Building the mobile app"** below. Push needs `FCM_SERVICE_ACCOUNT` on **both Vercel and the Fly worker**. |

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
| **TN/SC State Parks** (ColdFusion portal) | **No scheduled sync yet** — TN shipped 2026-07-20 (39 parks), SC 2026-07-22 (34 camping parks); there is no worker `*SyncIfDue` for either, so the catalog only refreshes when you run it by hand. | `npx tsx scripts/run-sync-tnsc.ts TN` / `... SC` (or no arg = all verified). Run from a **residential IP** — the portal's WAF blocks datacenter IPs. TN coords are embedded; **SC coords come from a curated `SC_PARK_COORDS` table** (portal ships none; name-geocoding was worthless — see `docs/CONTEXT.md`), so no Mapbox token is needed. |

**Feature-E probe roster (not a catalog sync).** `scripts/seed-probe-targets.ts`
populates `probe_targets` — the high-demand campgrounds the worker probes hourly for
the cancellation-likelihood signal. It's a **one-time-ish demand scan** (keeps sites
booked solid on a peak weekend), run by hand per source:
`NODE_USE_ENV_PROXY=1 npx tsx scripts/seed-probe-targets.ts --source=<src>` (add `--dry`
to preview). As of 2026-07-25 the roster is **502 active** across rec.gov, all 10
UseDirect states, and GoingToCamp (the seed's `isOpenInRange` supports all three; drop
`--source` to default to rec.gov). It's data-only — the worker reads `probe_targets`
live, so no redeploy. Migrations `020_availability_history` + `021_probe_targets` first.
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

> **Migrations are applied by hand** (020/021/023, and **`024_cost_items`** for the admin
> Costs tab). In a web session you can apply one directly:
> `sb.rpc('exec_dml', { query_text: <sql>, with_result: false })` with the service role —
> `exec_dml` runs DDL, so no Supabase SQL-editor round-trip needed. (PostgREST `.from()`
> won't see a brand-new table until its schema cache reloads; read back via `exec_select`.)

> **Admin cost tracking needs migration `024_cost_items.sql`** (applied by hand, like the
> others; already applied to prod 2026-07-26). It backs the editable "Fixed monthly costs"
> table in the admin **Costs** tab (`/admin`). The per-unit usage rates are non-secret env
> vars (`COST_PER_SMS_USD` etc.) with in-code defaults — see `docs/CONTEXT.md`. Nothing to
> deploy beyond a `master` push; no worker or secret involved.

**The native projects are NOT committed** (`ios/`, `android/` are git-ignored) — they're
generated on a machine with the platform tooling:

```
npx cap add ios          # needs macOS + Xcode
npx cap add android      # needs Android Studio
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
testing. `server.url` means you rarely rebuild the binary — only native/plugin/icon
changes need a new store build.

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
>   `authorization_invalid`). **Email/password sign-in works.** Proper fix (later): route
>   social sign-in through the system browser (Clerk + `@capacitor/browser`).
> - **Play Console device verification can't be done on an emulator** — it needs hardware
>   attestation (the Play Console app just white-screens on an emulator). Use a real
>   Android device (borrow one for 2 min). Identity (ID) verification is separate and
>   gates publishing, not local testing.
> - **`next build` won't complete in a keyless dev sandbox** — `api/stripe/checkout`
>   inits `new Stripe(process.env.STRIPE_SECRET_KEY!.trim())` at module load, so a build
>   without Stripe env throws "Failed to collect page data" for that route. `tsc --noEmit`
>   still validates; Vercel has the key. Verify web changes with typecheck + a real page
>   after deploy, not a full local `next build`.

### Android builds with NO Android Studio — Codemagic (added 2026-07-27)

The `android-release` workflow in `codemagic.yaml` mirrors the iOS one on a **Linux**
runner (no reason to spend Mac minutes): `npx cap add android`, brand, `cap sync`,
decode `google-services.json`, set the versionCode from Codemagic's build counter, then
`./gradlew bundleRelease assembleRelease`.

It emits **both an AAB and an APK**. The APK is the useful one at this stage — sideload
it and you can test the Android back button, external-link handoff and offline banner
without waiting on a Play review.

**Configure in the Codemagic UI, not in the file:**
- an **Android keystore** uploaded under the reference name `camphawk_upload`
  (Team → Code signing identities → Android keystores);
- an environment group `android_firebase` holding **`GOOGLE_SERVICES_JSON_B64`** — base64
  of `google-services.json` from Firebase → Project settings → Android app. If it's
  unset the build still succeeds and Android push simply stays off, matching iOS.

Play publishing is left commented out until a Google Play service account exists, so a
half-configured integration can't fail an otherwise good build.

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
> `navigator.userAgent`) and provides it via context; the pricing surfaces
> (`src/components/v2/Pricing.tsx` and `src/components/v2/WatchCta.tsx` — the only two
> that exist since the 2026-07-27 rewrite) render "manage at camphawk.app" instead of
> Stripe checkout when `useIsNativeApp()` is true. **Detection is CLIENT-side on purpose** — an earlier version read the UA in the
> root layout via `await headers()`, which under this build's Cache Components model
> 500'd every page at runtime (see the root-layout gotcha in `CLAUDE.md`/`CONTEXT.md`).
> The tradeoff is a first-render flash of pricing UI *inside the native app only* — web
> users are never native, so nothing flips for them; when the app ships, gate the
> pricing components on a mounted+native check rather than reintroducing a dynamic root
> layout. To sanity-check the web path is unaffected, load any page with a normal browser
> UA (no `CampHawkApp`) and the $2.50/mo · $20/yr buttons appear as before.

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
  db/               Supabase client + migrations/
src/app/(app)/      the app itself — a route group supplying nav/backdrop/footer
                    without a path segment: / /search /watches /new /settings
                    /campground/[id] /manage/[token].  See docs/CONTEXT.md.
src/components/ui/  design primitives (Button, Chip, Tag, Card, DatePicker, …)
src/components/v2/  the screens (Explore, WatchesList, NewWatch, Settings, …)
src/components/     what's left of the pre-rewrite UI: Logo, AuthPanel, SmsOptIn,
                    BetaTesters, AdminAutoRefresh
                    NativeBridge.tsx  Capacitor push bridge (no-op on web)
worker/             Fly.io cancellation poller (poller.ts)
                    http-server.ts  POST /gtc/availability, for the Vercel search page
                    liveness.ts     self-heal watchdog signals (heartbeat + egress)
capacitor.config.ts  native app shell config; native/shell/ offline fallback page
                    (ios/, android/ generated by `npx cap add`, git-ignored)
extension/          Optional Chrome extension ("CampHawk Quick Cart") that reads the
                    #camphawk / #camphawk-rc fragments in alert links to autofill dates
                    and add to cart, in the user's own browser. Desktop only —
                    extensions don't run in mobile Chrome. Ships OFF by default.
scripts/auto-cart-bot/  Mini-PC Playwright bot + remote sign-in broker
scripts/            run-sync*.ts catalog syncs; e2e-gtc-alert.mts (live alert test —
                    SENDS REAL EMAIL/SMS)
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
  is self-contained:** it lives ONLY in this env config — **no GitHub workflow deploys
  to Fly** (deploys are manual; the `worker-watchdog` Action just curls health), so
  after `fly tokens create deploy` + revoking the old one, update it here (and any local
  copy) and nothing else. (3) set `ENABLE_OPS_TOOLS=1` so the hook
  installs flyctl + the Supabase CLI. The Supabase CLI comes from npm and installs
  fine; **flyctl does NOT** — see the next bullet.
- **Rendering a real PAGE (not just a component) needs Clerk keys — the CampHawk
  environment now has them (added 2026-07-27).** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
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
    builds) can't run here.** The **depot** builder (the default) fails its gRPC TLS
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
