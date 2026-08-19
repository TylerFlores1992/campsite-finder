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

## 0. App Store Connect — the app id and the links worth bookmarking

**Apple app id: `6794772605`.** Not a secret — it is the number in every public App Store
URL — and it was missing from the entire repo until 2026-08-19, which meant every trip to
App Store Connect started by clicking through the app list.

| what | link |
|---|---|
| App list | https://appstoreconnect.apple.com/apps |
| This app | https://appstoreconnect.apple.com/apps/6794772605 |
| Version in flight | https://appstoreconnect.apple.com/apps/6794772605/distribution/ios/version/inflight |
| Availability (countries) | https://appstoreconnect.apple.com/apps/6794772605/distribution/availability |
| Pricing | https://appstoreconnect.apple.com/apps/6794772605/distribution/pricing |
| Public store page | https://apps.apple.com/us/app/id6794772605 |

**Availability is APP-level, not version-level** — a sibling of `/distribution/ios/…`, not
under it. That matters because the US-only setting is the whole precondition for the
link-out in §2c, and looking for it on the version page finds nothing.

Apple has renamed these routes more than once; the first two are stable, the rest are
best-effort. If one 404s, the setting has not moved — the path has.

## 2c. REJECTED 2026-08-19 — Guideline 3.1.1, In-App Purchase

**The reviewer finally got INTO the app, and this is the rejection the plan always expected.**
`1.0 (5)`, reviewed 19 Aug on an iPad Air 11-inch (M3). Apple:

> The app accesses digital content purchased outside the app, such as subscriptions, but
> that content isn't available to purchase using In-App Purchase.

**They are factually right and there is nothing to dispute.** Signed in as the demo account —
a paying, grandfathered subscriber — the app delivers watches and alerts that were bought on
the web. A non-subscriber, meanwhile, reads *"Subscriptions are managed at camphawk.app"*
with **no link, no price and no way to act.** A dead end, which is exactly the complaint.

### THE REMEDY IS IN APPLE'S OWN LETTER, TWO PARAGRAPHS ABOVE "Next Steps"

> Apps on the United States storefront may link out to the default browser, using buttons,
> external links, or other calls to action, for payment mechanisms other than in-app purchase.

That is `NATIVE_LINKOUT`, built and dark since 2026-07-27 for precisely this. **Web-side, so
it reaches the build already under review** — no rebuild, no new binary, and the version is
already Rejected so the queue position is spent either way.

### THE TRAP IN THE ONE-LINE FIX, AND WHY IT IS TWO FLAGS NOW

The flag is shared by both native apps and **the two do not have the same availability**:

| | availability | steering |
|---|---|---|
| iOS | United States only (ASC, 2026-07-30) | **on** |
| Android | closed test, **worldwide** — the paid tester service requires it | **off** |

Both anti-steering carve-outs are US-storefront only, so flipping one boolean would have
fixed Apple **by showing steering UI to non-US Play testers** — the review failure
`nativeSubscribe.tsx`'s own header warns about, introduced BY the fix for the other store.
`LINKOUT_BY_STORE` is per store now, and **`android` stays false until Play PRODUCTION is
live and US-only**. The closed test is not the exception.

**It is a STORE check, not a COUNTRY check.** A CampHawk iOS build can only have come from
the App Store, so device OS names the store exactly. Country is handled the only way it
safely can be — by ASC availability being US-only, so every iOS install is a US storefront by
construction. Device locale would not do that job.

### WHAT IS NOT CERTAIN, AND SHOULD NOT BE WRITTEN UP AS IF IT WERE

Apple's "Next Steps" paragraph still says the content *"must be available for purchase in the
app using In-App Purchase"*. That is older boilerplate sitting directly above their own
link-out allowance, and the two do not agree. **Whether a link-out ALONE clears 3.1.1 for a
service like this, with no IAP at all, is not established.** Post-injunction a number of US
subscription apps operate that way; that is a pattern, not a guarantee.

