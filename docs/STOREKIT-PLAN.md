# StoreKit — implementation plan

*Written 2026-08-24 (side lane) on the owner's decision to add In-App Purchase and raise prices
to absorb Apple's commission. This is the design and the arithmetic; it is **not** an
implementation. Read "What only a human can do" before planning a session around it.*

---

## STATE AS OF 2026-08-28 — read this first

**PLAY'S CONSOLE WORK IS FINISHED. Every remaining blocker on both stores is CODE or a vendor.**

| | Done | Waiting on the vendor | Blocked on us |
|---|---|---|---|
| **Apple** | W-9 active | Bank details + Paid Applications agreement processing | Small Business Program enrolment (§6.1), then the four products (§8) |
| **Play** | merchant account · account group · **15% enrolled** · US-only · bank verified · **billing permission shipped** · **4 base plans + 4 offers ACTIVE** | — **nothing** | — **nothing in the console** |

**WHAT CLEARED PLAY, 2026-08-28.** `@revenuecat/purchases-capacitor` 13.4.2 went into
`package.json`, and **two Codemagic builds in order** settled §9a-ter's unread transitive chain:

```
build 12  cbeb709  no billing dep   FAILED at the assertion (CHECKED=3)   aab 11.07 MB
build 13  6c04a93  + RevenueCat     green, published                      aab 13.36 MB
```

Run 1 was the diagnostic — it proved the gate could fail before anything trusted it, and it
failed on the *answer* rather than on being unable to read. Run 2 grew the binary **+2.3 MB**
with `package.json` as the only change, which is `com.android.billingclient:billing` arriving by
AAR manifest merge — the hop that `maven.google.com` being 403 at the proxy made unreadable from
any session. **The Codemagic runner was the only instrument that could answer it, and it did.**

**THE PRODUCTS ARE LIVE** (§9b), all **Active**, all **United States**:

```
camphawk_base      monthly  Monthly, auto-renewing  + intro-free-week
                   yearly   Yearly,  auto-renewing  + intro-free-week
camphawk_autocart  monthly  Monthly, auto-renewing  + intro-free-week
                   yearly   Yearly,  auto-renewing  + intro-free-week
```

**ONE THING UNVERIFIED, AND IT IS THE ONLY ONE:** the four **prices** were never read back from
the console — the base-plan list shows duration and region but no amount. §9b wants $2.99 /
$23.99 / $11.99 / $59.99. `Countries / regions: United States` proves *a* price exists, not that
it is the right one. **Open each base plan and read the amount** before anything charges anybody.

**EVERYTHING LEFT ON PLAY IS CODE**, and all of it is **main-lane** (`src/lib/`,
`src/lib/db/migrations/`): the §2 migration, the §5 webhook (**with the grace-period split** —
`BILLING_ISSUE` is two states and only account hold revokes access), the product-id → tier
mapping, and the §11a paywall that must detect the **plugin**, not the platform.

**THE §9a PRORATION TRAP IS NOW THE EXPENSIVE ONE.** Play has no subscription groups, so
upgrade-vs-downgrade is stated by app code. No console screen can show that mistake, and every
console screen that *could* have caught anything has now been passed.

**iOS HAS NOT BEEN BUILT SINCE REVENUECAT ENTERED THE DEPENDENCY TREE.** §11c: Capacitor 8
defaults iOS to SPM, where `@capacitor/app` and `@capacitor-firebase/app` already collided on
identity `app` once and broke resolution outright. A new plugin is a new identity in that
namespace. **Run `iOS · TestFlight` on this branch** rather than discovering it when a TestFlight
build is needed for something else.

**TWO THINGS TO CARRY FORWARD RATHER THAN RE-DERIVE:**

1. **§10b — store billing nets MORE than Stripe on every plan.** Stripe's effective rate on a
   $2.50 charge is 14.9% against the stores' 15%. The "profit stolen by Apple" framing that
   started this plan is arithmetically wrong at these price points; do not re-derive a worse
   answer from the 15% figure alone.
2. **§9a — Play has no subscription groups**, so upgrade-vs-downgrade is stated by *app code*
   via the proration mode. No console screen can show that mistake, and it is the one that
   charges somebody twice.

---

## Why this exists

`docs/APP-STORE.md` §2c and §2d record three rejections, all circling Guideline **3.1.1**. §2d's
closing line: *"A rejection now is the real answer and moves the decision to StoreKit — weeks of
native work, a new build, and 15-30%."* That decision has been taken.

**The link-out is not being removed.** Both are permitted on the US storefront post-*Epic*, and
`LINKOUT_BY_STORE.ios` already ships. IAP is additive: it satisfies 3.1.1 outright instead of
resting on an allowance whose scope Apple's own letter and its boilerplate disagree about.

---

## 1. The pricing arithmetic

