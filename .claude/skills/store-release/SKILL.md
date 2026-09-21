---
name: store-release
description: Shipping CampHawk to the App Store and Google Play — the five Apple rejections and what each actually cost, the demo-account pre-check that must run immediately before every submission, the RevenueCat/StoreKit/Play Billing chain, and the submission mechanics that are one-shot or irreversible. Use when preparing or diagnosing a store submission, a rejection letter, in-app purchase, `scripts/app-review-precheck.mts`, `REVENUECAT_SANDBOX_USER_IDS`, the RevenueCat webhook, `src/lib/store-plans.ts`, `LINKOUT_BY_STORE`, or anything in App Store Connect, Play Console or RevenueCat's console.
---

# Store release — Apple, Play, and the purchase chain

**Read this before touching a submission.** Five Apple rejections, five distinct causes, and
**three of the five were the artefact being right while the thing handed to the reviewer was
wrong.** That is the failure mode of this whole surface: the fix ships, production is correct,
and the reviewer cannot see it.

## LANE OWNERSHIP — check before you write

`docs/APP-STORE.md`, `docs/PLAY-STORE.md` and `docs/STOREKIT-PLAN.md` are the **SIDE lane's**
files (assigned 2026-09-10; `docs/LANES.md` is the authority). So is everything done in a
vendor console and `src/components/v2/StorePaywall.tsx`.

**The MAIN lane keeps `src/lib/**` regardless of topic** — `src/lib/native/purchases.ts`,
`src/lib/store-plans.ts`, the RevenueCat webhook — because that is release-critical server
code, and because `src/lib/auth.ts` and `src/lib/limits.ts` are in `worker-deploy.yml`'s
`paths:`, **so a change there restarts all three pollers.** A lane that does not own the
poller must not be the one to bounce it. Read `worker-deploy.yml`'s `paths:` rather than
recalling it.

If you are in the main lane and find something in those three docs stale, **name it, do not
edit it.**

## WHAT A SESSION CANNOT DO — measured, not assumed

| host | from a session | consequence |
|---|---|---|
| App Store Connect | no API access at all | **nobody here can read a rejection letter, a version state or the review notes** |
| `api.codemagic.io` | **403 at the agent proxy** | iOS/Android builds are the owner's, even though `CODEMAGIC_API_TOKEN` is set |
| `api.clerk.com` | **`connect_rejected`** (org policy) | the demo password cannot be verified from here |
| `www.apple.com` | **`connect_rejected`** | the standard EULA URL cannot be fetched — take it from the letter's own hyperlink |
| `developer.apple.com` | 200, and **serves its "Page Not Found" with HTTP 200** | grep the body for `Page Not Found`; a status check is a false positive |

**`CODEMAGIC_API_TOKEN` being set is not reachability.** Same false positive as `GITHUB_TOKEN`
answering `/user` with a 200 — the natural check passes and the natural conclusion is wrong.

Apple's help pages under `developer.apple.com/help/app-store-connect/**` **are** reachable and
have twice settled a console question in two fetches. **Read them rather than describing the
UI from a model of it.**

## THE FIVE APPLE REJECTIONS — none is a recurrence

| # | date | guideline | cause | what it cost |
|---|---|---|---|---|
| 1 | 08-14 | 2.1 | **the demo password in Sign-In Information was wrong**, and Clerk Device Trust emailed a code to a mailbox the reviewer also could not reach | §5 had verified the field was POPULATED, never that its contents WORK |
| 2 | 08-16 | 2.1 | information needed | — |
| 3 | 08-19 | 3.1.1 | no IAP at all | 3.1.3(b) was read as a defence; it **restates the demand** |
| 4 | 08-22 | 3.1.1 again, same build | **the link-out was live in production and the demo account was a SUBSCRIBER, so every purchase surface was gated `!subscribed` and the reviewer could not see it** | a whole review cycle on a fix that had shipped |
| 5 | 09-15 | 3.1.2 | the description carried **no Terms of Use (EULA) link** | automated pre-check; no human opened the app |

**#3's guideline reading is the one to keep.** 3.1.3(b) permits honouring content bought
elsewhere *"provided those items are also available as in-app purchases within the app"* — the
**"also"** is the requirement. 3.1.3(a) **Reader** is the no-IAP carve-out and its enumerated
list (magazines, books, audio, video, cloud storage, professional databases) does not cover a
campsite alerting service. **"The app has no purchase mechanism at all" was never a defence; it
was the FINDING.**

