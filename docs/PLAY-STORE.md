# CampHawk — Google Play submission reference

Companion to `docs/APP-STORE.md`. Same product, different taxonomy: Play's data-safety
form and listing limits are NOT Apple's, so this file states Play's answers in Play's
words rather than pointing at the Apple ones and hoping.

App record created 2026-08-01. Package `app.camphawk.mobile` (permanent — it matches
`appId` in `capacitor.config.ts` and the AAB Codemagic builds).

---

## 0. The critical path, and why production is ≥14 days out

Play confirmed on the app dashboard (2026-08-01) that this **personal** developer
account must, before it can even apply for production:

1. Publish a **closed testing** release
2. Have **at least 12 testers opted in** (0 currently)
3. Run that closed test with those 12 for **at least 14 continuous days**

The 14-day clock starts when the closed test is published, and a closed test cannot
start until "Finish setting up your app" is complete — store listing, data safety,
content rating. **That content is therefore the long pole, not the build.** The APK
sideloaded onto a phone on 2026-08-01 does not count: testers must opt in through Play
with real Google accounts and stay opted in for the whole window.

Internal testing has no such gate and can be published immediately — do that first, both
to prove the AAB uploads cleanly and because it is where the **country restriction** can
be set today.

## 1. Country availability — US only

**IT CANNOT BE SET UNTIL PRODUCTION ACCESS IS GRANTED.** Verified in the console
2026-08-01: the Production section answers *"You don't have access to production yet"*
and has no Countries/regions tab at all. Production access itself is gated behind the
closed test in §0, so the earliest this can be done is after those 14 days.

Where it does and doesn't exist, once unlocked:

| Track | Country setting? |
| --- | --- |
| Internal testing | **No** — access is by email tester list, geography is irrelevant |
| Closed testing | **No** when using an email list / Google Group, for the same reason |
| Open testing | Yes — but only relevant if an open beta is ever run |
| **Production** | **Yes — this is the one that matters**, set on the production release |

An earlier draft of this file said to set it on every track. That was wrong, and worth
recording: a testing track gated by an explicit email list is not a geographic exposure,
so there is nothing to restrict there.

> **The CLOSED track is deliberately open to ALL COUNTRIES (2026-08-02)** — a paid
> tester service is topping up the 12, and its testers are international. That is safe
> ONLY because `NATIVE_LINKOUT` is false: with no price and no route to an outside
> purchase anywhere in the app, there is no steering UI for a non-US storefront to
> object to. The restriction protects the steering, not the app.
>
> **Therefore the two must move together.** Turning `NATIVE_LINKOUT` on while non-US
> testers can install is exactly the combination the US-only rule exists to prevent.
> Before that flag flips: production must be US-only AND the closed track's global
> access must be withdrawn (or the track closed).

The reason is the same one that governs Apple: `NATIVE_LINKOUT` in
`src/components/v2/nativeSubscribe.tsx` sends non-subscribers in the app out to
camphawk.app to subscribe, and both stores' anti-steering carve-outs are **US-storefront
only**. Device locale is not a storefront check. Apple was restricted 2026-07-30.

**The flag needs BOTH conditions and still stays dark until then:** US-restricted AND the
app actually live in a store.

## 2. Listing fields

Play limits differ from Apple's, and Play has **no keywords field** — the full
description is what gets indexed, so the terms have to appear in prose. Nothing below
names a price, for the same reason as the App Store listing: the anti-steering rule
covers the listing, not just the app.

| Field | Value | Length |
| --- | --- | --- |
| **App name** | `CampHawk: Campsite Alerts` | 25/30 |
| **Short description** | `Know within seconds when a booked campsite is cancelled.` | 56/80 |
| **Category** | Travel & Local | — |
| **Contact email** | the developer account address | — |
| **Website** | `https://camphawk.app` | — |
| **Privacy policy** | `https://camphawk.app/privacy` | — |

> ### REJECTED 2026-08-03 — Misleading Claims, "Missing Source Link for Government
> ### Information". The description below is the REPLACEMENT.
>
> Play rejected the listing because an app that surfaces government information must
> (a) cite a clear, official, functional source for it in the description and (b) carry
> an **easy-to-see** disclaimer that it does not represent a government entity.
>
> **Do not appeal.** The appeal path is only for developers who hold written proof of
> government affiliation or authorization. CampHawk has neither, and says so — appealing
> asserts the opposite and burns 7+ days.
>
> Two things were wrong, and only one was obvious:
> - **No source URLs anywhere.** This was the named violation.
> - **The disclaimer was the LAST paragraph**, after the paywall sentence. The wording
>   was already fine — Google quoted it back approvingly as a separate finding — but
>   buried is not "easy to see". It now opens the description and closes it.
>
> The canonical source list is `src/lib/data-sources.ts`, rendered at
> **https://camphawk.app/sources** and linked from the app footer, so the citation is
> reachable from inside the app and not only from the listing. **Adding a sync adapter
> means adding it there in the same change** or the app ships government data with no
> cited source again.
>
> The description text lives in `docs/play-full-description.txt` — paste that file, do
> not retype from here.