**Current, and what each nets today** (Stripe ~2.9% + $0.30, so a $2.50 charge nets ~$2.13 —
worth remembering before treating Apple's cut as uniquely bad on the small monthly plan):

| plan | now |
|---|---|
| Base monthly | $2.50 |
| Base yearly | $20 |
| Auto-Cart monthly | $10 |
| Auto-Cart yearly | $50 |

**Apple's commission is 15%, not 30% — but only if you enrol.** The Small Business Program is
15% for developers under $1M/yr proceeds. Enrolment is manual, annual, and in App Store Connect.
**Without enrolling it is 30% for year one** on subscriptions, dropping to 15% after a subscriber
completes a year.

To hold current net revenue, at real Apple price points:

| plan | @ 15% (Small Business) | nets | @ 30% (not enrolled) | nets |
|---|---|---|---|---|
| Base monthly | **$2.99** | $2.54 | $3.99 | $2.79 |
| Base yearly | **$23.99** | $20.39 | $28.99 | $20.29 |
| Auto-Cart monthly | **$11.99** | $10.19 | $14.99 | $10.49 |
| Auto-Cart yearly | **$59.99** | $50.99 | $71.99 | $50.39 |

**RECOMMENDATION: enrol in the Small Business Program first, then price the 15% column.** The
30% column pushes Auto-Cart yearly to $71.99, which is above Campsite Tonight's $59.99 — and
undercutting them is the positioning CLAUDE.md records for the whole Auto-Cart tier. Enrolling is
a form; not enrolling costs the product's price advantage.

**Web prices stay where they are.** Charging web users more to subsidise Apple's cut would raise
the price for the majority to fund the minority. Two price lists is the honest structure, and it
is what the store rules contemplate.

---

## 2. The schema — and the one thing that makes this cheap

`subscriptions` today:

```
id · user_id · stripe_customer_id · stripe_subscription_id · status · tier · grandfathered
```

**It is Stripe-shaped.** An Apple subscription has no customer id and no subscription id in that
sense; its identity is the **`originalTransactionId`**, stable across renewals.

**THE ENTITLEMENT QUERY NEEDS NO CHANGE AT ALL, AND THAT IS THE FIND.** `hasAutocartEntitlement`
reads only `status`, `tier` and `grandfathered`:

```sql
EXISTS (SELECT 1 FROM subscriptions s
         WHERE s.user_id = $1 AND s.status IN ('active','trialing')
           AND (s.tier = 'autocart' OR s.grandfathered))
```

It is already provider-agnostic. So **the one definition with six enforcers keeps working
untouched** — the toggle API, the bot roster feed, `isAutocartLane`, the RC hold offer and the
hold action all inherit Apple subscribers for free, as long as an Apple purchase writes a row
with the right `status` and `tier`.

**Proposed migration** (main lane's number to claim):

```sql
ALTER TABLE subscriptions
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'stripe',      -- 'stripe' | 'apple'
  ADD COLUMN apple_original_transaction_id TEXT,
  ALTER COLUMN stripe_customer_id DROP NOT NULL,           -- if currently NOT NULL
  ALTER COLUMN stripe_subscription_id DROP NOT NULL;

CREATE UNIQUE INDEX subscriptions_apple_otid
  ON subscriptions (apple_original_transaction_id)
  WHERE apple_original_transaction_id IS NOT NULL;
```

`DEFAULT 'stripe'` backfills the three live rows correctly and changes nothing for them. The
partial unique index is what stops one Apple subscription being claimed by two accounts.

**Do NOT drop the Stripe columns.** Web keeps selling through Stripe; this is additive.

---

## 3. Client — which plugin

No IAP plugin is installed today (Capacitor 8; `@capacitor/*` plus `cordova-plugin-inappbrowser`).

| | pros | cons |
|---|---|---|
| **RevenueCat** `@revenuecat/purchases-capacitor` | Owns receipt validation, App Store Server Notifications, renewals, refunds, Play parity. **Free under $2,500/mo revenue** — nowhere near. One webhook to us. | A third party owns billing truth. Another vendor in the stack. |
| `@capacitor-community/in-app-purchases` | No vendor. | **You build and operate receipt validation, ASSN v2 handling, renewal and refund reconciliation yourself** — the half where the bugs live. |

> **DECIDED 2026-08-24: RevenueCat.** The owner chose it when the question was put with both
> costs stated. §11e's "do not pick one by starting to install it" is discharged — installing it
> is now the instruction.
>
> **AND `@capacitor-community/in-app-purchases` DOES NOT EXIST.** `npm view` answers **E404**.
> The row above was written from memory and names a package that has never been published, so
> the "no vendor" column was never a real option. The genuine alternative is
> **`cordova-plugin-purchase`** (13.18.0) — which runs through Capacitor as a Cordova plugin,
> the same mechanism `cordova-plugin-inappbrowser` already uses here, declares
> `com.android.vending.BILLING` directly in its `plugin.xml`, states no Capacitor 8 support, and
> whose own docs push you to a paid third party (Iaptic) to avoid building receipt validation.
> **A comparison table is not evidence that both rows exist.**
>
> Verified at decision time: `@revenuecat/purchases-capacitor` **13.4.2**, published
> **2026-08-25**, `peerDependencies: { "@capacitor/core": ">=8.0.0" }` against this repo's
> `^8.5.0`.
>
> **UNVERIFIED, AND THE BUILD MUST SETTLE IT:** that the plugin actually contributes
> `com.android.vending.BILLING` to the merged manifest. That permission is the *entire* gate
> (§9a-bis), and "the SDK brings it" is an inference, not a reading. **Add an assertion to
> `android-release` for the merged manifest**, beside the three it already carries — the same
> discipline as asserting targetSdk rather than trusting Capacitor's default.

**RECOMMENDATION: RevenueCat.** This repo's history is a catalogue of what happens when a
one-person team operates infrastructure it cannot observe — a leaking mini-PC, a bot whose
liveness beacon was stamped by the wrong process, `status='sent'` meaning only "Twilio returned
2xx". Receipt validation is exactly that class of work: silent when broken, and the failure mode
is *a paying customer losing entitlement*. Buy the boring part.

If the vendor dependency is unacceptable, the fallback is the App Store Server API directly, and
the plan below still applies — only §5 grows substantially.

---

## 4. What must not break

- **A subscriber is never sold to.** Five surfaces gate on `!subscribed`; the IAP paywall must
  gate the same way. `docs/APP-STORE.md` §2d records that this rule is *why* the reviewer could
  not see the link-out — so whatever ships must be visible to a **signed-out** reviewer too.
- **Grandfathering.** Migration 032 set `grandfathered = true` on every pre-tier row and the
  webhook never writes it. An Apple path must never write it either.
- **Unknown ≠ not subscribed.** `useSubscription`'s `unknown` state must keep meaning "don't
  nag". A failed StoreKit lookup is `unknown`, never "not subscribed" — otherwise a network blip
  shows a paying customer a paywall.
- **Restore Purchases is mandatory**, both by guideline and because a reinstall otherwise looks
  like a lapsed subscription.
- **One account, one subscription.** A user who subscribed on web and then buys in-app must not
  end up double-billed. The partial unique index stops the Apple side duplicating; the client
  must check existing entitlement before offering to buy.

---

## 4a. REVENUECAT'S OWN WIRING IS NOT IN THIS PLAN, AND IT IS NOT SMALL (2026-08-28)

§3 chose RevenueCat and §5 describes the webhook it will send us. **Nothing here describes
setting RevenueCat up**, and it sits between "the products exist" and "anything can be bought":

1. **A RevenueCat project**, with the Android app registered against `app.camphawk.mobile`.
2. **A Google Play service-account credential given to RevenueCat**, so it can read purchase
   and subscription state. **This is probably NOT the Codemagic publisher account** — that one
   is deliberately scoped to *View app information* + *Release to testing tracks* (`PLAY-STORE`
   §0b), and reading subscription state is a different permission. **Whether to widen that
   account or add a second is unresolved**, and the answer should be read off Play's permission
   screen rather than inferred. A second account is the safer default: §0b's credential is
   rotated for CI reasons that have nothing to do with billing.
3. **Products mapped to entitlements** — the four Play ids on one side, and whatever
   `hasAutocartEntitlement` needs on the other. This is where §9a's tier decision becomes data.
4. **The public SDK key** in the app, which is a build-time value in a **remote-webview** app —
   so re-read §11a before deciding where it lives.

**None of it is blocked; none of it is written down.** Recorded when it was noticed rather than
discovered as a surprise between working products and a paywall that cannot talk to them.

### 4b-progress. WHERE THE CONSOLE ACTUALLY GOT TO (2026-08-28)

```
[x] 1. Project created — named CampHawk, platform Capacitor
[ ] 2. Google Play app  app.camphawk.mobile     <- RESUME HERE
[ ] 3. Cloud service account `revenuecat-billing` + JSON key
[ ] 4. Play Console invite + permissions
[ ] 5. Upload the JSON to RevenueCat
[ ] 6-9. products · entitlements · webhook · Vercel env vars
    !  Email address not yet confirmed — RevenueCat gates actions on it.
```

**PLATFORM IS `Capacitor`, AND THE FIELD IS LABELLED "CATEGORY" IN PLACES.** The list is
frameworks (Native Apple / Native Android / Web / Flutter / React Native / Unity / Kotlin
Multiplatform / Capacitor), it is **multi-select**, and only Capacitor is correct:

- **Not Native Apple or Native Android** — Capacitor covers both through the one plugin, which
  is the one already in `package.json`. Ticking them buys setup docs for SDKs we do not use.
- **NOT `Web`, and this is the one that could cause real trouble.** "Web" means RevenueCat's own
  web billing. **CampHawk's web subscriptions go through Stripe, which is not in RevenueCat at
  all**, so ticking it invites a second payment path competing with the one that is live and
  selling. The remote webview does not change this: the UI is remote, the purchase is native
  Play Billing over the bridge (§11a).

**THE ONBOARDING WIZARD MUST BE SKIPPED — "Go to dashboard", not "Continue".** It offers a
"suggested" setup *"based on our data"*, and two of its three suggestions are wrong for this
product:

- **A `Lifetime` One-Time Purchase that does not exist.** We sell four auto-renewing
  subscriptions and nothing else.
- **A SINGLE entitlement, "CampHawk Pro".** One yes/no cannot express two tiers, and
  `hasAutocartEntitlement` exists precisely to distinguish them.
- Its ids are RevenueCat placeholders (`monthly`, `yearly`), not Play's.

**And the deeper reason: the Play app is not connected yet**, so RevenueCat cannot see the real
products and anything the wizard creates is a placeholder to clean up later.

**DO NOT PRESS "Mark all as done" ON THE DASHBOARD CHECKLIST.** It hides the list and configures
nothing — a dashboard reading 6 of 6 over a project with no app, no credential and no products.
That is this file's own recurring shape, offered as a button: **a screen that looks finished is
not a finished screen.**

**ENTITLEMENTS, WHEN STEP 7 ARRIVES — two, not one:**

| entitlement | granted by |
|---|---|
| `alerts` | **all four** products — an Auto-Cart subscriber gets alerts too |
| `autocart` | the two `camphawk_autocart` products only |

That mirrors the two questions the app actually asks (`hasActiveSubscription` and
`hasAutocartEntitlement`). Tier still comes from the product id per §5; these are RevenueCat's
bookkeeping, never a second source of truth.

### 4d. THE CONSOLE WORK IS COMPLETE (2026-08-29)

```
Valid credentials      ✓
Connected to Google    ✓  projects/camp-501802/topics/revenuecat-notifications
Last received          ✓  2026-08-29 17:49 UTC   (Play's own test notification)
Products               ✓  four, imported, Published
Entitlements           ✓  alerts (all four) · autocart (the two autocart products)
Webhook                ✓  camphawk.app/api/webhooks/revenuecat, HMAC signing ON
```

**RTDN NEEDED A PLAY-SIDE STEP THAT NOTHING ELSE MENTIONS.** RevenueCat's *"Connect to
Google"* only wires THEIR half. Play must separately be told to publish, at
**Play Console → Monetize with Play → Monetization setup → Real-time developer
notifications**: tick **Enable real-time notifications** (it is off, and the Topic name field
is inert until it is on), paste the topic, and set Notification content to *"Subscriptions,
voided purchases, and all one-time products"* — it defaults to subscriptions-only.

**AND THE TOPIC NEEDS `google-play-developer-notifications@system.gserviceaccount.com` AS
`Pub/Sub Publisher`.** Without it Play's test reports *"Test notification couldn't be sent"*
and names three possible causes at once, and a REAL notification would simply never arrive —
no error anywhere, just a topic nobody publishes to. **Play's own test is the only thing that
distinguishes a working RTDN from a silent one**, so send it rather than assuming.

**WHAT FIXED THE CREDENTIAL IS NOT KNOWN, AND SHOULD NOT BE GUESSED.** Four things changed
before `Valid credentials` appeared — account-level Play permissions, the two Cloud IAM roles,
the two APIs, and a regenerated key — inside a documented 24-36h propagation window. The honest
record is "these four, in that window". Crediting one is the mistake this file has made three
times.

**`Track new purchases from server-to-server notifications` IS DELIBERATELY OFF.** RevenueCat
ignores purchases the SDK has not posted, which is what we want: enabling it brings in their
App User ID detection rules, and their own docs warn the SDK's `obfuscatedExternalAccountId`
can then *"cause unintended overwrites"*. We bind `app_user_id` to the Clerk id, so off keeps
one identity story. Turn it on only if a real purchase is ever observed going missing.

**STILL OPEN AND NOT BLOCKING: Play's `Pause` is ENABLED and nothing handles it.** Subscription
settings → Pause. It lets a subscriber suspend billing for weeks; `SUBSCRIPTION_PAUSED` is not
in the webhook's granting set and what Play reports as the expiry for a paused subscription is
**unverified**, so the entitlement outcome would be decided by accident either way. Either
disable it or handle the state deliberately — it is one more state next to grace periods,
account holds, trials and proration.

### 4b. The RevenueCat console checklist — WRITTEN BLIND, so verify as you go

**`revenuecat.com`, `docs.revenuecat.com` and `api.revenuecat.com` are ALL 403 at the agent
proxy's CONNECT** (checked 2026-08-28), same as `maven.google.com` and `docs.codemagic.io`. So
the steps below are **from general knowledge, not read off their documentation**, and this
file's own §29d rule applies harder than usual: *a screen that looks finished is not a finished
screen*. Where a step says **CONFIRM**, read the console and correct this list.

1. **Project + Android app.** Package name `app.camphawk.mobile` — it must match, or RevenueCat
   validates purchases against an app that does not exist.
2. **The Play service-account credential. ANSWERED 2026-08-28 — REVENUECAT NAMES THEM ITSELF.**
   Its `Debug error` dialog checks **three capabilities separately** and prints the fix:

   ```
   ✗ Can validate Google Play subscription purchases
       Tip: Grant this service account app access plus "View financial data, orders, and
       cancellation survey response" and "Manage orders and subscriptions"
   ✓ Can read the Google Play in-app product catalog
   ✓ Can read the Google Play subscription catalog and base plans
   ```

   **So the set is: App access → `View app information (read-only)`, plus Financial data →
   `View financial data` AND `Manage orders and subscriptions`.** Read off the console, not
   recalled. Play's own description of `View financial data` is the corroboration — it says in
   as many words *"…access the **Purchases API**…"*, which is how a purchase is validated.

   **THE THREE-WAY BREAKDOWN IS THE USEFUL PART, AND IT IS BETTER THAN OUR OWN DIAGNOSTICS.**
   Two greens with one red proved, without any guessing, that the JSON was valid, the invite
   had landed and app access had saved — leaving exactly one cause. A single "we were unable to
   validate your credentials" banner would have been the four-causes-one-message shape this
   repo keeps paying for. **Always open `Debug error` rather than re-uploading the key.**

   **NOTHING RELEASE-RELATED, AND THAT IS THE POINT OF THE SECOND ACCOUNT.**
   `codemagic-publisher` can ship builds and cannot see money; `revenuecat-billing` can see
   money and cannot ship builds. Do NOT tick `Manage store presence` — its own description
   includes *"edit pricing; manage in-app products"*, i.e. WRITE access to the four products,
   which RevenueCat only ever needs to read.

2b. **(superseded) CONFIRM THE PERMISSIONS ON PLAY'S OWN SCREEN.**
   RevenueCat needs to read subscription and purchase state, which is **not** what the Codemagic
   publisher account is scoped to (*View app information* + *Release to testing tracks*,
   `PLAY-STORE` §0b). **Add a SECOND service account rather than widening that one** — §0b's
   credential gets rotated for CI reasons that have nothing to do with billing, and a rotation
   that silently breaks entitlement lookups is the kind of failure this repo keeps paying for.
   RevenueCat's own onboarding names the permissions it wants; take them from there, not here.
3. **The four products. ANSWERED 2026-08-28 — IMPORT, NEVER TYPE.** RevenueCat's importer found
   all four and states the rule on the screen: *"RevenueCat will import selected products with
   an identifier formatted as `<product_id>:<base_plan_id>`, and will use that identifier to
   refer to it in the dashboard."*

   ```
   camphawk_base:monthly        Active
   camphawk_base:yearly         Active
   camphawk_autocart:monthly    Active
   camphawk_autocart:yearly     Active
   ```

   **USE `Import`, NOT `+ New`.** Import pulls the ids straight from Play, so the string
   arrives exactly as Google has it and the retyping risk disappears rather than being
   carefully avoided.

   **THE TIER MAPPING FOR §5 FOLLOWS, AND KEEPS THE SAFE FAILURE DIRECTION.** Split on the
   FIRST colon and read the part before it: `camphawk_autocart` → `'autocart'`, **everything
   else → `'base'`** — including anything unrecognised. That mirrors `tierForPriceId`, whose
   rule is that an unknown id fails as *"paying but treated as base"*, never as silent free
   premium. Do not enumerate all four ids: an exhaustive list silently mis-tiers a fifth
   product added later, where a prefix test degrades to `base` and stays honest.

### 4b-corrections. THREE THINGS IN §4b WERE WRONG — from RevenueCat's own guide (2026-08-28)

The owner pasted RevenueCat's *"Step-by-step guide for creating your Play service credentials"*,
which this session could not reach (all three of their hosts are 403 at the agent proxy). It
contradicts three instructions given above. **Their doc wins; §4b was written blind and said so.**

| §4b said | The guide says |
|---|---|
| skip the Cloud grant-access step, **no IAM roles needed** | grant **`Pub/Sub Editor`** and **`Monitoring Viewer`** |
| **do not** tick `Manage store presence` | it is one of **four required** permissions |
| grant under **App** permissions | App permissions to *add the app*, then the four under **Account permissions** |

**THE ACCOUNT-LEVEL SCOPE IS THE LIKELY CAUSE OF THE FAILING CHECK.** The app-level grant made
both catalog reads pass and left `Can validate Google Play subscription purchases` red.

**ALSO REQUIRED IN CLOUD:** enable `pubsub.googleapis.com` and
`playdeveloperreporting.googleapis.com` (`androidpublisher` was already on from `PLAY-STORE`
§0b). **After changing IAM roles, REGENERATE the JSON key** — their error table says so
explicitly, and re-uploading is cheap next to a day spent on a credential.

**THE 36-HOUR WINDOW IS DOCUMENTED, AND IT REFRAMES THE RED BANNER.** *"It can take up to 36
hours for your Play Service Credentials to work properly."* A red validation minutes after
granting is the **stated normal**, not a fault — so the instinct to widen permissions until it
goes green is chasing a clock.

**AND THERE IS A DOCUMENTED WORKAROUND WORTH KNOWING:** in Play Console →
Monetize → Products → Subscriptions, **change any product's description and save**. Their guide
says this activates new credentials *"right away (or very shortly)"*. Revert afterwards.

**ON `Manage store presence`, THE OBJECTION IN §4b STANDS ON THE MERITS** — Play's own
description includes *"edit pricing; manage in-app products"*, which is WRITE access to the four
products. It is granted because the vendor requires it, not because it is minimal. Worth
knowing if the permission is ever audited: it is their requirement, not our choice.

3b. **(superseded) CONFIRM THE ID FORM.** Play identifies a purchasable thing as the
   subscription *and* its base plan, so the id RevenueCat wants is expected to look like
   `camphawk_base:monthly` rather than `camphawk_base`. **This is the single most likely place
   to mistype something that then silently matches nothing.** Whatever form the console shows is
   the form `§5`'s product-id → tier mapping must use — copy it, do not retype it.
4. **Entitlements.** RevenueCat wants them; **our tier is still derived from the product id**
   per §5, so entitlements are RevenueCat's bookkeeping and not a second source of truth.
   Two definitions of who is entitled is the failure `hasAutocartEntitlement` exists to prevent.
5. **The webhook** → `/api/webhooks/revenuecat`, with an Authorization value RevenueCat sends
   and the route verifies. **Fails CLOSED**, and the route must be added to `isPublicRoute` in
   `src/middleware.ts` or Clerk answers 404 — `/api/webhooks/twilio` is the working precedent
   for both halves.
6. **The public Android SDK key.**

**AND STEP 6 IS BETTER THAN §11a FEARED.** `Purchases.configure({ apiKey })` is called from
**JavaScript**, and this app is a remote webview serving its JS from camphawk.app — so the key
is a web-side env var and **reaches installed apps on a `git push`**, with no release. What
still needs a release is the *plugin*, which is already in the binary as of build 13. So the
SDK key is not a build-time value here, and §11a's "a web deploy cannot add purchase capability"
is about the plugin specifically, not about its configuration.

---

## 4c. THE REAL WEBHOOK PAYLOAD, READ OFF A TEST EVENT (2026-08-28)

Captured from RevenueCat's own `Send test event`, so the field names below are **read, not
recalled**. Response was 404 — the route does not exist yet, which is correct.

```jsonc
{
  "api_version": "1.0",
  "event": {                              // <- NESTED. The event is not at the top level.
    "type": "TEST",                       // INITIAL_PURCHASE | RENEWAL | CANCELLATION | ...
    "id": "072FA074-BE5B-4722-9983-...",  // event UUID
    "environment": "SANDBOX",             // or PRODUCTION
    "app_user_id": "63o43cb0-...",        // OUR Clerk user id, once the SDK sets it
    "original_app_user_id": "63o43cb0-...",
    "product_id": "test_product",         // real: camphawk_base:monthly
    "store": "APP_STORE",                 // or PLAY_STORE
    "period_type": "NORMAL",              // or TRIAL / INTRO
    "original_transaction_id": null,      // -> subscriptions.store_transaction_id
    "transaction_id": null,
    "expiration_at_ms": 1787982006612,
    "purchased_at_ms": 1787982006612,
    "entitlement_ids": null,
    "subscriber_attributes": { "$email": { "value": "..." }, ... }
  }
}
```

**FOUR THINGS THAT CHANGE THE ROUTE, none of which I would have written from memory:**

1. **`environment` CAN BE `SANDBOX`, AND THE PRODUCTION WEBHOOK RECEIVES IT.** The integration
   is configured for *Both Production and Sandbox* — deliberately, so test purchases are
   visible. **A sandbox event must never grant a real entitlement**, or anyone with a test
   device mints themselves a paid subscription. This is the single most dangerous field in the
   payload and it is easy not to notice, because it is `SANDBOX` in the only sample anyone
   looks at.
2. **`type: "TEST"` EXISTS** and carries `product_id: "test_product"` with a `app_user_id` that
   matches no real user. It must be acknowledged **200 and ignored** — 200 because a non-2xx
   makes RevenueCat retry a message that will never be processable.
3. **`period_type: "TRIAL"` IS HOW THE FREE WEEK ARRIVES.** It maps to our `status =
   'trialing'`, which is what `hasActiveSubscription` already accepts alongside `'active'`, and
   matches Stripe's `trialing`. Reading only `type` would put a trialing subscriber on
   `'active'` and lose the distinction the whole `intro-free-week` offer depends on.
4. **`event.id` IS THE IDEMPOTENCY KEY.** RevenueCat retries, so the same event arrives more
   than once; without dedupe on this a retry re-runs whatever the handler does.

**Mapping to migration 071:** `store` (`PLAY_STORE`/`APP_STORE`) → `provider`
(`'google'`/`'apple'`), and **`original_transaction_id` → `store_transaction_id`** — the stable
id that survives renewals, which is why 071's unique index is on it rather than on
`transaction_id`.

**AUTH IS A RAW `Authorization` HEADER, NO `Bearer`.** RevenueCat's own field help: *"RevenueCat
will send an HTTP Authorization header with this value in each POST request."* So the check is
an exact comparison against `REVENUECAT_WEBHOOK_AUTH`, failing closed. **HMAC signing is a
separate toggle** on the same screen, off by default, and worth enabling — both existing
webhooks here verify a signature, and a static header value is replayable by anyone who ever
sees it in a log.

**DO NOT READ `store: "APP_STORE"` IN THE TEST EVENT AS MEANINGFUL.** This is a Play-only
project; the test event is synthetic and says App Store anyway.

---

## 5. Server

- **RevenueCat webhook → `/api/webhooks/revenuecat`**, mapping `INITIAL_PURCHASE`, `RENEWAL`,
  `CANCELLATION`, `EXPIRATION`, `BILLING_ISSUE` onto `subscriptions.status`.
- **`BILLING_ISSUE` IS TWO STATES ON PLAY, AND ONLY THE SECOND REVOKES ACCESS (2026-08-28).**
  Read off the `Add base plan` screen while creating `camphawk_base/monthly`: Play applies a
  **7-day grace period** and then a **32-day account hold** (auto-calculated, 60-day combined
  maximum). They are opposites for entitlement:

  | Play state | payment | user should |
  |---|---|---|
  | grace period | failed, retrying | **keep full access** — they have not lapsed |
  | account hold | given up | lose access |

  **A naive `BILLING_ISSUE -> not subscribed` cuts off a paying customer for a week over a card
  that is about to retry successfully.** That is the same failure family as `unknown` rounding to
  "not subscribed" in §4 — the direction that shows a paywall to somebody who is paying. Grace
  must read as subscribed. RevenueCat exposes the distinction through the entitlement's
  expiry/billing-issue detection rather than through the event name alone, so **the event name is
  not sufficient input** to this decision.

  Recorded now because these two numbers live on a console screen that nothing in the codebase
  reads, and the consequence lands in a webhook written weeks later.
- **Signature verification fails CLOSED**, and the route must be added to `isPublicRoute` in
  `src/middleware.ts` or Clerk 404s it — see `/api/webhooks/twilio`, which is the working
  precedent for both.
- **Tier is derived from the product id**, exactly as `tierForPriceId` derives it from the Stripe
  price id, with the same failure direction: an unknown product maps to `base`, so the failure is
  "paying but treated as base", never silent free premium.

---

## 6. What only a human can do — the actual blockers

Nothing below can be done from a session, and most of it gates the code:

1. **Enrol in the Small Business Program** (ASC) — decides 15% vs 30%, i.e. the whole price list.
2. **Create four auto-renewable subscription products** in ASC, in one subscription group, with
   the price points from §1. Product ids are then hard inputs to the code.
3. **Paid Applications agreement** — must be active, with banking and tax complete.
4. **App Store Server API key** (.p8 + Key ID + Issuer ID), or the RevenueCat app-specific key.
5. **A new build and a new review.** IAP cannot ship web-side.
6. **Sandbox testers** in ASC for end-to-end purchase testing.

**SEQUENCING: `1.0 (5)` is currently awaiting a decision.** Submitting a new build replaces it in
the queue. If it is approved, ship IAP as `1.1`; if rejected on 3.1.1, that is the answer §2d
predicted and IAP becomes the response.

---

## 7. Suggested order

1. Human: Small Business Program, then create the four products (§6.1, §6.2).
2. Migration + webhook + product-id → tier mapping. **Ship before the client** — the server can
   accept purchases nobody is making yet, and it is testable without a build.
3. Client: plugin, paywall gated identically to the existing five surfaces, Restore Purchases.
4. Sandbox purchase for all four products, including restore and a cancellation.
5. Submit.

**Steps 2-4 are `src/lib`, a migration, and native config — MAIN LANE under `docs/LANES.md`.**

---

## 8. Step 2 in full — the products, ready to paste

*Written 2026-08-24 once the W-9 cleared. Create these the moment Paid Applications goes
Active. **Every price here assumes the Small Business Program at 15%** — if SBP is refused or
slips, do not create them; the 30% column is different and pushes Auto-Cart yearly to $71.99,
above Campsite Tonight's $59.99, which forfeits the positioning the tier was built on.*

### The subscription group

```
Reference Name (internal):    CampHawk Subscriptions
Display Name (shown to user): CampHawk
```

**LEVEL 1 IS THE TOP TIER, WHICH IS COUNTER-INTUITIVE AND EASY TO INVERT:**

```
Level 1  ->  Auto-Cart     upgrade: immediate, prorated
Level 2  ->  Base          downgrade: deferred to renewal
```

Backwards, an upgrade becomes a deferred downgrade — the user pays more *and* waits until
renewal for the feature. This is the Apple-side equivalent of `/api/stripe/plan`'s in-place
prorated swap, which exists because a second checkout would double-bill.

### The four products

| Product ID | Reference Name | Duration | Price |
|---|---|---|---|
| `app.camphawk.mobile.base.monthly` | CampHawk Base Monthly | 1 Month | $2.99 |
| `app.camphawk.mobile.base.yearly` | CampHawk Base Yearly | 1 Year | $23.99 |
| `app.camphawk.mobile.autocart.monthly` | CampHawk Auto-Cart Monthly | 1 Month | $11.99 |
| `app.camphawk.mobile.autocart.yearly` | CampHawk Auto-Cart Yearly | 1 Year | $59.99 |

**PRODUCT IDS ARE PERMANENT AND UNREUSABLE.** They cannot be renamed, and a deleted id cannot
be recreated. They also become hard-coded inputs on both the client and the webhook's
product-id → tier mapping, so a typo here is a permanent scar.

### Localisation — English (U.S.)

Apple's limits are **30 characters** for the display name and **45** for the description; both
sets below fit, but re-check in ASC rather than trusting this note.

```
Base (monthly AND yearly)
  Display Name:  CampHawk Alerts
  Description:   Instant alerts when campsites open up

Auto-Cart (monthly AND yearly)
  Display Name:  CampHawk Auto-Cart
  Description:   Alerts plus we add the site to your cart
```

### Availability

**United States only**, matching the app. Anything wider contradicts the US-only setting that
`LINKOUT_BY_STORE.ios` depends on — see `docs/APP-STORE.md` §2c.

### Introductory offer — KEEP THE FREE TRIAL (owner's call, 2026-08-24)

**One week free, on all four products.** The reason is parity rather than growth: the Stripe
path already has a `trialing` status, live rows use it, and `hasAutocartEntitlement` treats
`trialing` as entitled. Shipping the app without a trial would make the two paths differ in a
way a user can see and a support question nobody can answer cleanly.

**It must be `trialing`, not `active`, in `subscriptions`** when the webhook writes it, or the
two providers disagree about what a trial is while the entitlement query treats them alike.

### Review assets — not draftable yet

Each subscription needs a screenshot and review notes before submission. One screenshot of the
paywall reused across all four is sufficient and is the cheapest approach. **Draft the notes
once the paywall UI exists, not before** — §2d's whole lesson is that review assets describing
something the reviewer cannot reach cost a round.


---

## 9. Play Billing — the same job, a different data model

*Added 2026-08-24, the evening Google Play **production access was granted** (see
`docs/PLAY-STORE.md` §0c). This doc now covers both stores despite its name.*

### 9a. PLAY HAS NO SUBSCRIPTION GROUPS, AND THAT IS THE TRAP

Apple: four products in one group, levels decide upgrade vs downgrade, Apple prorates.

**Play: TWO subscriptions, each with base plans underneath, and NO grouping concept at all.**

```
subscription  camphawk_base          base plans:  monthly · yearly
subscription  camphawk_autocart      base plans:  monthly · yearly
```

There is no level, no ranking, and **nothing decides for you whether a switch is an upgrade or
a downgrade.** The app states it at purchase time via the subscription-update parameters and a
**proration mode**. Get that wrong and a user upgrading to Auto-Cart either pays twice or waits
until renewal for the feature — the same failure Apple's Level 1/Level 2 inversion produces,
except here it is code rather than configuration, so no console screen will show it to you.

**This is the single most likely place to lose money quietly on the Play side.**

### 9a-bis. THE PRODUCTS CANNOT BE CREATED UNTIL A BUILD DECLARES THE BILLING PERMISSION

*Found 2026-08-24 by opening the page, after every console prerequisite was satisfied.*

`Monetize with Play → Products → Subscriptions` shows an empty state whose **only** call to
action is **`Upload a new APK`**. There is no `Create subscription` button.

**THE MERCHANT ACCOUNT WAS NOT THE LAST GATE, AND §9f SAID IT WAS.** That entry listed
"⛔ Create the subscriptions — needs a Google payments merchant account first", which was true
and incomplete. The merchant account, the account group, the 15% enrolment and the US-only
country setting are all now done, and the page still refuses.

**IT IS NOT ASKING FOR *A* BINARY — IT IS ASKING FOR A PROPERTY OF ONE.** An AAB has been
uploaded and is live in closed testing (`versionCode 18` — but see the correction below), so "no
build exists" cannot be the explanation. What Play requires is an uploaded binary declaring
**`com.android.vending.BILLING`**, and that permission arrives with the Play Billing Library.
**Verified in the tree rather than assumed**: no billing dependency of any kind in
`package.json` — no Play Billing, no RevenueCat, nothing — and `com.android.vending.BILLING`
appears nowhere outside `node_modules`. A Capacitor webview build pulls it in from nothing.

**SO PLAY'S ORDER IS THE REVERSE OF THE ONE §7 RECOMMENDS:**

```
add the billing library  ->  build  ->  upload the AAB  ->  console unlocks  ->  create products
```

**AND APPLE DOES NOT WORK THIS WAY.** App Store Connect creates subscription products with no
build at all. §8's walkthrough is therefore correct as written and §9b's is not reachable yet —
one more place the two stores differ that this doc had collapsed into a single shape, alongside
§10a's IAP requirement and §9a's missing subscription groups. **Do not generalise a console
behaviour from one store to the other in here again; it has now been wrong three times.**

**IT STRENGTHENS THE REVENUECAT RECOMMENDATION IN §3.** Their SDK brings the billing library
with it, so one dependency clears the permission gate *and* the purchase plumbing. Wiring Play
Billing directly clears the gate and still leaves the server side to build.

> **TWO CORRECTIONS FROM THE CODEMAGIC BUILD LIST, read off the console 2026-08-28.**
>
> 1. **The `docs/PLAY-STORE.md` §0a citation above is wrong.** That file contains **no mention
>    of `versionCode` anywhere** (`grep -in versioncode` returns nothing). The number came from
>    `CLAUDE.md` instead. A citation that names a section which does not carry the fact is worse
>    than no citation — it reads as verified and survives a check that stops at the section name.
> 2. **What is live is probably 19, not 18.** The build list shows `Android · signed AAB +
>    APK #11` producing artifacts labelled **#19** and, being green (it emitted both an `.aab`
>    and an `.apk`), publishing them. **Whether Play accepted it is UNREAD** — nobody in a
>    session can open the Play Console. The argument in this section is unaffected either way:
>    a binary is live, and it declares no billing permission.
>
> **AND THE SAME LIST IS DIRECT EVIDENCE FOR THE BUILD-NUMBER TRAP §11b RECORDS AS MISQUOTED
> TWICE.** The per-workflow index is not the version code, and the counter is shared:
>
> ```
> Android · signed AAB + APK #10   ->  app-release.aab #18 / app-release.apk #18
> Android · signed AAB + APK #11   ->  app-release.aab #19 / app-release.apk #19
> iOS · TestFlight        #10   ->  App.ipa #21
> ```
>
> `#10` and `#11` are the workflow's own counters; **18, 19, 21 are `PROJECT_BUILD_NUMBER`**,
> running across both workflows. Two builds numbered `#10` carry version codes 18 and 21.

> **ANSWERED 2026-08-28 BY TWO BUILDS. THE GATE IS CLEARED.**
>
> ```
> build 12  cbeb709  no billing dep    FAILED at the assertion   aab 11.07 MB  Publishing  5s
> build 13  6c04a93  + RevenueCat      finished, green           aab 13.36 MB  Publishing 44s
> ```
>
> **Run 1 was the diagnostic and it earned its keep.** It failed with `MISSING` against both
> merged manifests *and* the APK — `CHECKED=3`, so all three read paths worked and it failed on
> the answer rather than on "could not look". That is the *"confirm a new gate can actually fail
> before trusting it"* rule satisfied with evidence, on a repo that once read an `ENOENT` crash
> as a check firing.
>
> **Run 2 proves the transitive chain §9a-ter could not read.** The permission is not declared by
> anything we wrote: `package.json` was the only change, and the binary grew **+2.3 MB**. That
> is `com.android.billingclient:billing` arriving through the AAR manifest merge, which is
> exactly the hop that `maven.google.com` being 403 at the proxy made unreadable from a session.
> **The build was the only place that question could be answered, and it answered it.**
>
> **INFERENCE, NOT A READING — a failing build appears NOT to publish.** `Publishing` took
> **5s** on the failed run and **44s** on the green one uploading 13 MB. That is the shape of a
> skip against a real upload, and it is the first evidence either way for the assumption the
> `publishing:` block records as *"EXPECTED, NOT READ"*. It is a duration, not a log line.
> **Do not promote it to a fact without opening that step.**

> **CONFIRMED IN THE CONSOLE 2026-08-28: `Create subscription` IS THERE.** The page that
> offered only `Upload a new APK` now reads *"Sell content or services on a recurring or prepaid
> basis"* with a live create button. **Closed testing was enough** — the binary did not need to
> be on production or open testing, which was an open question when this section was written.
>
> **NO `AD_ID`, so `docs/PLAY-STORE.md` §4 STANDS.** The flagged risk did not materialise. The
> whole RevenueCat chain added **exactly one** permission:
>
> ```
> android.permission.ACCESS_NETWORK_STATE                          webview
> android.permission.INTERNET                                      webview
> android.permission.POST_NOTIFICATIONS                            push
> android.permission.WAKE_LOCK                                     push
> com.google.android.c2dm.permission.RECEIVE                       push
> app.camphawk.mobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION     AndroidX
> com.android.vending.BILLING                                      <- the only addition
> ```
>
> **AND AGP EMITS BOTH SPELLINGS AT ONCE — the wildcard was load-bearing.** The two manifests
> the assertion read are in *different directories*, singular and plural:
>
> ```
> app/build/intermediates/merged_manifest /release/processReleaseMainManifest/AndroidManifest.xml
> app/build/intermediates/merged_manifests/release/processReleaseManifest    /AndroidManifest.xml
> ```
>
> The step's comment justified `find`ing rather than hardcoding on the grounds that *"AGP moves
> its intermediates between versions, and a stale path would find nothing and report it as no
> problem."* The real reason turns out to be stronger: **AGP uses both names simultaneously, in
> one build.** `*/merged_manifest*/release/*` catches both because of the trailing wildcard.
> **Anyone tidying that glob to a concrete path would silently check one source instead of two**
> — and the check would still print `ok` and still pass.

**PRACTICAL CONSEQUENCE: Play is now blocked on NATIVE WORK, not on the console, and Apple is
the store where more can happen sooner** — its products need only the Paid Applications
agreement, with no build in the way. That reverses the sequencing assumption this section was
written under.

### 9a-ter. THE PERMISSION IS THREE HOPS DOWN A TRANSITIVE CHAIN, AND THE BUILD NOW ASSERTS IT (2026-08-27)

§3 closed with the one thing it had not read: *"UNVERIFIED, AND THE BUILD MUST SETTLE IT: that
the plugin actually contributes `com.android.vending.BILLING` to the merged manifest."* Read
from the published package, and it is **less** direct than that sentence assumes.

**`@revenuecat/purchases-capacitor@13.4.2` SHIPS AN EMPTY ANDROID MANIFEST.**
`android/src/main/AndroidManifest.xml` is `<manifest></manifest>` and nothing else — no
permissions at all. So "the SDK brings the permission" is not a property of the thing
`package.json` names. It can only arrive by AAR manifest merge from:

```
@revenuecat/purchases-capacitor 13.4.2
  -> com.revenuecat.purchases:purchases-hybrid-common:18.32.1  (compile)
    -> com.revenuecat.purchases:purchases:10.18.1              (compile)
      -> com.android.billingclient:billing:8.3.0               (compile)
```

Each hop read off the Maven Central POMs, not recalled. **The consequence is the reason the
assertion is worth having beyond this one build:** the permission belongs to a transitive
dependency two levels below anything we declare, so a bump of `purchases-hybrid-common` can
remove it with **no line of ours changing**, and the first sign would be the Play console
quietly refusing to create products again — months later, with nothing red.

**THE LAST LINK COULD NOT BE READ FROM AN AGENT SESSION, AND THAT IS NOT A DETAIL.**
`com.android.billingclient` is published on Google's Maven, not Central. `maven.google.com`
301s to `dl.google.com`, which the agent proxy denies at CONNECT with a 403 — an org policy
denial. So whether billing 8.3.0's own manifest declares the permission is **still unread**,
and the Codemagic runner is the only place it can be read. The instruction and the constraint
happen to agree: assert it in the build, because the build is the only instrument there is.

**WHAT SHIPPED** — one step in `android-release`, after the build, beside the three assertions
already there (`docs/PLAY-STORE.md` §0b, `codemagic.yaml`):

- Reads **the merged manifest** (`app/build/intermediates/*/merged_manifest*/release/*`) —
  the merge result itself and what BOTH artifacts are built from — and **the built APK** via
  `aapt2 dump permissions`. Two sources because they fail differently.
- **Found, never hardcoded.** AGP moves its intermediates between versions, and a stale path
  would find nothing and report it as no problem. If no merged release manifest is found at
  all, the step FAILS and says so in different words from "the permission is absent" — the
  two are different faults and the messages must not be confusable.
- **`/release/` with slashes** in the filter, so `releaseUnitTest` — a different variant whose
  manifest says nothing about what ships — cannot sweep in and fail builds for nothing.
- **HONEST LIMIT:** Play receives the **AAB**, not the APK. Both come out of one Gradle
  invocation and one merged manifest, so the APK is strong evidence — but it is evidence, not
  identity, which is why the merged manifest is primary. The AAB's own manifest is protobuf
  and not greppable; reading it needs bundletool, which is not guaranteed on the image.

**IT ALSO PRINTS EVERY PERMISSION, FOR A SECOND REASON.** The same chain pulls
`com.google.android.gms:play-services-ads-identifier:17.0.1`, the usual source of
`com.google.android.gms.permission.AD_ID`. `docs/PLAY-STORE.md` §4 declares in bold *"No
advertising or tracking anywhere. No ad SDK, no ad ID"*, and Play carries a **separate** AD_ID
declaration. If it lands, both are wrong — and **every green `android-release` publishes**, so
it would ship before anyone looked. That AAR is on the same blocked host, so this too is
unread until a build reports it. **The step does NOT fail on it**: failing would block the
billing gate this exists to clear, over a policy question that is the owner's.

**THE ORDER MATTERS AND IT IS TWO BUILDS, NOT ONE.**

```
1. assertion only, no plugin   -> android-release MUST GO RED at the billing step
2. add the plugin              -> android-release goes green, the AAB uploads itself,
                                  the Subscriptions page gains its create button
```

Run 1 is not ceremony. A gate that has never been seen to fail is the vacuous-pass shape this
repo has paid for two dozen times, and `docs/SETUP.md` already carries the rule from the
jsx-spacing gate: *confirm a new gate can actually fail before trusting it.* It is also
**diagnostic**: run 1 distinguishes "the permission is absent" (expected — §9a-bis verified it
appears nowhere outside `node_modules`) from "the intermediates path does not resolve on AGP
8.13", which is the genuinely unknown half and which the two messages tell apart. Run 1 fails
before `publishing`, so it uploads nothing — and even if that ordering turned out otherwise,
it would upload a binary of the same kind already live at versionCode 18.

The shell logic was fixture-tested locally first — permission present, permission absent, no
manifest at all, the singular bundle path, `releaseUnitTest` correctly excluded, and both
`aapt2` arms — because a Codemagic run costs a build slot and a versionCode.
`worker/codemagic-assertions.test.mts` pins it, and pins the three assertions that predate it,
against ten mutations each verified to apply and to fail.

### 9b. The products (NOT YET CREATABLE — see §9a-bis)

Play ids are lowercase and **permanent**, exactly like Apple's, and are a **separate namespace** —
they do not have to match, and matching them buys nothing.

| subscription | base plan | billing period | price | offer |
|---|---|---|---|---|
| `camphawk_base` | `monthly` | 1 month | $2.99 | `intro-free-week` |
| `camphawk_base` | `yearly` | 1 year | $23.99 | `intro-free-week` |
| `camphawk_autocart` | `monthly` | 1 month | $11.99 | `intro-free-week` |
| `camphawk_autocart` | `yearly` | 1 year | $59.99 | `intro-free-week` |

Names shown to users:

```
camphawk_base       ->  CampHawk Alerts
camphawk_autocart   ->  CampHawk Auto-Cart
```

Renewal type **auto-renewing**; each base plan needs a **free-trial offer of 1 week**, matching
Apple's introductory offer and the Stripe path's `trialing` status.

> **THE BILLING PERIOD DROPDOWN DEFAULTS TO MONTHLY, AND THE ID DOES NOT CORRECT IT
> (2026-08-28).** Caught one click from `Activate` on `camphawk_autocart / yearly`, which read:
>
> ```
> Draft · yearly                  <- the permanent base plan ID
> Type: Monthly, auto-renewing    <- the actual billing period
> ```
>
> **A base plan named `yearly` billing monthly at $59.99 charges twelve times the intended
> price.** Nothing in the console objects — the ID is a free-text string and Play never compares
> it to the period. The two `monthly` plans are correct *by accident* because Monthly is the
> default; **both `yearly` plans are wrong unless someone actively changed the dropdown.**
>
> **THE PERIOD IS FIXED AT CREATION.** The remedy is Delete and recreate, not edit.
>
> **AND `Delete` EXISTS ONLY WHILE THE PLAN IS A DRAFT.** That is what made this cheap to fix
> and is the reason to read the Type line *before* pressing Activate rather than after. An
> activated base plan can be deactivated; the ID and the period are permanent.
>
> **Read the summary line, not the ID you typed.** The ID is what you meant; the Type line is
> what Play will bill.

> **THE OFFER'S `Entitlement` RADIO IS A REAL DECISION, AND THE WRONG ONE IS SILENT
> (2026-08-28).** `Add offer` asks which users a free trial may be granted to:
>
> - `Never had this subscription` — never had **this** product (`camphawk_base`)
> - **`Never had any subscription`** — never had **any** subscription in this app ← **correct**
>
> **Take the second.** Checked against the code rather than the label: `everSubscribed` is
> `SELECT id FROM subscriptions WHERE user_id = $1 LIMIT 1` in
> `src/app/api/subscription/status/route.ts` — **any row, any tier.** The app already believes
> "ever subscribed to anything ⇒ no new trial", and `Pricing.tsx` and `Explore.tsx` both key
> their trial-vs-resubscribe copy on it.
>
> **`Never had this subscription` would diverge in the direction that costs money.** Someone who
> had Alerts would be granted a second free week by Play on Auto-Cart, while our own screens
> showed them resubscribe copy offering no trial — the store giving away something the product
> never advertised. Apple would not grant it either: introductory offers are **group-level** and
> §8 puts both products in one group. The chosen option is the only one where Stripe, Apple and
> Play agree.

**VERIFIED IN THE CONSOLE 2026-08-28 — `camphawk_base` is created and correct:** `monthly`
(Monthly, auto-renewing) and `yearly` (Yearly, auto-renewing), both **Active**, both **United
States** only.

**Region availability is not "leave the price blank".** Every non-US region errored with a red
`Set a price` until they were removed through **`Manage country / region availability`** — an
unpriced region is an *error*, not an opt-out. §9c's "United States only" is an explicit
availability change.

### 9c. Availability

**United States only**, on the PRODUCTION track — now settable for the first time (§0c). This
matters far less than it did: with Play Billing there is no steering UI, so the US restriction is
no longer the precondition for anything. Set it anyway for parity with Apple, but it is not
load-bearing.

### 9d. THE FEE IS 15%, CONFIRMED FROM GOOGLE'S OWN TABLE (2026-08-24)

**Read off Google's service-fee page, not assumed.** CampHawk is US-only, so the **June 30,
2026 US table** governs, and for auto-renewing subscriptions it reads:

| | Auto-renewing subscriptions (new & existing installs) |
|---|---|
| First $1M (USD) of annual earnings | **10% + 5% billing fee** |
| Standard | **10% + 5% billing fee** |

**10% + 5% = 15% effective, and THE TWO ROWS ARE IDENTICAL — there is no $1M cliff for
subscriptions.** ~~That is the substantive difference from Apple: the Small Business Program
form in §6.1 exists purely to buy 15% instead of 30%, and Google gives the same rate with no
enrolment, no effective date and no annual reconfirmation.~~ **So §1's price list is correct for
both stores** — `$2.99 / $23.99 / $11.99 / $59.99`.

> **"NO ENROLMENT" IS FALSIFIED — SEE §9i.** The Play Console's own payments page carries a
> banner reading *"Enroll for the 15% service fee … To receive the new rate you will need to:
> create an account group … accept the service fee terms and conditions."* **A rate published in
> a table is not a rate applied to an account.** The price list is unaffected; the claim that
> nothing had to be done to get 15% was read off Google's marketing page and never off this
> account. Struck rather than deleted because it is the sentence a later reader would quote as
> a reason to skip the enrolment.

**THE 5% IS A *BILLING* FEE, NOT A SERVICE FEE**, and the distinction is why the number is
written as two parts. It applies specifically when the purchase completes through Google Play
Billing, so it is the 5% an alternative billing system would save. Not worth pursuing at this
volume; worth knowing the number is 10 + 5 rather than a flat 15.

**AND EXTERNAL WEB LINKS NOW CARRY THEIR OWN FEE, WHICH CUTS AGAINST THE LINK-OUT.** For
non-subscription transactions the same table reads *"25% + 5% billing fee OR 20% for external
web links"* — so post-*Epic*, steering users to an outside purchase is not free, merely priced
differently. For auto-renewing subscriptions **no external-link rate is listed at all**; only
the 10% + 5%.

That is worth recording because it reverses an intuition this repo has carried since §2c: the
link-out was treated as the cheap path and IAP as the expensive one. At 15% through Play
Billing, in-app is at worst competitive with linking out **and carries no anti-steering
exposure** — which is the same conclusion §9f reaches from the other direction, arrived at
independently.

### 9e. Server — one webhook or two?

Play sends **Real-time Developer Notifications** over Pub/Sub, which is a different shape from
Apple's App Store Server Notifications and a second thing to operate.

**This is the strongest argument for RevenueCat in §3.** It normalises both stores into one
webhook, so `subscriptions` gains one `provider` value (`'play'`) and the entitlement query —
which §2 establishes needs no change at all — keeps working for a third provider for free.
Rolling it yourself means operating two notification pipelines, each silent when broken, with
a paying customer losing entitlement as the failure mode.

### 9f. What is NOT blocked any more, and what still is

**CORRECTED 2026-08-24, same evening: creating the subscriptions is NOT unblocked.** This table
first said "Monetize with Play is available now" on the strength of the production-access grant.
It is not — the page answers **"To monetize this app, set up a merchant account"** and every
monetization item in the left nav (Products, Price experiments, Monetization setup) is inert
until that clears. **Production access and monetization access are two separate gates**, and
granting the first says nothing about the second.

| | |
|---|---|
| ⛔ **Create the subscriptions** | needs a **Google payments merchant account** first |
| ✅ Set US-only on production | genuinely unblocked by the access grant |
| ⛔ A production release | Production reads **Inactive**; needs a build |
| ⛔ Anything client-side | needs the billing library and a new AAB |

### 9g. The merchant account — Play's equivalent of Paid Applications

Same shape as Apple's §6.3, and it wants the same facts, so file them together:

```
Account type          Individual (sole proprietor)
Legal name / address  MUST MATCH the W-9 filed with Apple — a mismatch is the
                      usual cause of a stuck tax interview
Tax interview         US
Bank account          the same Chase account given to Apple
```

**THE PUBLIC SELLER NAME IS A REAL DECISION, NOT A FORM FIELD.** Google asks for a public-facing
seller name and it appears on customers' **Google Play receipts**. Entering the legal name means
a buyer's receipt for a CampHawk subscription reads *"Tyler Flores"*. `CampHawk` is the sensible
entry — and note this is **NOT** the same field as Apple's "Business Name", which is specifically
for a registered DBA and correctly left blank.

An existing Google payments profile from another Google service can usually be linked rather
than recreated.

**Expect a day or two**, exactly as with Apple's banking. So Play turns out to have the same
shape after all — form now, wait, then create products.

### 9h. The public merchant profile — the five fields, and the two that are decisions

*Written 2026-08-24 from the live form. Google Play Console → Settings → Payments profile.
The owner reached this screen, so the merchant-account gate in §9f is now OPEN and being
worked — that entry's ⛔ is spent.*

| Field | Enter | Why |
|---|---|---|
| Business name *(required)* | `CampHawk` | **Public.** Appears on Play receipts. |
| Website *(optional)* | `https://camphawk.app` | Fill it — an unreachable seller is a review risk. |
| What do you sell | the digital-software / apps option | Category only; nothing downstream reads it. |
| Customer support email *(required)* | `alerts@camphawk.app` | Already the published address on `/support`, `/privacy`, `/terms`, `/sources`. |
| Credit card statement name *(required)* | `CAMPHAWK` | **Public.** This is the line on the buyer's card statement. |

**THE TICKED CHECKBOX DOES NOT FILL THE BUSINESS NAME, AND THE RED ERROR IS NOT A BUG.**
*"Use legal business info name, contact, address"* is checked and `Business name` is still
flagged required and empty. For an **Individual** account type there is no legal *business*
name to copy — the legal identity is a person — so the public name has to be typed. Do not
untick the box trying to clear the error; that changes what address is used, which is the next
paragraph.

**`CAMPHAWK` ON THE STATEMENT IS A CHARGEBACK CONTROL, NOT COSMETICS.** A subscriber who sees
an unfamiliar name against a recurring charge disputes it, and a dispute costs the fee plus the
revenue plus standing with the processor. The statement line must be the name the buyer
recognises from the app — never the legal name. Same argument as the seller name above, with a
sharper consequence.

**UNRESOLVED, AND WORTH THIRTY SECONDS BEFORE SUBMITTING: what does "Public merchant profile"
publish?** The section is titled *Public*, the checkbox pulls in **contact and address**, and
the address on file is a **home address**. Whether Google exposes it to buyers for a
digital-only seller was **not determined** — there is an (i) tooltip beside *Public business
information* on that screen, which is the cheapest way to find out and is right there. Recorded
as an open question rather than answered from assumption; do not write a conclusion in here
without reading it.

**`alerts@camphawk.app` IS THE RIGHT ADDRESS AND ITS INBOUND ROUTING IS UNVERIFIED.** It is the
address the site already publishes in four places and promises *"a human will answer"* against,
so consistency argues for it. But it is also the **From** address for outbound alerts via Resend
(`src/lib/notifications/email.ts:28`), and a send-only sender is not a mailbox. **This session
could not check** — the container has no `dig`, `host` or `nslookup`, and an MX query returning
nothing here is a missing binary rather than a missing record (verified: the control query for a
domain that certainly has MX failed identically). Google will send merchant and dispute notices
to whatever goes in this field, and buyers will email it. **Confirm mail to it actually lands
somewhere read before relying on it; if not, use an address that does.** Presence is not
liveness — the same shape as `status = 'sent'` meaning only "Twilio returned 2xx".

---

### 9i. THE 15% IS AN ENROLMENT, NOT A DEFAULT — and the payout path is still empty

*Read off the live Payments profile page 2026-08-24, immediately after the merchant account was
created. Two things are outstanding on it and neither is a wait — both are actions.*

**1. ENROL FOR THE 15% SERVICE FEE.** The page's own banner:

> *Enroll for the 15% service fee. You can now enroll for the 15% service fee in Play Console.
> To receive the new rate you will need to: create an account group and let us know if you have
> any associated developer accounts · accept the service fee terms and conditions.*

`Manage account group` → create a group → declare associated developer accounts (**there are
none**; one Play account, so the disclosure is "no") → accept the terms.

**THIS IS THE PLAY EQUIVALENT OF APPLE'S SMALL BUSINESS PROGRAM AFTER ALL** (§6.1), and §9d said
in as many words that it was not. Same shape, same cost (nothing), same consequence for skipping
it. **A published fee table describes what Google offers; an account group describes what this
account gets.** The repo has paid for that distinction repeatedly — a demo password that was
present but wrong, `status = 'sent'` meaning only that Twilio returned 2xx, a `GITHUB_TOKEN` that
is set and is a placeholder.

**WHETHER IT CHANGES THE *SUBSCRIPTION* RATE IS NOT ESTABLISHED — do not write in that it does.**
§9d's 10% + 5% comes from the auto-renewing-subscriptions column, and this banner is the general
service-fee programme; they may be independent mechanisms. **The action is unambiguous either
way** — enrolling is free and cannot make the rate worse — so do it, and do not go on to record
"subscriptions are 15% because we enrolled" without reading the fee table back afterwards.

**2. ADD A PAYMENT METHOD — "How you get paid" is EMPTY.** Earnings read `$0.00` against a `$1.00`
payout threshold with no bank account attached. Same Chase account as Apple, same legal name and
address as the W-9. **Nothing warns about this until there is money to send**, and the first
subscriber is the wrong moment to discover it.

> **DONE — VERIFIED 2026-08-24.** What arriving looks like, so the next reader is not waiting on
> the wrong thing:
>
> ```
> ORIG CO NAME: GOOGLE CO
> ENTRY DESCR:  ACCTVERIFY
> $0.10                       <- ONE deposit, not a pair; no ordering to get wrong
> ```
>
> Entered at **Play Console → Settings → Payments profile → the bank card under *How you get
> paid* → Verify**. Read the field label before typing: some Google forms want dollars (`0.10`)
> and some want cents (`10`). **Google invalidates the deposit after a few failed attempts** and
> reissues, which restarts the wait — so read the amount off the statement, and if the form
> rejects a pending deposit, wait for it to post rather than guessing other amounts.
>
> **APPLE DOES NOT DO THIS.** Their bank validates without a test deposit and the account simply
> moves to Active on the Business page. **Anyone waiting for an Apple micro-deposit is waiting
> for something that is not coming** — watch the status, not the bank statement.

**NEITHER OF THESE BLOCKS CREATING THE PRODUCTS**, so §9's product work can start as soon as the
merchant account finishes provisioning. They block getting *paid* correctly, which is a different
deadline and a quieter one.

**PROGRESS, 2026-08-24 evening.** Account group **`CampHawk`** exists, holding the one primary
account (`7424004468450397856`, `tylerflores1992@gmail.com`). Bank account added; **waiting on
micro-deposit verification** (typically 2–5 business days, and the amounts have to be entered
back into the console — it does not verify itself).

~~**DO NOT PRESS `Start` UNDER "Add developer accounts to your account group".** That empty state
is for declaring *other* developer accounts you also control, and there are none. It reads like
the next step in the enrolment and is not — it opens an invitation flow for an account that does
not exist. The first of the banner's two requirements is **already satisfied** by the group
existing with a truthful answer of "none".~~

> **WRONG ON BOTH HALVES, CORRECTED WITHIN THE HOUR.** `Manage account group` opens a
> **declaration dialog**, not an invitation flow, and it asks two questions that were sitting
> **unanswered**:
>
> | Question | Answer |
> |---|---|
> | Does your legal entity own any other Play Console developer accounts? | **No** |
> | Are there any other developer accounts that publish apps that use similar brand features? | **No** |
>
> Then `Save`. **So the first requirement was NOT satisfied** — the group existed with the
> declaration blank, and I read the group's existence as the answer having been given. **A
> created group is not a completed declaration**, which is the same distinction the paragraph
> below draws about the rate, made one level earlier and got wrong in the act of writing it.
> The advice to avoid the button would have blocked the very step it was describing.

~~**WHAT IS STILL OUTSTANDING IS THE BANNER'S SECOND BULLET: accept the service fee terms and
conditions.** The group is the prerequisite, not the enrolment.~~ **A created account group is not
an accepted rate** — same distinction as §9i's opening, one level in, and the point at which it
would be easy to consider this done.

> **DONE — ENROLLED, 2026-08-24.** The page now reads *"Your account group is enrolled for the
> 15% service fee"* and lists it under **Programs and services you're enrolled in** with a
> `View terms` link. **The two bullets resolved in one action**: saving the declaration carried
> the terms with it rather than leaving a separate step, which is the opposite of what the
> sentence above predicted. The general reasoning stands and only the sequencing was wrong.

**§9d'S OPEN QUESTION IS NOW MOOT FOR THE PRICING, THOUGH STILL UNANSWERED ON ITS MERITS.** It
asked whether this enrolment bears on the *auto-renewing subscription* rate specifically, since
§9d's 10% + 5% comes from the subscriptions column and the banner is the general service-fee
programme. **Both roads arrive at 15%**, so §1's price list — `$2.99 / $23.99 / $11.99 / $59.99`
— is correct either way and nothing downstream depends on the answer. The `View terms` link on
that page would settle the mechanism for anyone who needs it later; **do not record an answer
without reading it.**

## 10. THE TWO STORES DO NOT HAVE THE SAME RULE, AND STORE BILLING NETS MORE THAN STRIPE

*Added 2026-08-24 after the owner asked whether Play, like Apple, forbids selling only on the
website. It does not, and the revenue comparison turned out to run the opposite way from the
premise the whole plan started on.*

### 10a. APPLE REQUIRES IAP. GOOGLE'S RULE ATTACHES TO IN-APP TRANSACTIONS ONLY

**Apple — mandatory.** Guideline **3.1.3(b) Multiplatform** permits honouring content bought
elsewhere *"provided those items are also available as in-app purchases within the app."* That
**"also"** is the entire requirement, and an app that honours web subscriptions while offering
no IAP fails it. This is exactly what `docs/APP-STORE.md` §2c and §2d record across three
rejections — see §2c for why 3.1.3(b) is a restatement of the demand rather than a defence.

**Google — narrower.** The Payments policy requires Google Play Billing for **purchases made
inside the app**. There is no equivalent of Apple's "must also be available in-app" clause, so
an app that sells nothing within itself and signs users into an account bought on the web is
not making an in-app purchase for the policy to attach to.

**Supporting evidence sits in Google's own fee schedule:** *"OR; 20% for external web links"* is
a published line item. Google contemplates and prices external purchase flows. Apple's schedule
has no such row.

**THE GAP, STATED RATHER THAN PAPERED OVER.** For auto-renewing subscriptions Google's table
lists only 10% + 5% and **no external-link rate**, so it cannot be told from the table alone
whether external links are unavailable for subscriptions or merely not broken out. And
`support.google.com` and `play.google` are **outside this environment's egress allowlist**
(both returned `000` on 2026-08-24), so the Payments policy could not be read directly. **This
section is a policy read from a May 2026 knowledge cutoff, not a verified quotation.** Confirm
in the Play Console's policy status before treating "Play does not require it" as settled.

### 10b. STORE BILLING NETS MORE THAN STRIPE ON EVERY PLAN — the premise was backwards

The plan opened on the owner's framing: *"charge more to cover the profit stolen from Apple."*
Run the arithmetic and the price rise more than covers the commission, because **Stripe's fixed
$0.30 per transaction is punishing at these amounts.**

Stripe US card pricing is **2.9% + $0.30**; both stores are **15%**:

| plan | web (Stripe) | fee | **net** | store price | −15% | **net** | store advantage |
|---|---|---|---|---|---|---|---|
| Base monthly | $2.50 | $0.37 | **$2.13** | $2.99 | $0.45 | **$2.54** | **+$0.41** |
| Base yearly | $20.00 | $0.88 | **$19.12** | $23.99 | $3.60 | **$20.39** | **+$1.27** |
| Auto-Cart monthly | $10.00 | $0.59 | **$9.41** | $11.99 | $1.80 | **$10.19** | **+$0.78** |
| Auto-Cart yearly | $50.00 | $1.75 | **$48.25** | $59.99 | $9.00 | **$50.99** | **+$2.74** |

**THE REASON IS THE FIXED FEE, AND IT IS CLEAREST AS AN EFFECTIVE RATE:**

```
Stripe's effective rate on $2.50   =  $0.37 / $2.50  =  14.9%
the stores' rate                   =                    15.0%
```

**On the base monthly plan Stripe already costs what Apple and Google cost.** The 30 cents is
almost the whole fee at that price. Stripe only pulls ahead on the larger yearly charges
(4.4% on $20, 3.5% on $50) — and a ~20% price rise closes even those.

*(Approximate: Stripe Billing adds ~0.5% on top if in use, which widens the gap further. And
this compares store-at-raised-price against web-at-current-price, which is the real comparison
because §1 keeps web prices where they are.)*

### 10c. WHAT THIS CHANGES — sequencing, not the plan

The products are worth creating on both stores regardless: they net more than the web path,
they convert better than "go to our website and come back", and on Play they permanently
retire the `LINKOUT_BY_STORE.android` precondition (§9f, `docs/PLAY-STORE.md` §1).

**What it does change is which store is BLOCKING.** If Play genuinely does not require Play
Billing, then **Play is not gated on any of this** and could launch on the existing web-checkout
model, while **Apple is the only store where IAP is a release gate**. That is worth knowing
before committing an evening to the Play side — it is a revenue optimisation there and a
compliance requirement on Apple.

**AND IT RETIRES THE "PROFIT STOLEN BY APPLE" FRAMING.** At these price points the commission
is not a loss to be absorbed; the fixed-fee structure of card processing means the stores are
roughly at parity with Stripe on the small monthly plan and the price rise covers the rest.
Nobody should re-derive this from the 15% figure alone and conclude the app path is worse.

---

## 11. THE ANDROID BUILD — the next session's job, and the constraint this plan did not carry

*Written 2026-08-24 at the owner's direction to prepare an implementation session. Everything
in both consoles is done (see **STATE AS OF**); Play's only remaining blocker is this.*

### 11a. THE APP IS A REMOTE WEBVIEW, AND THAT CHANGES THE CLIENT DESIGN

**Not in §3, and it should have been.** `capacitor.config.ts` sets
`server.url = 'https://camphawk.app/search'` — the app is a thin native shell around the **live
site**, not a bundled build. Three consequences the implementation has to be designed around:

1. **A webview cannot invoke Play Billing.** The purchase must be made by native code and
   reached over the Capacitor bridge. The pattern already exists — `NativeBridge.tsx`
   dynamic-imports `@capacitor/*` guarded by `Capacitor.getPlatform()`, and Capacitor injects
   its runtime into the remote page — so this is feasible and is not new ground.
2. **A WEB DEPLOY CANNOT ADD PURCHASE CAPABILITY.** Everything else in this product reaches
   installed apps on a `git push`; this does not. The paywall UI is web-side and instant, the
   plugin behind it is in the binary and needs a release. **They will be out of step, on
   purpose, for as long as it takes users to update.**
3. **THEREFORE DETECT THE CAPABILITY, NOT THE PLATFORM.** `isNative` (a User-Agent marker,
   `src/lib/native/context.tsx`) says the shell is CampHawk. It does **not** say the shell has
   the purchases plugin. A paywall gated on `isNative` alone shows a Buy button that throws on
   every app installed before the release. **A missing plugin must read as `unknown`, never as
   "not subscribed" and never as a broken button** — the same rule §4 already states for a
   failed entitlement lookup, applied one layer down.

### 11b. What the build actually needs

The gate is §9a-bis: an uploaded binary declaring **`com.android.vending.BILLING`**, which
arrives with the Play Billing Library — pulled in by whichever plugin §3's undecided call
lands on.

```
add the plugin  ->  npx cap sync android  ->  Codemagic `android-release`  ->  AAB
   ->  upload (automatic, see below)  ->  Subscriptions page gains its create button
   ->  create the four products (§9b)
```

**Facts about this build worth not re-deriving** (`codemagic.yaml`, `docs/PLAY-STORE.md` §0b):

- `android/` is **gitignored and regenerated every build** — never edit it, change
  `capacitor.config.ts` or the workflow instead.
- `android-release` already asserts **targetSdk ≥ 36**, that the **InAppBrowser plugin is
  installed**, and that the **APK is actually signed**. Adding a dependency must not break any
  of the three.
- `versionCode` comes from Codemagic's `PROJECT_BUILD_NUMBER` — shared across workflows, and
  **not** the per-workflow `index`, which has been misquoted as the build number twice.
- **Every green `android-release` uploads itself** to Play closed testing via the `google_play`
  env group. So a build is a publish; there is no separate upload step to forget, and equally
  no dry run.

### 11c. ONE DEPENDENCY TREE, TWO PLATFORMS — the iOS risk is real and is recorded

Adding an IAP plugin touches **both** apps. The Capacitor 8 upgrade already produced the
failure this repeats: **v8 defaults iOS to Swift Package Manager**, which derives package
identity from the last path segment, so `@capacitor/app` and `@capacitor-firebase/app` both
claimed `app` and dependency resolution failed outright. The fix was
`npx cap add ios --packagemanager cocoapods`, and **it must stay CocoaPods.**

A new plugin is a new identity in that namespace. **Run the iOS workflow too**, or find out
when a TestFlight build is needed for something else.

### 11d. What must not break

Beyond §4's list, which still stands in full:

- **`cordova-plugin-inappbrowser`** — the RC hand-off. It is the only package of three that has
  `executeScript`, and `codemagic.yaml` asserts it at `ios/capacitor-cordova-ios-plugins`
  specifically. **Never widen that assertion to `grep -r ios/`**: `ios/App/App/public` holds our
  own `cordova.InAppBrowser` probe and would pass with the plugin absent.
- **`@capacitor-firebase/messaging`** — push. A dependency bump that moves Firebase is a push
  outage, and push is an alert channel.

### 11e. THE DECISION THAT IS NOT MINE TO MAKE

§3 recommends **RevenueCat** over `@capacitor-community/in-app-purchases`, and §9a-bis
strengthens it — their SDK brings the billing library *and* the purchase plumbing, where direct
Play Billing clears the permission gate and leaves the entire server side to build.

~~**It is still a third party in the payment path and the owner has not chosen.** Do not pick one
by starting to install it.~~

> **DECIDED 2026-08-24: RevenueCat** (see the box in §3, which also records that the named
> alternative does not exist on npm). Install `@revenuecat/purchases-capacitor`.

### 11f. THIS IS NOT SIDE-LANE WORK

`package.json`, `capacitor.config.ts` and `codemagic.yaml` are not in either lane's list in
`docs/LANES.md`, and the server half (§2's migration, §5's webhook) is squarely **main lane's**.
A session doing this needs the owner's authorisation to cross, exactly as the park-watch work
did.