**3.1.3(b) IS NOT THE DEFENCE, and CLAUDE.md said it was.** That entry read *"the rejection to
argue rather than code around is 3.1.3(b) — the app has no purchase mechanism at all, which is
the whole defence."* Read the guideline: 3.1.3(b) Multiplatform allows access to content
acquired elsewhere **"provided those items are also available as in-app purchases within the
app"** — the very requirement being complained about. It does not excuse us, it restates the
demand. The no-IAP carve-out is 3.1.3(a) Reader apps, whose enumerated list (magazines, books,
audio, video, cloud storage, professional databases) does not include a campsite alerting
service. **Having no purchase mechanism was never a defence; it was the finding.**

The genuine allowance is the US link-out one, and nothing else.

### If Apple insists on IAP anyway

The fallback is StoreKit: weeks of native work, a new build, a new review, and 15–30%
commission on every subscription. That is why the free option goes first — a round trip costs
days, and being wrong about it costs only those days.

### Resolution Center reply

Paste as-is. It concedes the finding, points at their own allowance, and states the storefront
precondition so the reviewer does not have to go looking for it.

> Thank you for the review.
>
> We have addressed this. CampHawk now presents a clear call to action inside the app, on
> every surface where a subscription is required, linking out to the default browser to
> complete payment at camphawk.app.
>
> We are relying on the allowance stated in your message: apps on the United States storefront
> may link out to the default browser, using buttons, external links, or other calls to
> action, for payment mechanisms other than in-app purchase. **CampHawk's App Store
> availability is restricted to the United States storefront only**, so every install falls
> within that allowance.
>
> The change is server-side and is already live, so it is present in the build currently under
> review — no new binary is required.
>
> For context on what the app is: CampHawk monitors campground reservation systems and alerts
> subscribers within seconds when a booking is cancelled. The subscription is a service that
> runs on our servers continuously, independently of the app; the app is one of several ways a
> subscriber reads their alerts, alongside email, SMS and the web.
>
> If you would prefer us to implement In-App Purchase instead, please let us know and we will
> plan that work — we would appreciate confirmation, as it requires a new build.

**Before sending, confirm in App Store Connect that availability is still United States only.**
If it is not, this reply is wrong and the change is a worse rejection than the one it answers.

## 2b. REJECTED 2026-08-16 — Guideline 2.1, Information Needed (New App Submission)

**A different 2.1 from §2a, and a much cheaper one.** Nothing is broken and nothing is
disputed: Apple's standard new-app information request, asking for a screen recording plus
six written answers. `1.0 (5)` is marked Rejected; Submission ID `243b36c7-27a1-42e8-9f1a-
7f19d98a6ed2`, submitted Aug 16 10:23 AM, answered by Apple the same evening.

**The sign-in complaint from §2a is ABSENT — but do not read that as proof it is fixed.**
This letter is Apple's templated new-app request and its "Next Steps" list is boilerplate,
so it is equally consistent with a reviewer who never got as far as signing in. What IS
established is that the demo password verifies against Clerk (200) and that the owner
confirmed a clean sign-in from a private window on a device that had never touched the
account. See §21 of `docs/NOTES-claude-side-lane-setup-f7bpe2.md`.

### Only item 1 needs a human

Apple asks for seven things. Six are writing and are drafted below. The first is a **screen
recording on a physical device running the latest iOS** — nobody can produce that from a
web session, and it is the long pole.

**What the recording must contain**, from Apple's own list, in order:

1. **Launch the app** — the recording has to begin here, not mid-flow.
2. **Search without an account** — this is the free tier and the best thing to lead with.
3. **Sign in** with the demo account (registration/login is explicitly named).
4. **Create a watch** — the core paid feature.
5. **The push permission prompt**, which appears right after the first watch. Apple names
   "any prompts requesting access to sensitive data or device capabilities", so it must be
   on camera.
6. **The location prompt** — tap "near me". Same reason.
7. **Settings → Delete account**, and complete it. Named explicitly. **Do this last**, and
   on a throwaway account rather than the demo one, or the demo credentials in Sign-In
   Information stop working and §2a repeats itself.

**There are no purchase or subscription flows to film, and that is the point.** The app has
no purchase mechanism at all — that is the 3.1.3(b) position in §2. Filming a subscribe
button would contradict the defence. If a non-subscriber state is shown, it should be the
"Subscriptions are managed at camphawk.app" copy.

**No user-generated content either** — nothing is authored, shared, or visible to another
user, so there is nothing to report or block.

