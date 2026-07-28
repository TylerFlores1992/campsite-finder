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
| Support URL | `https://camphawk.app` (a dedicated support page would be better) |
| Contact email | `alerts@camphawk.app` (already on /privacy and /terms) |
| Category | Travel (secondary: Navigation) |
| Age rating | 4+ — every questionnaire item is "None" |
| Export compliance | Already answered in-build: `ITSAppUsesNonExemptEncryption=false`, set by `codemagic.yaml`. HTTPS-only, exempt. |

---

## 4. Screenshots

`npx tsx scripts/app-store-shots.mts` renders the **real production build** on
localhost at Apple's 6.9" size (1320 × 2868) with the native User-Agent, so the store
gating applies exactly as it does in the app — the script asserts no price text appears
in any shot. Requires `next build` then `NODE_USE_ENV_PROXY=1 npx next start -p 3100`.

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

**Left, and only a human can do it:**
- Create the review demo account and comp it a subscription in Stripe.
- **Test account deletion once, on a throwaway account with a real subscription**, and
  confirm in Stripe that the subscription shows `canceled`. It has never been run
  end-to-end — it cannot be, from a sandbox, because it destroys the account it runs on.
- Enter metadata, answer the age-rating questionnaire, submit the privacy answers above.
- Upload screenshots, then Submit for Review.