**Full description** (3,898/4,000 — 102 spare; re-count after any edit, the source list
is long and the cap is hard). Verbatim copy of `docs/play-full-description.txt`. Every
URL was checked live on 2026-08-03 and all 19 returned HTTP 200; a dead link here is
the exact violation being fixed:

```
CampHawk is an independent app and does not represent any government entity. It is not affiliated with or endorsed by any government agency. Every source of campground information used in this app is listed at the end of this description.

The campsite you wanted is already booked. CampHawk waits for it.

Popular campgrounds sell out months ahead - but people cancel constantly. CampHawk checks the campgrounds you care about every 15 seconds, around the clock, and tells you the moment a site opens up, so you can book it before anyone else notices.

HOW IT WORKS
1. Search live campsite availability across 8,000+ campgrounds. Free, and no account needed.
2. Everything booked? Set a watch on the campground and dates you want.
3. Get a cancellation alert within seconds, with a link straight to the official booking page.

WHAT YOU GET
- Checks every 15 seconds, day and night
- Push, text and email alerts sent at once - whichever reaches you first wins
- Flexible dates: watch for any two nights in a window, or weekends only
- Auto-cart on Recreation.gov: the campsite is added to your cart, so you only have to check out
- One tap from any alert to pause a watch, resume it, or mute a site you do not want

WHERE IT WORKS
Every Recreation.gov campground in all 50 states, plus state park camping in 34 states - more than 8,000 campgrounds, with live availability for each. National park campgrounds, national forest campgrounds, state park campsites, tent sites, RV sites and group sites.

WHO IT IS FOR
Anyone who has watched a national park campground sell out five minutes after the booking window opened. Yosemite, Yellowstone, Zion, Glacier, Joshua Tree, Acadia, the Smokies - the campgrounds that are always full are exactly the ones people cancel.

FREE AND PAID
Searching live campsite availability is free and needs no account. Watching a booked campground, and the cancellation alerts that come with it, require a subscription.

WHERE OUR INFORMATION COMES FROM
CampHawk does not create campground or availability information. It reads what the official reservation systems below publish and links you back to them to book. The same list is also at https://camphawk.app/sources

- Recreation.gov - federal campgrounds in all 50 states (National Park Service, U.S. Forest Service, Bureau of Land Management, U.S. Army Corps of Engineers): https://www.recreation.gov
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

> **Why this differs from the Apple description.** Play indexes the description, Apple
> uses a separate keywords field, so this version works the search terms into prose —
> "cancellation alert", "campsite availability", "national park campground", "RV sites",
> and a WHO IT IS FOR paragraph naming the parks people actually search for. Same facts,
> more surface. Numbers are re-checked, never remembered: 8,013 campgrounds as of
> 2026-07-29 and a 15-second poll (`POLL_INTERVAL_MS`), stated as "8,000+" because
> `lib/coverage.ts` rounds DOWN by rule.

## 3. Graphics

| Asset | Spec | Status |
| --- | --- | --- |
| App icon | 512×512 PNG, 32-bit | generated by `npm run cap:assets` |
| **Feature graphic** | **1024×500 PNG/JPEG — REQUIRED** | see below |
| Phone screenshots | 2–8, portrait | 5 captured on real hardware 2026-08-01 |

**The feature graphic is a Play-only asset with no Apple equivalent**, and the listing
cannot be published without it. It is displayed above the screenshots and must contain
no device frames, no screenshots-of-screenshots, and no claims that duplicate the store
metadata.

Screenshots captured 2026-08-01 on a physical Android device — required because the
sandboxed browser can reach neither Mapbox nor recreation.gov's photo CDN, so any
map or photo strip renders blank from CI (see `docs/SETUP.md`). The set: search form,
results + map, campground detail with photos, new watch, watches list.

## 4. Data safety form

Play's taxonomy, not Apple's. **"Shared" in Play means disclosed to a third party for
their own use** — a processor acting on our behalf (Stripe, Resend, Twilio, Sentry) is
NOT sharing, so every answer below is "collected, not shared".

| Play data type | Collected | Optional? | Purpose | Notes |
| --- | --- | --- | --- | --- |
| Personal info → **Email address** | Yes | Required | App functionality, Account management | `users.email`, from Clerk at sign-up |
| Personal info → **User IDs** | Yes | Required | App functionality, Account management | Clerk user id |
| Personal info → **Phone number** | Yes | **Optional** | App functionality | Only if the user opts into SMS alerts |
| Financial info → **Purchase history** | Yes | Required | App functionality | Subscription status + Stripe ids. **Payment info is NOT collected** — Stripe Checkout handles cards; no card data reaches our servers |
| Location → **Approximate location** | Yes | Optional | App functionality | IP-derived to centre a first search. **Processed ephemerally — never stored** |
| Location → **Precise location** | Yes | Optional | App functionality | Only when the user taps "use my location". **Processed ephemerally — never stored** |
| App activity → **Other user-generated content** | Yes | Required | App functionality | The watches themselves: campground + dates + filters |
| App info and performance → **Crash logs** | Yes | Optional | App functionality, Analytics | Sentry, `tracesSampleRate: 0.1` |
| App info and performance → **Diagnostics** | Yes | Optional | App functionality, Analytics | Sentry |
| Device or other IDs → **Device or other IDs** | Yes | Optional | App functionality | FCM push tokens (`push_tokens`), registered by the app |

**Everything else: NOT collected** — name, address, race/ethnicity, political or
religious beliefs, sexual orientation, other personal info, health, fitness, messages,
photos, videos, audio, files, calendar, contacts, in-app search history, installed apps,
web browsing history.

**Security practices section:**

| Question | Answer |
| --- | --- |
| Is data encrypted in transit? | **Yes** (HTTPS throughout) |
| Can users request data deletion? | **Yes** — in-app: Settings → Delete account (`POST /api/user/delete`), which cancels the Stripe subscription, deletes the Clerk user and cascades every user-owned table |
| Data deletion URL | `https://camphawk.app/settings` |
| Committed to Play Families Policy | No — not child-directed |
| Independent security review | No |