### The six written answers

Paste into the Resolution Center reply, and add a condensed form to the **Notes** field —
Apple asks for it there "for future submissions", and the existing Notes block in §2 (the
3.1.3(b) business-model paragraph) **must be kept**; it is what prevents the predictable
rejection.

```
2. DEVICES AND OS TESTED
iPhone SE (3rd generation), iOS 26.6 — a physical device. This is the device
the attached screen recording was captured on.

3. WHAT THE APP DOES AND WHO IT IS FOR
CampHawk watches campgrounds that are already fully booked and alerts the user
within seconds of a cancellation, so they can take the site before anyone else.

The problem: popular campgrounds sell out months ahead, cancellations are common,
and they are re-booked within minutes. Refreshing a reservation website by hand is
the only alternative.

Target audience: campers in the United States, particularly families and RV owners
planning trips at high-demand state and federal campgrounds.

Searching live availability across 8,035 campgrounds is free and needs no account.
Watching a campground and receiving alerts is the paid feature.

4. HOW TO SET UP AND REACH THE MAIN FEATURES
No setup is required to search.

  Search (free, no account): open the app, type a place name or tap "near me",
  and pick dates. Results show live availability.

  Sign in: credentials are in the Sign-In Information fields of this submission.
  Email and password. Social sign-in is deliberately hidden in the app because
  Google blocks OAuth inside embedded webviews, so no third-party login is
  offered and Sign in with Apple is not applicable.

  Create a watch (paid): open a campground, choose dates, and save the watch. The
  demo account has an active subscription, so this works immediately.

  Alerts: when a site opens, the watch sends an email, a push notification and a
  text message. Push permission is requested only after the first watch exists,
  because before that there is nothing to notify about.

  Delete the account: Settings tab, "Delete account" at the bottom. It removes the
  account and all of its data and cancels any subscription immediately.

5. EXTERNAL SERVICES USED
  Authentication ......... Clerk
  Payments ............... Stripe (on our website only; no purchase in the app)
  Database ............... Supabase (PostgreSQL)
  Push notifications ..... Firebase Cloud Messaging
  Text messages .......... Twilio
  Maps and geocoding ..... Mapbox, and OpenStreetMap for place names
  Error monitoring ....... Sentry
  Hosting ................ Vercel (website and API), Fly.io (background worker)

  Campground and availability data comes from the reservation systems themselves:
  Recreation.gov and the federal Recreation Information Database (RIDB),
  ReserveCalifornia and the other UseDirect state park portals, ReserveAmerica,
  GoingToCamp, and individual state park systems. Every source, the states it
  covers, and its official URL are listed publicly at
  https://camphawk.app/sources, which is reachable without an account and is
  linked from the app's footer.

  No AI service is used.

6. REGIONAL DIFFERENCES
  None. The app behaves identically everywhere it is available. Availability is
  restricted to the United States storefront, and the campground catalog covers
  United States campgrounds only.

7. REGULATED INDUSTRY OR PROTECTED MATERIAL
  Neither applies. CampHawk is not in a regulated industry and includes no
  protected third-party material.

  The campground information is public government data, read from the official
  reservation systems and open-data APIs listed above — the federal RIDB is a
  public open-data API. We publish the official source, the states it covers and
  a working link for every one of them at https://camphawk.app/sources.

  CampHawk does not create campground or availability information. It reads what
  those official systems publish and shows it unchanged, and every reservation,
  payment and cancellation happens on the official site under that agency's
  terms, not ours.

  That same page opens by stating, in its own heading, that CampHawk is not a
  government app: it is an independent app that does not represent any government
  entity and is not affiliated with, endorsed by, or authorized by Recreation.gov,
  the National Park Service, the U.S. Forest Service, the Bureau of Land
  Management, the U.S. Army Corps of Engineers, or any state park agency. The
  same disclaimer opens and closes the App Store description.
```

### RESUBMITTED 2026-08-17 — what was actually sent

- **`CampHawk-AppReview.mp4`, 2:56**, attached in Resolution Center. Covers every flow
  Apple named: launch, guest search, location prompt, sign-in, push prompt, watch
  creation, watch management, registration, the free-account "managed at camphawk.app"
  state, and account deletion through to sign-out.
