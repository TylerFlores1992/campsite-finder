# App Store submission — privacy answers, review notes, checklist

Everything App Store Connect asks for that isn't a build. **The privacy answers below
are derived from the code, not from memory** — each line says where in the repo the
claim comes from, so it can be re-checked when something changes. Getting these wrong
is a rejection, and getting them *stale* is worse: the label keeps saying something the
app stopped doing.

Last audited 2026-07-28.

---

## 1. App Privacy ("nutrition labels")

### Data used to track you

**NONE.** There is no ad network, no analytics SDK that shares with data brokers, no
IDFA, and nothing joined with third-party data for advertising. So **App Tracking
Transparency does not apply** and the app must not show an ATT prompt.

### Data linked to you

| Apple category | What, and where it comes from | Purpose |
| --- | --- | --- |
| **Contact Info → Email Address** | `users.email`, set from Clerk at sign-up (`lib/auth.ts` `syncUser`). Alerts are emailed here. | App Functionality |
| **Contact Info → Phone Number** | `users.phone`, optional, entered by the user for SMS alerts (`v2/SmsAlerts.tsx`, migration `005`). | App Functionality |
| **Identifiers → User ID** | The Clerk user id, primary key of `users`. | App Functionality |
| **Identifiers → Device ID** | FCM push tokens in `push_tokens` (migration `023`), registered by the app via `POST /api/user/push-token`. | App Functionality |
| **Purchases → Purchase History** | Subscription *status* plus Stripe customer/subscription ids in `subscriptions`. **No card data ever reaches our servers** — Stripe Checkout handles payment entirely. | App Functionality |
| **Other Data** | The watches a user creates (campground + dates) and saved favourites. This is the product's own data, tied to the account. | App Functionality |

### Data not linked to you

| Apple category | What, and where it comes from | Purpose |
| --- | --- | --- |
| **Location → Coarse Location** | `/api/geo` reads Vercel's `x-vercel-ip-*` headers to centre a first search. Never stored. | App Functionality |
| **Location → Precise Location** | Only when the user taps "use my location" (`@capacitor/geolocation` via `v2/geo.ts`). Sent with the search query to find nearby campgrounds; **not stored in any table.** | App Functionality |
| **Diagnostics → Crash Data, Performance Data** | Sentry (`instrumentation-client.ts`, `instrumentation.ts`), `tracesSampleRate: 0.1`. | App Functionality |

> **Session Replay is NOT active, despite what the config looks like.**
> `replaysOnErrorSampleRate: 1.0` is set, but `@sentry/nextjs` v10 only records when
> `Sentry.replayIntegration()` is added, and it isn't (checked 2026-07-28: zero
> references). So no screen recording happens and none is declared. **If anyone ever
> adds that integration, this label becomes wrong** — replay would capture screen
> contents and would have to be disclosed.

### Third parties that receive data

Clerk (auth), Stripe (payments), Supabase (database), Resend (email), Twilio (SMS),
Firebase Cloud Messaging (push), Mapbox (geocoding — receives the place text typed and
map coordinates), Sentry (diagnostics), Vercel (hosting, coarse IP location).

### Account deletion

**Yes, in-app.** Settings → **Delete account** (`v2/DeleteAccount.tsx` →
`POST /api/user/delete`). Cancels the Stripe subscription immediately, deletes the
Clerk user, and deletes the database row — every user-owned table cascades. Required
by guideline 5.1.1(v); see `docs/CONTEXT.md` → "Account deletion" for why the order
matters.

---

## 2. App Review notes

Paste into **App Review Information → Notes**. The first section is the one that
prevents the predictable rejection.

