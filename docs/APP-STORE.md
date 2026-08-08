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

**Where:** on the **version page** (iOS App Version 1.0), section *App Review
Information* — not the app-level "General → App Review" nav item. It is one of the
fields Apple lets you edit while the version sits in *Waiting for Review*, so it can be
corrected without giving up the queue position.

Three parts, all filled in and saved as of 2026-08-08:
- **Sign-In Information** — "Sign-in required" ticked, username `tylerflores1992@yahoo.com`
  and a real password. **This is the field that matters**; a reviewer who cannot sign in
  rejects on day one.
- **Contact Information** — name, phone, email. Populated.
- **Notes** — the block below, 1,992 characters in the field.

> **The `<fill in>` password below is CORRECT and must stay that way.** This file is in
> git; the real password belongs only in the console's Password field. "The doc still
> says `<fill in>`" is not a defect and has now twice been mistaken for one — **verified
> 2026-08-08 that the console field is populated**, which is the only thing that matters.

The first section of the notes is the one that prevents the predictable rejection.

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
Credentials are in the Sign-In Information fields above.
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

**SUBMITTED 2026-07-30ish — version 1.0 is "Waiting for Review" (confirmed 2026-08-08).**
The checklist below was never ticked off, which made this file read as though nothing had
been submitted. It had. **Trust App Store Connect over this section**; the items are kept
only because two of them are still worth doing.

**Waiting for Review is the QUEUE, not the review.** The "median ~24h" figure is
*In Review → decision* and excludes queue time; a first submission from a new team sits
longest. Long ≠ stuck, and there is nothing in the repo to change.

**What is still editable WITHOUT losing the queue position.** The version page says:
*"You can edit some information while your version is waiting for review. To submit a new
build, you must remove this version from review."* So metadata and **App Review
Information** can be fixed in place — only a BUILD swap costs the place in line.
- ~~Fill the demo account password~~ — **VERIFIED DONE 2026-08-08.** Sign-in required is
  ticked, username + password are present, contact info is filled and the notes field
  holds 1,992 characters. Nothing to fix; stop re-flagging §2's `<fill in>`.
- Confirm the §6 metadata and screenshots are what you want; also editable in place.

**What NOT to do:** don't remove from review to attach a newer build. The app is a webview
on camphawk.app, so almost every fix since is web-side and already reaches the attached
build. The native-only delta is the Capacitor 8 shell and the second location purpose
string, and **ITMS-90683 is a warning email, not a rejection** — it says a purpose string
will be required in *future* submissions. Both keys are in `codemagic.yaml` already, so
the next build clears it whenever a next build happens for another reason.

**If it keeps sitting:** Contact Us → App Review → status enquiry is the sanctioned nudge.
Expedited review is for critical fixes and dated events, not a slow first queue.

**Still left:**
- **Release is AUTOMATIC, not manual** (corrected 2026-08-08 from the version page — this
  doc and `CLAUDE.md` both claimed manual for weeks). *"Automatically release this
  version"* is selected, so **approval puts it on the App Store by itself** with no human
  step. Deliberately left that way: the app is a webview on camphawk.app, so there is no
  pre-launch work that has to happen between approval and going live, and after a queue
  this long the shortest path to live is the right one. The `NATIVE_LINKOUT` flip is a
  *post*-launch step by design — its precondition is production being live and US-only.
- **On going live:** set `NATIVE_LINKOUT = true` in `v2/nativeSubscribe.tsx`.

---

## 6. Store listing copy

Character counts are checked against Apple's limits and shown per field. **Nothing
here names a price**, and nothing points at where to buy — the anti-steering rule
covers the listing, not just the app, and a price in the description is the easy way
to lose a 3.1.3(b) argument you would otherwise win.

The affiliation disclaimer is not boilerplate: the app searches government
reservation systems, and implying endorsement is both untrue and a rejection risk.