> **No advertising or tracking anywhere.** No ad SDK, no ad ID, no data broker, nothing
> joined with third-party data for advertising. Same finding as the Apple labels, and
> the reason App Tracking Transparency does not apply there either.
>
> **Sentry Session Replay is NOT active** and must not be declared. `@sentry/nextjs` v10
> only records with `Sentry.replayIntegration()`, which is not added (verified
> 2026-07-28: zero references). **If anyone ever adds it, this form becomes wrong** —
> replay captures screen contents and would have to be disclosed.

## 5. Content rating

Utility app: no violence, sexual content, profanity, gambling, drugs or user-to-user
communication. Expect **Everyone**; Apple's equivalent rating is 4+. Answer the
questionnaire honestly and it lands there on its own.

The app **does** share the user's approximate/precise location with the developer's own
service to run a search — declare that if asked; it is not the same as sharing location
with other users, which the app never does.

## 6. Target audience

Not directed at children. Target age 18+. The app requires an account and a paid
subscription for its main feature, and camping reservations are made by adults.

## 7. App access — reviewer credentials

Play's **App access** declaration asks whether any functionality is restricted. It is:
searching is free and account-free, but creating a watch needs a signed-in account with
an active subscription, so Play needs demo credentials or the reviewer sees only the
free half.

Declare: **"All or some functionality is restricted"**, then add one instruction set:

| Field | Value |
| --- | --- |
| Name | `Watches (subscription required)` |
| Username | *the demo account email* |
| Password | *the demo account password* |
| Any other instructions | paste the block below |

```
Searching live campsite availability is free and needs no account - open the app and
search any location to see it.

Creating a watch requires a signed-in account with an active subscription. The demo
account above has one. Sign in with email and password (social sign-in is deliberately
hidden inside the app because Google blocks OAuth in embedded webviews).

To see the core feature: New watch -> search a campground -> pick dates -> Start
watching. The app checks that campground every 15 seconds and sends a push, text and
email the moment a site opens.

Subscriptions are purchased on our website, camphawk.app. The app contains no purchase
mechanism and displays no prices - it lets an existing subscriber use what they have
already bought.
```

**Use the SAME demo account as Apple's review notes** (`docs/APP-STORE.md` §2) so there
is one account to keep subscribed, not two to forget about. Fill the credentials in both
places from the password manager; they are deliberately not committed here.

## 8. Closed test — recruiting 12 testers

Testers must **opt in through the Play link with a real Google account and stay opted in
for the full 14 days**. Removing someone mid-window resets progress. Practical notes:

- An email list or a Google Group both work; the Group is easier to manage at 12+.
- Each tester must actually accept the invitation and install from Play at least once.
- Friends and family are acceptable — Play does not require strangers.
- Start the count as early as possible: the 14 days is a floor, not an estimate, and it
  cannot run in parallel with "finish setting up your app".

**Invite message** — the ask is small but the instructions matter, because a tester who
accepts the invite and never installs does not count:

```
I'm putting my camping app on Google Play and need 12 people to install it for two
weeks so Google will let me publish. It's genuinely two minutes of your time.

CampHawk watches campgrounds that are fully booked and texts you the second someone
cancels, so you can grab the site. Searching is free.

What I need:
1. Reply with the Gmail address on your Android phone (it has to be a Google account).
2. I'll send you a link - tap it, tap "Become a tester", then install from the Play
   Store page it gives you.
3. Open it once. That's it. Please leave it installed for two weeks - if you uninstall
   or opt out, it resets my clock.

Android only, sorry - iPhone can't test this one.
```

> **The APK sideloaded onto a phone on 2026-08-01 does not count toward the 12.** Play
> counts opted-in testers who installed through Play, which is why the count reads 0
> despite the app having already run on real hardware.
