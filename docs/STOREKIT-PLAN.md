# StoreKit — implementation plan

*Written 2026-08-24 (side lane) on the owner's decision to add In-App Purchase and raise prices
to absorb Apple's commission. This is the design and the arithmetic; it is **not** an
implementation. Read "What only a human can do" before planning a session around it.*

---

## STATE AS OF 2026-08-24, END OF EVENING — read this first

Everything both consoles allow was done. **Both stores are now waiting on someone else**, and
Play additionally on native code that does not exist.

| | Done | Waiting on the vendor | Blocked on us |
|---|---|---|---|
| **Apple** | W-9 active | Bank details + Paid Applications agreement processing | Small Business Program enrolment (§6.1), then the four products (§8) |
| **Play** | Merchant account · account group + declaration · **15% service fee enrolled** · production set US-only · **bank verified** | — **nothing** | **A build declaring `com.android.vending.BILLING` (§9a-bis)** |

> **UPDATE 2026-08-27 — §9a-ter.** The build now ASSERTS `com.android.vending.BILLING` in the
> merged manifest, because the plugin's own Android manifest is **empty** and the permission
> can only arrive three hops down a transitive chain (`purchases-hybrid-common` → `purchases`
> → `com.android.billingclient:billing`). The last link sits on Google's Maven, which the agent
> proxy denies, so it is **still unread** and the Codemagic runner is the only instrument.
> **Two builds, in order: assertion alone must go RED, then the plugin makes it green.**

**THE ONE FINDING THAT CHANGES THE PLAN IS §9a-bis.** Play will not let the subscription
products be created at all until an uploaded binary declares the billing permission — so Play's
order is library → build → upload → products, the reverse of §7, and it is now **native work
rather than a console task**. Apple has no such gate. §9b's product table is correct and
**not yet reachable**; §8's Apple walkthrough is correct and reachable the moment the agreement
clears.

**THE LIBRARY IS DECIDED: RevenueCat** (`@revenuecat/purchases-capacitor`, §3). **THE NEXT
SESSION'S JOB IS §11** — the Android build that clears §9a-bis. It carries a
constraint this plan was written without: **the app is a remote webview** (`server.url =
camphawk.app/search`), so a web deploy cannot add purchase capability and the paywall must
detect the *plugin*, not the platform. Read §11 before §3.

**NOTHING IN `src/` HAS CHANGED. There is no code for any of this.** The migration in §2, the
webhook in §5, the product-id → tier mapping and the paywall are all unwritten, and all of it is
**main-lane** territory (`src/lib/`, `src/lib/db/migrations/`).

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

## 5. Server

- **RevenueCat webhook → `/api/webhooks/revenuecat`**, mapping `INITIAL_PURCHASE`, `RENEWAL`,
  `CANCELLATION`, `EXPIRATION`, `BILLING_ISSUE` onto `subscriptions.status`.
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

