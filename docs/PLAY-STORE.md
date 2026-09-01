# CampHawk — Google Play submission reference

Companion to `docs/APP-STORE.md`. Same product, different taxonomy: Play's data-safety
form and listing limits are NOT Apple's, so this file states Play's answers in Play's
words rather than pointing at the Apple ones and hoping.

App record created 2026-08-01. Package `app.camphawk.mobile` (permanent — it matches
`appId` in `capacitor.config.ts` and the AAB Codemagic builds).

---

## 0a. Target API level — API 36 required from 2026-08-31

Google emailed on 2026-08-05: the app targets an old Android version. The rule, from
`developer.android.com/google/play/requirements/target-sdk`:

- **New apps AND app updates must target Android 16 (API 36) or higher from
  2026-08-31.** An extension to **2026-11-01** can be requested in Play Console.
- Existing installs are NOT removed. An app at API 35 stays available to existing users
  and remains discoverable; what you lose is the ability to **ship an update**.

**We were on API 35, and nothing in the repo said so.** `android/` is git-ignored and
regenerated on every Codemagic build (see `capacitor.config.ts`), so the target level
comes from whatever `@capacitor/android` defaults to — v7.6.8 pinned
`compileSdk 35` / `targetSdkVersion 35`.

**Fixed by upgrading Capacitor 7 → 8** (2026-08-05). `@capacitor/android@8.5.0` defaults
to `compileSdk 36` / `targetSdkVersion 36` with AGP 8.13.0 and the same Java 21 the
Android workflow already pins, so no gradle patching was needed. Three things moved
together and all three are required:

| change | why |
| --- | --- |
| every `@capacitor/*` + `@capacitor-firebase/*` → `^8` | `@capacitor/android@8` peers `@capacitor/core@^8.5.0` |
| `firebase` `^11` → `^12.6.0` | `@capacitor-firebase/messaging@8` peers `firebase ^12.6.0` |
| `codemagic.yaml` `node: 20` → `22`, **both workflows** | `@capacitor/cli@8` declares `engines: node >=22`; on node 20 the build dies at `npm ci` before any Capacitor command runs |

**This touches iOS too.** Both workflows share one dependency tree, so the Capacitor
bump reaches the iOS build as well — ship a TestFlight build and check it before the
Play upload, rather than discovering a native regression in review.

**A build now ASSERTS the level** ("Assert the Play target API level" in the Android
workflow) rather than trusting the default. It fails if the generated
`android/variables.gradle` carries a `targetSdkVersion` below 36. Asserted, not pinned:
pinning would freeze us at 36 and this requirement moves every year, while the assert
catches the case that actually hurts — a dependency change silently dropping us below
what Play accepts, discovered months later when an upload is rejected.

---

## 0. The critical path, and why production is ≥14 days out

> **CLEARED — the production application went in on 2026-08-22. See §0c.** Everything below
> is the state as confirmed on 2026-08-01 and is kept for the reasoning, not as current
> status: the heading's "≥14 days out" and the "(0 currently)" tester count are both spent.

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

## 0c. Production access — **GRANTED** (confirmed in console 2026-08-24)

> **GRANTED, and read off the console rather than reported second-hand.** The Dashboard shows
> *"Congratulations! Your app has been granted Google Play production access"*. Production
> itself reads **Inactive** — access is granted, no production release is published yet.
> Closed testing remains **Active, 1 track**; internal testing Active; open testing Inactive.
>
> **WHAT THIS UNBLOCKS:** §1's US-only country setting, which was verified on 2026-08-01 as
> impossible ("You don't have access to production yet", no Countries/regions tab). It is now
> reachable. And **Monetize with Play** is available, so the subscription products can be
> created — see `docs/STOREKIT-PLAN.md` §9.
>
> **AND IT DEFUSES §1's TANGLE RATHER THAN RESOLVING IT.** §1 requires the worldwide closed
> track to be withdrawn before `LINKOUT_BY_STORE.android` may flip. With Play Billing in the
> app there is **no steering UI at all**, so that flag stays `false` permanently and the
> precondition stops being a live decision. Do not withdraw the closed track for its sake.

## 0c-prev. Production access — APPLIED 2026-08-22 (owner-reported)

**The gate in §0 has been cleared and the application is in.** The owner drove the Play
Console; the side-lane session supplied every copyable answer. Recorded here because it was
not, and §0 on its own still reads as though production is a fortnight away.

**So the 12-testers-for-14-days precondition was satisfied** — Play will not accept the
application otherwise, which makes this an inference from the submission being accepted
rather than an observation. **The opt-in dates and the final tester roster were never
written down** and are not recoverable from this repo; the console is the only record.

### The one answer this repo can still substantiate

Play asks **in writing** how you recruited your testers and what feedback you acted on (§8).
The second half is citable:

> `SignOutConfirm` (#162, `8ab87e4`) — Settings confirms before signing out. Its header
> records the provenance in the source: *"raised in the Play closed-test feedback
> (2026-08-22) — signing out happened immediately, with no chance to change your mind."*

That is real tester feedback, dated, with a shipped change against it. It is what makes the
"feedback acted on" answer **true rather than aspirational**, and it is the kind of thing
worth having a commit for if Play asks a follow-up question.

### A GAP, recorded rather than papered over

The session that submitted this **verified the paid tester vendor's answer sheet and found
three of its four claims false.** *Which* claims, and what was written instead, was never
recorded. It is not in this file, the notes file, or any commit — so if Play comes back with
questions, that analysis has to be redone from scratch.

Worth knowing why it matters: §8 already warns that paid tester services are a real risk, and
that the risk is the **recruitment answer**, not the money. An answer sheet supplied by the
vendor being three-quarters wrong is exactly the hazard that section describes, and the
correction is the part that had value.

### What nobody in a session can verify

**No session can read Play Console.** "Submitted" is owner-reported, and the decision arrives
by email to the owner. Do not report a status here that did not come from them — the same
rule `docs/APP-STORE.md` §2d arrived at the hard way, twice.

### What unlocks on approval, and the one thing that must not happen first

- **§1's US-only country restriction becomes settable.** It cannot be set today at all.
- **That restriction is a PRECONDITION for `NATIVE_LINKOUT`**, not a tidy-up. Both stores'
  anti-steering carve-outs are US-storefront only.
- **The closed-test track is WORLDWIDE** (the paid service requires it, §8). Turning
  `NATIVE_LINKOUT` on while that global track is live shows steering UI to non-US testers,
  which is the review failure the flag exists to avoid. `LINKOUT_BY_STORE.android` stays
  `false` until production is live **and** US-only — see CLAUDE.md.

## 0b. Automating the upload — Google Play service account

**LIVE since 2026-08-08.** Every green `android-release` build now uploads itself to Play
**closed testing** (`track: alpha`) — no downloading an AAB and clicking through the
Console. The steps below are kept as the record of how it was set up, and what to redo if
the credential is ever rotated or revoked.

**It cannot be done from a Claude session** — it needs the Google Cloud Console and the
Play Console, and no session has credentials for either. Roughly 15 minutes by hand, once.

**Two different Google consoles, and the naming does not help.**
- **Google Cloud Console** — <https://console.cloud.google.com> — Google's infrastructure
  platform: projects, APIs, and *service accounts*.
- **Play Console** — <https://play.google.com/console> — the app store side.

A **service account** is a robot user. It lives in Cloud, carries a JSON key file instead
of a password, and you invite it into Play Console like a teammate. Hence both consoles:
create the robot in one, grant it access in the other.

**You already have a Cloud project — use it, do not create one.** Firebase projects ARE
Cloud projects, and CampHawk has one for push (FCM). It is listed at
<https://console.firebase.google.com>, and the same project appears in the Cloud Console
project picker. A second project is not wrong, just pointless.

1. **Enable the API** — <https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com>
   → pick the Firebase project in the top bar → **Enable**. *(A separate step from
   creating the account, and the one most often skipped; without it every publish returns
   403 with wording about the caller lacking permission, which reads like a Play Console
   problem and sends you to the wrong console.)*
2. **Create the service account** —
   <https://console.cloud.google.com/iam-admin/serviceaccounts> → **Create service
   account** → any name (`codemagic-publisher`) → **Done**. Skip the "grant this service
   account access to the project" step: no Cloud IAM roles are needed, because the
   permissions that matter are granted in Play.
3. **Make its key** — click the new account → **Keys** → **Add key → Create new key →
   JSON** → it downloads. That file IS the credential: treat it like a password, never
   commit it.
4. **Invite it to Play** — <https://play.google.com/console> → **Users and permissions**
   → **Invite new user** → paste the account's **real** email address.

   **COPY IT, DO NOT TYPE IT FROM THIS DOC.** It ends
   `@<your-actual-project-id>.iam.gserviceaccount.com`, and the project id is specific to
   your Firebase project. It is the `client_email` field inside the JSON from step 3, and
   the Email column at
   <https://console.cloud.google.com/iam-admin/serviceaccounts>.

   > This went wrong on 2026-08-08: a documented EXAMPLE address containing
   > `@your-project.` was pasted in verbatim, so Play invited an account that does not
   > exist. Everything looked configured — a row in Users and permissions with the right
   > boxes ticked — and the publish failed with **"The caller does not have permission"**,
   > which reads like a permissions problem on a real account rather than a fictional one.
   > If you see that error, check the invited address FIRST: it is quicker to rule out
   > than propagation, and Play will happily invite an address that has no owner.
   Grant, on the CampHawk app:
   - **View app information**
   - **Releases → Release to testing tracks**
   - Leave **Release to production** OFF while the closed test is the goal — CI can only
     do what it is authorised to do.
5. **Give it to Codemagic.** This account is a **Personal Account**, which has no Team →
   Integrations page — that route exists only on team plans, so the credential goes in as
   a secure environment variable instead:
   <https://codemagic.io/apps> → campsite-finder → **Settings → Environment variables**
   - **Name:** `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS`
   - **Value:** the ENTIRE contents of the JSON file from step 3, pasted as one line
   - **Group:** `google_play`
   - **Secure:** ticked — without it the value is printed in build logs
   Then add `- google_play` to `environment.groups` in the `android-release` workflow, or
   the variable is not in scope and the publish fails with an empty credential.
6. Uncomment the `publishing:` block at the end of the `android-release` workflow.

**`track: alpha`, NOT `internal`.** Play's tracks are internal / alpha (= CLOSED testing)
/ beta (= open) / production. The 12-testers-for-14-continuous-days requirement in §0
counts CLOSED testing only. Publishing to `internal` satisfies the API-36 upload
requirement, looks like progress, and starts no clock — and you would find out two weeks
later. The commented block was pre-set to `internal` and was corrected 2026-08-08.

**"The caller does not have permission" — check in this order.** The message is the same
for several different causes, and they are not equally likely:
1. **The invited address is wrong** — see the warning in step 4. Costs ten seconds to
   check and was the real cause the first time this was set up.
2. **Permissions have not propagated.** A few minutes is normal after granting; re-run
   the build before changing anything.
3. **The Google Play Android Developer API is not enabled** (step 1) — though this
   usually produces the distinctive *"…has not been used in project X before or it is
   disabled"* instead.

**The credential itself is NOT in doubt when you see this.** A malformed or empty JSON
fails as a parse or auth error; "does not have permission" means Google accepted the
identity and then refused the action, so steps 3 and 5 are already correct.

**The first upload of a package must still be done by hand.** The API cannot create the
very first release for a package that Play has never seen; that only applies once, and
CampHawk is already past it (`app.camphawk.mobile`, last upload 2026-08-04).

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

### 1a. THE REAL PATH, AND WHAT "AFFECTS OTHER TRACKS" MEANS (2026-08-24)

Set, and written down because §1 above spent two wrong guesses on console paths.

```
Test and release -> Production -> Countries / regions -> Add countries / regions
   -> United States -> Add
Publishing overview -> Submit 1 change for review
```

**PRODUCTION HAD ZERO COUNTRIES, so this is an ADD and not a narrowing.** The staged change
reads `Add 1 country / region: United States` with nothing to remove. That is the clean case:
the "add the US first, then remove the others" ordering caution — Play refuses a track at zero
countries — never came up, because there was nothing there.

> **IT APPLIED — CONFIRMED IN THE CONSOLE 2026-09-01.** `Production -> Countries / regions`
> reads **Targeted (1) · United States · ✓ Targeted** ("Includes 7 locations" — the US
> territories, not an over-wide setting). **Nobody recorded the outcome for a week**, so the
> paragraph below stood as the last word and reads as though the change may still be sitting
> unsubmitted. It is not: this is settled, and `LINKOUT_BY_STORE.android`'s first condition is
> met. The reasoning below is kept because it is how the change was made, not as open state.

**IT IS STAGED, NOT APPLIED.** The change lands in *Publishing overview* under **Changes not yet
submitted for review**, behind ~15 minutes of automated quick checks and then a manual
`Submit N changes for review`. A country restriction is not instant and does not apply itself.

**`Affects other tracks` EXPANDS AND NAMES THEM — read it rather than guessing.** The triangle
beside the row opens:

> *The following tracks will be updated because they already share country targeting with
> production:* • **Open testing**

**Open testing ONLY. CLOSED TESTING IS NOT AFFECTED**, so the closed track's worldwide access —
which the paid tester service requires (§8) — survives this change untouched. That was the one
real risk on this screen and the badge does not distinguish it from a harmless one, which is why
the expansion is worth the two seconds. Open testing shares production's country targeting and is
irrelevant here: no open beta is running, and §1's table already records that the setting only
matters if one is.

**`Managed publishing` IS OFF**, so approval puts the change live with no hold-and-release step.
Correct for a country restriction — but it is a property of the whole console, not of this
change, so anything else submitted while it is off also goes live the moment it clears.

**THIS IS ONE OF THREE CONDITIONS ON `LINKOUT_BY_STORE.android`, AND THE OTHER TWO ARE STILL
OPEN** — the closed track's global access must be withdrawn or the track closed, and the app must
actually be live in production. Doing this does not license flipping the flag; see the block
above and CLAUDE.md.

## 2. Listing fields

Play limits differ from Apple's, and Play has **no keywords field** — the full
description is what gets indexed, so the terms have to appear in prose. Nothing below
names a price, for the same reason as the App Store listing: the anti-steering rule
covers the listing, not just the app.

> **Where these actually live in the console** (verified 2026-08-03 — this cost two
> wrong guesses, one of them mine, so it is written down rather than re-derived):
>
> | Thing | Path |
> | --- | --- |
> | The description | **Grow users → Store presence → Store listings → Default store listing → Edit listing** |
> | Government apps declaration | **Monitor and improve → Policy and programs → App content** |
> | Submitting | **Publishing overview → Send changes for review** |
>
> - There is **no "Main store listing" menu item** and no search box. "Store listings"
>   opens a page whose visible call to action is *Create custom listing* — that is a
>   DIFFERENT feature (per-country listing variants). The default listing is further
>   down the same page.
> - **Send changes for review is a manual button.** Saving the listing only stages it;
>   Play first runs ~15 minutes of automated "quick checks", and the banner then reads
>   *"You have changes ready to send for review"* — it does not submit itself.
> - Until anything has published, the whole listing is ONE pending change, so a
>   description edit shows up as `English (United States) – en-US · Default store
>   listing` rather than as its own row. That is the row to look for on Publishing
>   overview; if no Store listings section appears at all, the edit did not save.
> - **The Government apps declaration must read "your app is not a government app"** and
>   agree with the description's disclaimer. Answering yes puts you on the same footing
>   as an appeal: Play then wants written proof of government authorization. Confirmed
>   correct 2026-08-03.

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
| Personal info → **User IDs** | Yes | Required | App functionality, Account management | Clerk user id. Also sent to **RevenueCat** as the App User ID (`purchases.ts:120`) — the webhook keys on `app_user_id` |
| Personal info → **Phone number** | Yes | **Optional** | App functionality | Only if the user opts into SMS alerts |
| Financial info → **Purchase history** | Yes | Required | App functionality | Subscription status + the billing processor's ids: Stripe ids for a web purchase, `provider` + `store_transaction_id` for a **Play purchase via RevenueCat** (migration 071) — a store purchase never touches Stripe. **Payment info is NOT collected** — Google Play and Stripe Checkout each handle cards; none reaches our servers |
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

> **THE TWO ROWS ARE CORRECTED (2026-08-30). THE "SHARED" ANSWER IS THE OPEN QUESTION AND IT
> IS DELIBERATELY LEFT OPEN.** *User IDs* and *Purchase history* now name RevenueCat and no
> longer claim Stripe handles a Play purchase — it does not; those land as
> `store_transaction_id` + `provider` (migration 071).
>
> **WHAT IS NOT DECIDED: whether either row stays "collected, not shared".** This section's own
> rule at the top says a processor acting on our behalf is not sharing. RevenueCat reads as a
> billing processor by that rule — but it is a distinct third party receiving a user identifier,
> and **answering this wrong is a Data-safety violation, not a listing nit.**
> - **Do not copy the Stripe answer across on the assumption they are alike.** Stripe is reached
>   server-to-server from our own backend; RevenueCat is an SDK **inside the app** that is handed
>   the user id on the device, which is the fact pattern Play's definition turns on.
> - **It could not be checked from the agent session that wrote this**: `support.google.com` and
>   `play.google` are outside this environment's egress allowlist (both returned `000` on
>   2026-08-24, re-confirmed 08-30). **Read Play's current definition in the console before the
>   next submission.**
>
> **THIS IS THE MORE URGENT OF THE TWO STORE FORMS.** Play's four products are LIVE and a real
> purchase has been made through them (2026-08-30); Apple's do not exist yet.
>
> The same correction is applied in `docs/APP-STORE.md` §1 — in both, deliberately, because a
> correction applied to one copy is not applied.

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
- **The paid service needs `testers-community@googlegroups.com` on the track AND the
  track set to worldwide.** Country targeting is PER TRACK in Play, so a global closed
  test does not conflict with a US-only production release — see the linkout warning in
  CLAUDE.md for the one thing that must not be done while the global track is live.
- Each tester must actually accept the invitation and install from Play at least once.
- Friends and family are acceptable — Play does not require strangers.
- **PAID TESTER SERVICES ARE A REAL RISK, and the risk is not the money.** A service was
  bought for this app on 2026-08-08 (testerscommunity.com), with the plan of using 12 of
  theirs plus real people. Two things to know: when you apply for production access Play
  asks **in writing** how you recruited your testers and what feedback you acted on, and
  the 12/14 requirement exists specifically to filter out apps that cannot find twelve
  real users. Rejections and reset windows are widely reported when a test looks
  inauthentic — reported experience, not a rule quotable from policy. **The mitigation is
  the real testers, so weight the list toward people you actually know**: they are what
  makes the recruitment answer truthful and give you feedback worth describing.
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