- **Notes field REPLACED** with a 3,997-character condensed version (see below).
- **Reply** carried a timestamp index of the recording plus the full items 2–7.
- **Build `1.0 (5)` untouched** — no rebuild, so the queue position was not spent.

#### iOS DOES NOT RECORD PRIVACY PERMISSION ALERTS — this cost three takes

Apple asks for the permission prompts on camera. **An iOS screen recording cannot capture
them.** The alert is drawn by a separate system process; the recording captures only the
app's own window **dimming behind it**, leaving a dim-in / hold / dim-out with an empty
overlay. Measured at 15fps: brightness falls over ~6 frames, holds ~10, recovers — and
nothing is ever drawn on top.

**Two wrong diagnoses came first, and both were plausible.** First that the permission had
already been granted (it had, on the earliest take — but a reinstall did not fix it).
Second that the app had been opened once after reinstalling, consuming the prompt. **The
owner was right and both were wrong:** the prompt fires correctly and is redacted from the
capture. The tell is the dimming with no dialog — a real "already granted" case has *no
dimming at all*, which is exactly how the two takes differ.

**The fix is a second camera** pointed at the device. That footage also happens to be the
strongest possible evidence for "captured on a physical device". Say so in the reply, or
the image quality change mid-video reads as a doctored recording.

#### Two edits the footage needed

- **The location alert's map shows the tester's home neighbourhood** — named streets and a
  named elementary school, legible at full resolution. Blurred. The blur box had to be
  positioned twice: the first attempt clipped *"campgrounds near you."*, which is the
  purpose string Apple most wants to read.
- **A Mail inbox showing our own monitoring email** — *"CampHawk health check: overall
  status DEGRADED"* — appeared during the email-verification step. Cut. It was flagged in
  one clip and then found in a **different** one during a spot-check of the joined file,
  which is the argument for verifying the output rather than the plan.

#### THE NOTES FIELD CAPS AT 4,000 CHARACTERS

The existing notes are ~1,992 and the six new answers ~2,100, so **appending them as-is
overflows**. The delivered block is 3,997 — the 3.1.3(b) paragraph kept essentially
verbatim, wording tightened elsewhere. **Three characters of headroom: re-count before
saving any edit to that field.**

### Why item 7 is worth answering carefully rather than briefly

**Google Play rejected this app on exactly that point** (2026-08-03, Misleading Claims): an
app showing government information must cite an official, functional source in the listing
and carry a visible non-affiliation disclaimer. The fix built for Play — `/sources`,
`src/lib/data-sources.ts`, and the disclaimer opening and closing both store descriptions —
is the documentation Apple is asking for here, already live and already public.

**`/sources` must stay in `isPublicRoute`.** A reviewer opens it signed out, and Clerk's
`auth.protect()` returns 404 rather than 401 — so a regression there would answer Apple's
question with a dead link.

### Cost

**No new build.** Every one of these is a Resolution Center reply plus a text field.
`1.0 (5)` stays attached, and swapping the build is the one edit that would cost the queue
slot.

---

## 2a. REJECTED 2026-08-14 — Guideline 2.1, the reviewer could not sign in

Submission `243b36c7-27e1-42e8-9ffa-7f19d98a6ed2`, reviewed 2026-08-13 on an iPhone 17
Pro Max. Apple's words: *"We were unable to sign in with the following demo account
credentials … Unable to sign in (and Yahoo Mail). Please provide a new instruction."*

**Nothing about the business model was raised.** The 3.1.3(b) notes in §2 were never
tested, because the app was never opened. Leave them exactly as they are.

### The two causes

**1. The password in Sign-In Information does not work.** Proven, not inferred — Clerk's
backend API answers `422 incorrect_password` for the string Apple quoted:

```
NODE_USE_ENV_PROXY=1 npx tsx - <<'EOF'
const H = { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json' };
const [u] = await (await fetch(
  'https://api.clerk.com/v1/users?email_address=tylerflores1992%40yahoo.com',
  { headers: H })).json();
const v = await fetch(`https://api.clerk.com/v1/users/${u.id}/verify_password`,
  { method: 'POST', headers: H, body: JSON.stringify({ password: process.env.DEMO_PW }) });