**#5 was not a regression.** The Terms/EULA requirement is a property of OFFERING
auto-renewable subscriptions, and the four products became part of a submission for the first
time on 09-14. Five rejections, five causes.

**Three of the five (#1, #4, #5) were adjudicated by an automated pre-check or died at the
sign-in screen.** The IAP flow, the demo account and the replacement review notes have been
un-reviewed by a human for several consecutive submissions.

## THE PRE-CHECK IS A RITUAL, AND IT IS NOT OPTIONAL

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/app-review-precheck.mts <the-Sign-In-email>
```

**PASS THE EMAIL EXPLICITLY.** `DEFAULT_EMAIL` in that script is
`tylerflores1992@yahoo.com` — the **OLD** demo account, which is `active base stripe
grandfathered` and reads NOT CLEAN **for a reason that must never be "fixed"**: that is a real
paying subscription, and deleting it to pass a check is worse than the check failing.

**RUN IT IMMEDIATELY BEFORE EACH SUBMISSION. NEVER QUOTE A PREVIOUS RUN.** On 2026-09-20 the
demo account held an Apple row again, five days after a session recorded it deleted and read
back CLEAN. The mechanism was never established — the row's `created_at` predated the recorded
delete, which fits neither a clean re-insert nor the delete having taken — and the evidence was
destroyed by deleting it again before the discrepancy was noticed. **What is robust whatever
the cause: a previous session's read-back is not evidence about today.**

**WHY A SUBSCRIBER DEMO ACCOUNT IS FATAL.** Every purchase surface gates on `!subscribed` —
Settings, `PricingSection`, Explore, `WatchCta`, `NewWatch` — which is **"a subscriber is never
sold to" working exactly as designed**. A reviewer signing in with a subscribed account reaches
no paywall and no way to buy, which is the 3.1.1 citation, with the fix live.

**SIGNING OUT NO LONGER ROUTES AROUND IT.** `docs/APP-STORE.md` §2d's numbered sign-out steps
were written when `WatchCta`'s `isNative` branch sat above its `!signedIn` branch and revealed
the LINK-OUT. That is false of the **paywall**: `SubscribeCta` returns at `gate === "signedOut"`
**above** the `canSell` branch, so `StorePlansLink` is unreachable signed out, and `WatchCta`
signed-out renders `SUBSCRIBE_HREF` (the web steer) rather than `/pricing`. **`/pricing` is
reachable only when signed in AND not subscribed.** Following §2d today walks the reviewer to a
screen with no purchase option.

The script asks the real `hasActiveSubscription`, never a copy — **`is_beta` short-circuits
before any subscription row is read**, so a re-implementation would have to know that and would
be the copy that drifts. It names WHICH of the two causes fired, because only one of them is a
row you can delete.

**A previous version of this check hardcoded a Clerk id and was pointed at the SANDBOX TEST
account.** It reported CLEAN while the real Sign-In account held a live grandfathered
subscription. **A check that names its subject by an id nobody re-reads can be pointed at the
wrong thing and go on passing.**

## `REVENUECAT_SANDBOX_USER_IDS` — clear it AFTER APPROVAL, never before

App Review's own purchases run in **SANDBOX**, and `ignoreReason` drops every non-PRODUCTION
event unless the buyer is allow-listed. **Cleared before review, the reviewer's purchase
succeeds at StoreKit and unlocks nothing** — its own rejection, and indistinguishable from a
real bug.

So the allowlist must contain the **Sign-In account's Clerk id through review**. The pre-check
prints that id for exactly this comparison; nothing in a session can read the Vercel value.

**An env change does not reach already-deployed functions — it needs a redeploy.**

`src/lib/revenuecat.ts` says *"CLEAR … ONCE THE APP IS APPROVED"*. **Approved, not submitted.**
Earlier advice to clear it before review was framed around our own testing polluting the demo
account — a real hazard, and a different one, whose remedy causes this.

## THE PURCHASE CHAIN — proven on both stores, and it had never once worked

```
paywall -> RevenueCat -> POST /api/webhooks/revenuecat -> subscriptions row -> hasActiveSubscription
```

**23 deliveries in a row returned 401, back to 2026-08-31**, on both stores, and RevenueCat's
delivery log — the instrument nobody had opened — read `Failure` for every one. Three separate
things then had to be true at once and none had ever been exercised:

1. the sandbox allowlist reaching a **deployed** function,
2. the auth fix letting the event past the 401,
3. `ON CONFLICT (provider, store_transaction_id) WHERE store_transaction_id IS NOT NULL` —
   **`ON CONFLICT` will not infer a PARTIAL index**, so without the predicate the statement
   raises 42P10 and is **unrunnable on every input**, which is exactly why it survived review.

**Proven Apple 2026-09-15** (`provider=apple`, and a plan change four minutes later tracked on
the same row because Apple keeps `original_transaction_id` stable inside a subscription group).
**Proven Play in production 2026-09-19** (`provider=google`, `tier=autocart`, a real stranger's
purchase).

**Reading a failure here:**
- `Failure` in RevenueCat's log with a sandbox event = **the 401**, by exhaustion: `ignoreReason`
  drops before any DB call, `verifyHmac` is length-guarded and cannot throw, a parse failure
  returns 200. There is exactly one non-2xx path.
- **`X-Clerk-Auth-Message: Invalid JWT form` is on EVERY response from this route and is a red
  herring** — `/api/webhooks/(.*)` is in `isPublicRoute`, so Clerk annotates and passes through.
  It sends readers into `middleware.ts`, where nothing is wrong.
- An empty 500 with `Content-Length: 0` was an unhandled throw. The write is guarded now and
  returns `{error:'write failed'}` — **still a 500**, because RevenueCat's six retries are worth
  having (they re-delivered the event after the fix with no repurchase). **The DB message is
  logged and never returned**: `sqlit` interpolates rather than binds.
- **Date the reading against the deploy.** Seven deliveries were once diagnosed as "the env var
  is not live" when the build serving them **predated the feature entirely**. Response headers
  carry `Date:`; git carries the merge time.
- Use a **`TEST`-type event** to probe auth: `ignoreReason`'s first line drops it, so it
  exercises the whole auth path and writes nothing.

**Two gaps remain open and are MAIN's:** HMAC is **reported, not enforced**, and **out-of-order
delivery is unhandled** (needs a migration, i.e. main's block).

## A WEB DEPLOY CANNOT ADD PURCHASE CAPABILITY

`capacitor.config.ts` points `server.url` at the live site, so nearly everything reaches
installed apps on a push. **Buying is the exception** — the purchase crosses the Capacitor
bridge, so it arrives only in a BUILD.

- **Gate the paywall on the PLUGIN, not the platform.** `isNative` is a User-Agent marker: it
  says the shell is CampHawk, not that it can buy anything. Gated on `isNative` alone, every app
  installed before the release shows a Buy button that throws.
- **A missing plugin is `unknown`, never "cannot buy"** — the same rule a failed entitlement
  lookup follows one layer down.
- `bringUp` returning `{ok:false}` renders the paywall's `unavailable` fallback, and **four
  different causes produce that one screen**: no plugin in the build, a missing API key, a
  non-US storefront, and an empty offering. It still builds, ships and passes review.

## THREE FLAGS, AND THEY ARE NOT COMPLEMENTS

`STORE_PURCHASE_ENABLED`, `IN_APP_PURCHASE_BY_STORE` and `LINKOUT_BY_STORE` are three different
switches. **`IN_APP_PURCHASE_BY_STORE` is deliberately NOT the complement of
`LINKOUT_BY_STORE`** — US rules let an app do both, so iOS carries the paywall AND keeps the
link-out. Deriving one from the other reads tidier and is wrong about the future.

**`LINKOUT_BY_STORE` is `{ios: true, android: false}` and android stays false until Play
PRODUCTION is live and US-only.** Both anti-steering carve-outs are **US-storefront only**, the
Play closed test was **worldwide** (the paid tester service requires it), and a single shared
boolean would have fixed Apple by showing steering UI to non-US Play testers — the failure
introduced BY the fix for the other store. **Store check, never a country check**; device locale
is not a storefront.

**A KNOWN INCONSISTENCY, NAMED BEFORE IT BITES:** on iOS a signed-in non-subscriber gets two
different answers depending on where they tap — `SubscribeCta` (on `/new`) routes to `/pricing`
and the StoreKit paywall; `WatchCta` (on a campground page) opens camphawk.app in Safari. Both
are legal on the US storefront. **A reviewer's instinct is the campground page.** If a round
comes back on 3.1.1 again, `LINKOUT_BY_STORE.ios = false` is the next lever — one boolean,
web-side, no rebuild.

## SUBMISSION MECHANICS — one-shot and irreversible controls

- **The first IAPs an app ships must be reviewed alongside an app VERSION.** "Add for Review" on
  the Subscriptions page puts them in a **separate draft** that App Store Connect will not let
  you submit (*"add an app version for the selected platform"*), while the only version is
  locked inside another submission. **Chicken-and-egg by construction.**
- **The tell is `Items Submitted (N)`.** A rejection page carries its own items, so "Resubmit to
  App Review" there re-sends **that submission and nothing else**.
- **`Cancel Submission`** is at the **bottom left** of the submission page. The version lands on
  **Developer Rejected** — not a deletion: build, metadata, screenshots, review notes and
  Sign-In credentials all persist, and the message thread spans submissions. **The only cost is
  queue position** (measured once at twenty-four minutes).
- **On a version already attached to a submission the control is `Update Review`, top right of
  the version page** — Apple's help calls it `Add for Review`. **Match on POSITION, not the
  label.** Saving metadata does **not** resolve the rejected item; only this does.
- **`Update Review` IS A ONE-SHOT**: *"you can edit items in a submission only once before
  resubmission."* Everything must be right before it is pressed; a greyed-out `Save` is the check
  that the edit committed.
- **NEVER PRESS `Remove`**: *"removed items cannot be added back to the same submission"* — that
  strands a subscription outside the submission permanently.
- **The ACTION column that offers Remove disappears once a submission is *Waiting for Review***,
  so the control everyone looks for is gone precisely when it is wanted.
- **The character counter reads REMAINING, not used.** 4,000 − 286 = 3,714. A number two orders
  of magnitude below the expected one is the most re-pasteable false alarm available — state the
  expected REMAINING figure.
- **Metadata is editable on a Rejected version**, which is what makes a text-only fix cheap.

## BUILD IDENTITY — match on UPLOAD DATE, never the number

**`PROJECT_BUILD_NUMBER` in `codemagic.yaml` is PROJECT-WIDE, shared with the Android
workflow** — proven by `android-release` **run 8** producing versionCode **16**. "TestFlight
#12" in the notes is the **Codemagic run** number, not ASC's build number. `codemagic.yaml`
asserted the opposite in two comments until 2026-09-01.

**RevenueCat entered the tree at `8818544`, 2026-08-29.** Any iOS build older than that contains
no StoreKit at all and the paywall renders `unavailable` — **visually identical to a healthy
pre-IAP build.** The previously-submitted `1.0 (5)` is from 08-22 and predates it.

**Read the attached build's UPLOAD DATE in the console, and install it before submitting.**
Build 27 had **zero installs** when it was attached; build 21 (three weeks older, pre-RevenueCat)
carried all the real usage. A paywall screenshot proves nothing about the build a reviewer gets.

## PRICES AND COMMISSION

Store prices are deliberately **above** the web's, to absorb commission:

| | web | store |
|---|---|---|
| Alerts monthly | $2.50 | **$2.99** |
| Alerts yearly | $20 | **$23.99** |
| Auto-Cart monthly | $10 | **$11.99** |
| Auto-Cart yearly | $50 | **$59.99** |

**Apple's Small Business Program was APPROVED 2026-09-14 at 15%**, and the products were already
priced on the 15% column. At 30%, Auto-Cart yearly would be **$71.99** — above Campsite
Tonight's $59.99, forfeiting the positioning that tier exists for.

**AND THE PREMISE WAS BACKWARDS, WHICH IS WHY IAP IS NOT A GRUDGING CONCESSION.** At these
amounts Stripe's flat **$0.30** costs more than a 15% commission: store billing nets **+$0.41 /
+$1.27 / +$0.78 / +$2.74** per plan. **Stripe's fixed fee is an effective 14.9% on $2.50.**

**SBP was always the commission RATE, never the ability to create products.** Paid Applications
has been ACTIVE since 2026-08-25 (`docs/STOREKIT-PLAN.md` §6.1 is the authority for Apple's
gates — do not re-derive them).

## PLAY

- **Production release 25 went in 2026-08-22** and the 12-testers-for-14-days precondition was
  met (inferred from the submission being accepted, not observed — the opt-in dates were never
  recorded).
- **Read `Publishing overview` for "has this shipped?"** — not the Dashboard, not the app list,
  and **not `Production -> Track summary`**, which read `Active · Latest release: 25` over an
  UNSUBMITTED release and produced a confident, wrong "we are live".
- **Data safety is ANSWERED**: RevenueCat is a **service provider** under Google's own exemption
  list, so the *User IDs* and *Purchase history* rows stay *collected, not shared* and nothing on
  that form changed. "Nothing changed" is the correct outcome, not an omission.
- **Android developer verification is DONE** — registered, three keys, all Verified, updated
  2026-08-01, a month before the reminder email. The Sep 30 2026 deadline never applied.
  **Two mechanisms share that date and they are not the same deadline:** *registration* is
  global and its consequence is removal from Play; *install-time enforcement* is BR/ID/SG/TH
  only until 2027. Quote the row, not the date.
- **`android-release` uploads itself** on a green build via the `google_play` env group.
- **Play has no subscription groups**, so the proration trap in `docs/STOREKIT-PLAN.md` §9a has
  no console safety net there. Apple does.

## GUARDS THAT EXIST BECAUSE NOTHING ELSE CAN SEE THIS

- **`src/lib/store-listing.test.mts`** — the store descriptions are plain text that `tsc`,
  `next build` and the whole suite are **structurally unable to see** (one grep: nothing in the
  repo referenced the description at all). It asserts a labelled **functional** link for both
  agreements, the 4,000-character cap on both listings, and that `docs/APP-STORE.md` §6's
  self-described *"verbatim copy"* really is verbatim — the description exists twice and only
  one copy was enforced.
- **`src/lib/platform-parity.test.mts`** — every iOS/Android branch needs a one-line reason; a
  new one fails the build, a stale registry entry fails too, and the RC path is separately
  asserted branch-free.
- **`codemagic.yaml`** asserts the RevenueCat pod in the **Podfile and the LOCK file**, the
  InAppBrowser plugin at `ios/capacitor-cordova-ios-plugins`, the Play target API level, and the
  Play Billing permission in the merged manifest. **Never widen a pod/plugin grep to
  `grep -r ios/`** — `ios/App/App/public` contains our own web bundle, which carries the literal
  strings, so a whole-tree grep passes with the pod entirely absent. **An assertion that cannot
  fail is worse than none: it reads as proof.**

## PROHIBITIONS

- **Never clear `REVENUECAT_SANDBOX_USER_IDS` before approval.**
- **Never delete a Stripe subscription row to make the pre-check pass.** Check WHICH account.
- **Never quote a previous session's pre-check result.**
- **Never press `Remove` on a submission item.**
- **Never set `LINKOUT_BY_STORE.android = true` while a worldwide Play track is live.**
- **Never upload the `camphawk.app/terms` page as a custom EULA** — its Subscriptions section
  says billing is "through Stripe", which is false for a store purchase, and a custom agreement
  puts that sentence one click from the product page. The description links **Apple's standard
  EULA** instead. (The terms page itself is stale on this point; recorded, not fixed.)
- **Never re-derive Apple's account gates from prose.** `docs/STOREKIT-PLAN.md` §6.1 is the
  authority.

## THE OPEN RISK NOBODY HAS TESTED

3.1.2 also wants **title, length, price and functional Privacy/Terms links in the BINARY**, at
the point of purchase. `StorePaywall` renders the tier name, the store's own `priceString` and
`/month`|`/year`; `/pricing` is inside the `(app)` route group whose footer carries Terms and
Privacy. **All five are on the screen by layout rather than by design, the footer's Terms points
at our own terms rather than the EULA now cited in the description, and nothing guards any of
it.** It is the plausible next rejection — and it is the web layer of an already-attached build,
so a push fixes it with no rebuild. **The Play description was deliberately NOT given the same
links: Google has never cited this and there is no evidence to encode.**