```
WHAT THE APP DOES
CampHawk watches campgrounds that are fully booked and alerts the user within
seconds of a cancellation, so they can grab the site. Searching live availability
across 8,000+ campgrounds is free and requires no account.

BUSINESS MODEL — PLEASE READ (Guideline 3.1.3(b), Multiplatform Services)
CampHawk is a multiplatform service. The subscription is purchased on our website,
camphawk.app, and the app simply lets an existing subscriber use what they have
already bought — the same arrangement as a reader/multiplatform app.

The app contains NO purchase mechanism of any kind. It does not display prices, does
not offer a subscribe or buy button, and does not link out to any purchase flow. A
non-subscriber is told only that "Subscriptions are managed at camphawk.app". This is
enforced in code: the webview's User-Agent carries a "CampHawkApp" marker, and every
pricing surface renders a price-free variant when it is present.

There is therefore no in-app purchase to implement. The free functionality (search)
works fully without an account or a subscription.

DEMO ACCOUNT
Email:    <fill in>
Password: <fill in>
This account has an active subscription so you can see watch creation and alerts.
Sign-in is email + password. Social sign-in is deliberately hidden in the app
(Google blocks OAuth inside embedded webviews), so no third-party login is offered
and Sign in with Apple is not applicable.

ACCOUNT DELETION (5.1.1(v))
Settings tab → "Delete account" at the bottom. It deletes the account and all of its
data, and cancels any subscription immediately.

PUSH NOTIFICATIONS
Push is the core of the product: it is how a user hears that a campsite opened up.
Permission is requested only after the user creates their first watch, not on launch,
because before that there is nothing to notify them about.

LOCATION
Optional. Used only to centre a campground search on the user's area. Declining it
leaves search fully usable — the user types a place name instead.
```

---

## 3. Listing fields

| Field | Value |
| --- | --- |
| Privacy Policy URL | `https://camphawk.app/privacy` |
| Support URL | `https://camphawk.app/support` |
| Contact email | `alerts@camphawk.app` (already on /privacy and /terms) |
| Category | Travel (secondary: Navigation) |
| Age rating | 4+ — every questionnaire item is "None" |
| Export compliance | Already answered in-build: `ITSAppUsesNonExemptEncryption=false`, set by `codemagic.yaml`. HTTPS-only, exempt. |

---

## 4. Screenshots

`npx tsx scripts/app-store-shots.mts` renders the **real production build** on
localhost with the native User-Agent, so the store gating applies exactly as it does in
the app — the script reports whether any price text appears, and whether the shot was
caught mid-request. Requires `next build` then
`NODE_USE_ENV_PROXY=1 npx next start -p 3100`.

`SHOTS_SIZE=6.9` (default, 1320 × 2868) or `SHOTS_SIZE=6.5` (1284 × 2778). **App Store
Connect has one upload box per display size and rejects anything whose dimensions don't
match that box exactly** — a 6.9" shot dropped on the 6.5" box errors out rather than
being resized. Only 6.9" is required; 6.5" is what older devices' store pages show.

> The credentials the render needs (Clerk, Mapbox, Supabase) are **injected as process
> env vars in the web session, not `.env` files** — `grep`ping for `.env` finds nothing
> and is not evidence they're missing. Check `printenv` instead.

> **The campground detail page is deliberately not in the set.** Its photo strip loads
> from recreation.gov's CDN and its map from Mapbox, and a sandboxed browser can reach
> neither — the page renders with a tall blank gap where the photos belong. Capture
> that one on a real device.

Apple needs at least one 6.9" screenshot; up to 10 are allowed.

---

## 5. What's done vs what's left

**Done:** app record, `CampHawk ASC` API key, signing, push verified on a real iPhone,
export compliance, branded icons, TestFlight build, in-app account deletion, and the
screenshots above.

Also done 2026-07-29:
- **Account deletion tested end-to-end** on a throwaway account with a real
  subscription. Stripe showed `canceled`, the `users` row was gone, Clerk had zero
  accounts. Re-signup with the same email works.
- **Demo account** `tylerflores1992@yahoo.com` — `trialing`,
  `cancel_at_period_end=False`, card attached, trial ends 2026-08-05. Three watches
  across two reservation systems with October dates, so the reviewer sees a populated
  app rather than an empty state.
- **App Privacy label published** — the ten data types in §1, App Functionality on all
  ten, tracking = No on all ten.