console.log(v.status, v.ok ? 'CORRECT' : await v.text());
EOF
```

> **Run that before every submission.** §5 recorded the credentials as "VERIFIED DONE
> 2026-08-08" on the strength of the field being *populated*. Populated is not correct,
> and the difference cost the whole review cycle. This is the same failure as verifying
> the site-mute write and never the read.

**2. Clerk Device Trust challenges every new device.** Previously "Client Trust"; the
status is still `needs_client_trust` in `@clerk/shared`. Per Clerk's docs it triggers when
*"the user enters a valid password"*, has not enabled MFA, and is *"signing in from a new
device"* — so it fires for an App Review device 100% of the time. It sends a six-digit
code to the account's email; the reviewer has no access to that inbox and said so.

The demo account is `password_enabled=true`, `two_factor_enabled=false`, `totp_enabled=false`
— exactly the shape Device Trust applies to. It does **not** apply to passwordless
sign-ins, which is no help here: every passwordless route also needs the inbox.

### The fix — configuration only, no rebuild

1. **Clerk Dashboard → Protect → Rules → Device Trust → Manage → toggle off Enable → Save.**
   Instance-wide; Clerk documents no per-user exemption.
2. **Reset the demo account password** and paste the real one into the version's
   *App Review Information → Sign-In Information*. Then re-run the check above and confirm
   it prints `CORRECT`.
3. **Sign in once from a private window** on a device that has never touched the account,
   and confirm no code is asked for. That is the actual reviewer experience; the API check
   only covers cause 1.
4. Reply in Resolution Center (text below), then **Resubmit to App Review**.

**The same build is fine.** The version is already Rejected, so the queue position is
spent — there is nothing left to protect by avoiding a resubmit, and equally no reason to
attach a new binary. `src/` does not change. ITMS-90683 remains a warning, not a blocker.

**Cost of turning Device Trust off:** all accounts lose the new-device email check on
password sign-in. Accepted — no card data is reachable in-app (Stripe holds it), and a
second rejection costs more. The alternative that keeps it on is TOTP on the demo account
plus backup codes pasted into the notes; rejected as more steps in front of a reviewer who
has already failed once. **Switching it back on after approval re-breaks the next review.**

### Resolution Center reply

Send only after steps 1–3 are actually done — the second paragraph is a claim about the
world, and a reviewer who hits a code prompt anyway will reject again and trust nothing.

```
Hello,

Thank you for the review, and apologies for the trouble signing in. You were right
that the credentials did not work. There were two separate problems and both are now
fixed:

1. The password in the Sign-In Information field was incorrect. It has been corrected,
   and we have confirmed the new password signs in successfully.

2. Our authentication provider was sending a one-time verification code by email on the
   first sign-in from an unrecognized device. Your review device is new to this account,
   so that challenge appeared every time, and the code was delivered to the account's
   email inbox, which you do not have access to. We have turned that new-device challenge
   off. Signing in now requires only the username and password — no verification code,
   and no access to the email inbox.

The corrected credentials are in the Sign-In Information fields for this version:

  User name: tylerflores1992@yahoo.com
  Password:  <paste the new password here>

This account has an active subscription, so all functionality is available, including
creating campground watches and receiving alerts. Searching campgrounds is free and
works without signing in at all.

If anything still blocks you, please reply here and we will respond immediately.

Thank you,
Tyler Flores
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

> **SUPERSEDED 2026-08-14: the version was REJECTED under Guideline 2.1** — the reviewer
> could not sign in with the demo account. Everything below about protecting the queue
> position is now moot (the position is spent), and the "editable in place" reasoning
> applies to the resubmit rather than to a waiting version. **Read §2a first.**

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
- ~~Fill the demo account password~~ — **THIS "VERIFIED DONE 2026-08-08" WAS WRONG, and it
  is what got the app rejected on 2026-08-14.** What was checked is that Sign-in required
  is ticked, that a username and password are *present*, and that the notes field holds
  1,992 characters. **Nothing checked that the password WORKS** — Clerk answers
  `422 incorrect_password` for it. See §2a for the one-command check that settles it, and
  run that instead of eyeballing the field. §2's `<fill in>` is still not the defect.
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
