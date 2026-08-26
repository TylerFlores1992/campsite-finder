# StoreKit — implementation plan

*Written 2026-08-24 (side lane) on the owner's decision to add In-App Purchase and raise prices
to absorb Apple's commission. This is the design and the arithmetic; it is **not** an
implementation. Read "What only a human can do" before planning a session around it.*

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

### 9b. The products

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

**NEITHER OF THESE BLOCKS CREATING THE PRODUCTS**, so §9's product work can start as soon as the
merchant account finishes provisioning. They block getting *paid* correctly, which is a different
deadline and a quieter one.

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
