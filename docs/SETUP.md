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
| **Website** (Next.js) | Vercel | **Auto-deploys on every `git push` to `master`.** Usually nothing else to do — but note (observed 2026-07-20) a master merge can build a new Production deployment that **does not re-alias `camphawk.app` to it**, so a new route keeps 404ing while `vercel ls` shows the build `Ready`. If that happens, force it with `vercel --prod` from the repo root (or promote the deployment); worth checking the project's Git auto-alias setting. Also: **a new `SYNC_SECRET`-protected `/api/*` route 404s until it's added to `isPublicRoute` in `src/middleware.ts`** (Clerk's `auth.protect()` returns 404, not 401 — see `docs/CONTEXT.md`). |
| **Alert worker** (`worker/poller.ts`) | Fly.io app `campsite-finder-worker` | `flyctl deploy --config worker/fly.toml --dockerfile worker/Dockerfile --remote-only` (needs Fly login, and run it from the repo root — the build context is the whole repo). **The deploy leaves the poller stopped; you must `flyctl machine start <primary-id>` afterward, or alerting stays dead silently — see `docs/CONTEXT.md`.** Only needed when you change `worker/` or `src/lib` it uses — **including adding a ReserveAmerica contract, GoingToCamp tenant, or TN/SC provider**, since the worker imports those registries and a stale worker silently never alerts for the new state. Serves `POST /gtc/availability` for the website's search page, and calls **out** to Vercel's `/api/tnsc-availability` for TN openings (needs `TNSC_AVAILABILITY_URL` set — see the proxy note below). |
| **Auto-cart bot** (`scripts/auto-cart-bot/`) | The mini PC only | `git push`, then run `mini-pc/update.bat` on the mini PC (via RustDesk). It can't run anywhere else — it drives a real logged-in recreation.gov browser. |

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
| **TN State Parks** (ColdFusion portal) | **No scheduled sync yet** — TN shipped 2026-07-20 (39 parks) via a manual run; there is no worker `*SyncIfDue` for it, so the catalog only refreshes when you run it by hand. SC is stubbed (`verified:false`) pending its own recon. | `npx tsx scripts/run-sync-tnsc.ts TN` (verified providers only). Run from a **residential IP** — the portal's WAF blocks datacenter IPs. Coordinates are embedded in the portal (no geocoding). |

Adding a state to an **existing** platform is usually a one-line registry entry —
`RA_CONTRACTS` (`src/lib/sources/reserveamerica/client.ts`), `USEDIRECT_PROVIDERS`
(`src/lib/sources/reservecalifornia/providers.ts`), `GOINGTOCAMP_PROVIDERS`
(`src/lib/sources/goingtocamp/providers.ts`), or `TNSC_PROVIDERS`
(`src/lib/sources/tnsc/providers.ts`) — plus a sync run and the coverage copy
(`src/app/layout.tsx` metadata, SubscribeGate). **South Carolina is the one live
cheap-ish add:** it's already stubbed in `TNSC_PROVIDERS` (`verified:false`) and
reuses TN's client + Vercel proxy, but its landing renders differently, so its
catalog parse needs its own recon before flipping `verified:true`.

**Then deploy the Fly worker.** The worker imports those registries, so a push alone
leaves it stale and the new state's watches never alert — silently, with no error.
Confirm with `scripts/e2e-gtc-alert.mts` / `scripts/e2e-tnsc-alert.mts` (they send a
real email/SMS; see `docs/CONTEXT.md`). Apart from SC, there are **no cheap registry
adds left** — every remaining state needs a new adapter. See `docs/CONTEXT.md` before
going hunting.

## Repo layout (orientation)

```
src/app/            Next.js routes + API routes (search, stripe, auto-cart/*, webhooks/*)
                    api/rc-proxy    Vercel-side proxy for UseDirect (Fly is WAF-blocked there)
src/lib/            Core logic
  availability/     per-source availability checks (recgov, reservecalifornia,
                    reserveamerica, goingtocamp [+ goingtocamp-remote: asks the worker])
  sources/          catalog sync per platform (ridb, reservecalifornia [+UseDirect states],
                    reserveamerica, goingtocamp)
  notifications/    email + SMS dispatch
  booking-url.ts    the one place that builds a booking link (site/date deep links);
                    records what each provider actually honors — see docs/CONTEXT.md
  db/               Supabase client + migrations/
src/components/     UI (SearchBar, map, WatchesPanel, AutoCartToggle, SubscribeGate, …)
worker/             Fly.io cancellation poller (poller.ts)
                    http-server.ts  POST /gtc/availability, for the Vercel search page
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

See `docs/CONTEXT.md` for architecture and the decisions/gotchas behind the code.
