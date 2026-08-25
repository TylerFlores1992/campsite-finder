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