> **SOURCE LINKS ADDED 2026-08-04, and the disclaimer MOVED TO THE TOP — learned from
> Google, not from Apple.** Play rejected the Android listing on 2026-08-03 under its
> Misleading Claims policy: an app showing government information must cite a clear,
> official, **functional** source for it in the description and carry an **easy-to-see**
> disclaimer that it does not represent a government entity. Apple has never raised it
> and its guideline wording differs, so this is pre-emptive — but the exposure is the
> same shape, the fix is text-only, and being the second store to notice is a worse
> position than being ready.
>
> The disclaimer text here was already correct and still got cited: Google's objection
> was that it sat in the FINAL paragraph. **Buried is not "easy to see."** It now opens
> the description and closes it, exactly as on Play.
>
> Source of truth is `src/lib/data-sources.ts` — the same list feeding `/sources` and
> the Play listing, so the three cannot drift. **Adding a sync adapter means adding it
> there in the same change.** A dead link is the violation itself; all 19 URLs were
> re-fetched on 2026-08-04 and returned 200.
>
> Paste `docs/appstore-description.txt`, don't retype from here.
>
> **TIMING — check the version state in App Store Connect first.** A version that is
> *In Review* cannot have its metadata edited without pulling it from review, which
> forfeits the queue position. If the current version is in review, either wait for the
> decision or edit only after it lands. The Description is NOT one of the fields
> editable without a new build — unlike Promotional Text, which is.

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

**Description** (3581/4000 — 419 spare). Verbatim copy of
`docs/appstore-description.txt`:

```
CampHawk is an independent app and does not represent any government entity. It is not affiliated with or endorsed by any government agency. Every source of campground information used in this app is listed at the end of this description.

The campsite you wanted is already booked. CampHawk waits for it.

Popular campgrounds sell out months ahead - but people cancel constantly. CampHawk checks the campgrounds you care about every 15 seconds, around the clock, and tells you the moment a site opens up, so you can book it before anyone else notices.

HOW IT WORKS
1. Search live availability across 8,000+ campgrounds. Free, and no account needed.
2. Everything booked? Set a watch on the campground and dates you want.
3. Get an alert within seconds of a cancellation, with a link straight to the official booking page.

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

WHERE OUR INFORMATION COMES FROM
CampHawk does not create campground or availability information. It reads what the official reservation systems below publish and links you back to them to book. The same list is also at https://camphawk.app/sources

- Recreation.gov - federal campgrounds in all 50 states (National Park Service, U.S. Forest Service, Bureau of Land Management, U.S. Army Corps of Engineers): https://www.recreation.gov
- Recreation Information Database (RIDB), the federal open-data service: https://ridb.recreation.gov
- ReserveAmerica state parks in AK, CT, DE, GA, IA, IN, KY, MT, NC, NE, NH, NM, NY, OR, PA, RI, TX, UT: https://www.reserveamerica.com
- Ohio State Parks: https://reserveohio.com
- California State Parks: https://www.reservecalifornia.com
- Michigan DNR: https://midnrreservations.com
- Mississippi MDWFP: https://reserve.mdwfp.com
- Washington State Parks: https://washington.goingtocamp.com
- Wisconsin State Parks: https://wisconsin.goingtocamp.com
- Minnesota State Parks: https://reservemn.usedirect.com
- Illinois State Parks: https://recreation.exploremoreil.com
- Virginia State Parks: https://www.reservevaparks.com
- Florida State Parks: https://reserve.floridastateparks.org
- Missouri State Parks: https://icampmo1.usedirect.com
- Wyoming State Parks: https://reserve.wyoming.gov
- Nevada State Parks: https://www.reservenevada.com
- Tennessee State Parks: https://reserve.tnstateparks.com
- South Carolina State Parks: https://reserve.southcarolinaparks.com
- Arizona State Parks & Trails: https://azstateparks.com/reserve/

DISCLAIMER
CampHawk is an independent app and does not represent any government entity. It is not affiliated with, endorsed by, or authorized by Recreation.gov, the National Park Service, the U.S. Forest Service, the Bureau of Land Management, the U.S. Army Corps of Engineers, or any state park agency. All campground information and availability shown in CampHawk comes from the official sources listed above, and every booking is completed on the official reservation site.
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