- **Age rating** 4+, **Privacy Policy URL**, **Content Rights** = yes (RIDB + state
  portal data is third-party content even though it's public).
- **Pricing and Availability:** free, **United States only** — which is what keeps
  `NATIVE_LINKOUT` legally usable. See the store-billing note in `docs/CONTEXT.md`.

**Left, and only a human can do it:**
- Enter the §6 metadata on the version page, upload the screenshots, select the build.
- Fill the demo account **password** into the §2 notes — the notes ship with a
  `<fill in>` placeholder, and a reviewer who cannot sign in rejects on day one.
- Submit for Review. Release is set to **manual**, so approval does not go live.
- **On going live:** set `NATIVE_LINKOUT = true` in `v2/nativeSubscribe.tsx`.

---

## 6. Store listing copy

Character counts are checked against Apple's limits and shown per field. **Nothing
here names a price**, and nothing points at where to buy — the anti-steering rule
covers the listing, not just the app, and a price in the description is the easy way
to lose a 3.1.3(b) argument you would otherwise win.

The affiliation disclaimer at the end is not boilerplate: the app searches government
reservation systems, and implying endorsement is both untrue and a rejection risk.

| Field | Value | Length |
| --- | --- | --- |
| **App Name** | `CampHawk: Campsite Alerts` | 25/30 |
| **Subtitle** | `Catch campsite cancellations` | 28/30 |
| **Keywords** | `campsite,campground,camping,cancellation,reservation,availability,tent,rv,national park,state park` | 98/100 |

> **Keywords deliberately exclude "alerts", and every competitor name.** Apple indexes
> the app name separately, and "Alerts" is already in it, so repeating it wastes
> characters from a 100-char budget. Competitor brand names in keywords are a known
> rejection. Note the field is comma-separated with NO spaces — a space costs a
> character and buys nothing.

**Promotional Text** (153/170 — editable any time WITHOUT submitting a new build, so
this is the field to use for seasonal messaging):

```
Sold out for the weekend you wanted? CampHawk watches that campground around the clock and tells you the second someone cancels - usually within seconds.
```

**Description** (1502/4000):

```
The campsite you wanted is already booked. CampHawk waits for it.

Popular campgrounds sell out months ahead - but people cancel constantly. CampHawk checks the campgrounds you care about every 15 seconds, around the clock, and tells you the moment a site opens up, so you can book it before anyone else notices.

HOW IT WORKS
1. Search live availability across 8,000+ campgrounds. Free, and no account needed.
2. Everything booked? Set a watch on the campground and dates you want.
3. Get an alert within seconds of a cancellation, with a link straight to the booking page.

WHAT YOU GET
- Checks every 15 seconds, day and night
- Push, text and email alerts sent at once - whichever reaches you first wins
- Flexible dates: watch for any two nights in a window, or weekends only
- Auto-cart on Recreation.gov: the site is added to your cart, so you only have to check out
- One tap from any alert to pause a watch, resume it, or mute a site you do not want

WHERE IT WORKS
Every Recreation.gov campground in all 50 states, plus state parks in 34 states - more than 8,000 campgrounds, with live availability for each.

FREE AND PAID
Searching live availability is free and needs no account. Watching a booked campground, and the alerts that come with it, require a subscription.

CampHawk is an independent app. It is not affiliated with or endorsed by Recreation.gov, the National Park Service, the US Forest Service, or any state park agency. Bookings are completed on the official reservation site.
```

**What's New** (347/4000):

```
First release.

CampHawk watches campgrounds that are already fully booked and alerts you within seconds of a cancellation, so you can grab the site.

- Live availability search across 8,000+ campgrounds, free and without an account
- Watches with push, text and email alerts
- Flexible dates, including weekends-only
- Auto-cart on Recreation.gov
```

> **The numbers are checked, not remembered.** 8,013 campgrounds in the catalog as of
> 2026-07-29 (4,469 of them Recreation.gov), 50 states, 34 with state-park coverage,
> and a 15-second poll (`POLL_INTERVAL_MS` in `worker/fly.toml`). Copy says "8,000+"
> because `lib/coverage.ts` rounds DOWN by rule — never overstate. Re-check with
> `npx tsx scripts/coverage-readout.mts` before changing these lines.
