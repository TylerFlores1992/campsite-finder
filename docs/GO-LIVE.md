# CampHawk — Go-Live Runbook

Everything code-side is done. The remaining launch tasks live in dashboards
(Vercel, Stripe, Clerk, Sentry, Twilio) and must be done by the account owner.
Work top to bottom. After each section, run the **Verify** step.

> Where env vars live:
> - **Vercel → Project → Settings → Environment Variables** (scope: **Production**) → powers the website (camphawk.app).
> - **Fly.io** (`fly secrets set …`) → powers the alert worker/poller. It's already provisioned and healthy; nothing to change unless you rotate credentials.
> - After changing any Vercel env var you must **redeploy** for it to take effect.

---

## 1. Vercel Analytics + Speed Insights  (2 min)
Already in the code — just enable the dashboards.

- [ ] Vercel → project → **Analytics** tab → **Enable**
- [ ] Vercel → project → **Speed Insights** tab → **Enable**

**Verify:** after the next deploy, load the site, then check the Analytics tab shows a page view within a few minutes.

---

## 2. Sentry error monitoring  (10 min)
Code is DSN-gated — inert until you add the DSN.

- [ ] Create a free account at sentry.io → **Create Project** → platform **Next.js** → copy the **DSN**
- [ ] Vercel → Env Vars (Production) → add `NEXT_PUBLIC_SENTRY_DSN = <your DSN>`
- [ ] *(Optional, readable stack traces)* also add `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` (Sentry → Settings → Auth Tokens)
- [ ] Redeploy

**Verify:** temporarily visit `https://camphawk.app/api/does-not-exist` or trigger an error; confirm it appears in Sentry → Issues. (Then you're done.)

---

## 3. Clerk → production instance  (15 min)
Local uses **test** keys (`pk_test`/`sk_test`). Production must use **live** keys.

- [ ] Clerk dashboard → switch the instance to **Production** (or create the production instance)
- [ ] **Rename the application to `CampHawk`** (Settings) — this fixes the sign-in screen that currently says "Campsite Finder"
- [ ] Add the production domain `camphawk.app` and complete Clerk's DNS records if prompted
- [ ] Copy the **live** keys → Vercel Env Vars (Production):
  - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = pk_live_…`
  - `CLERK_SECRET_KEY = sk_live_…`
- [ ] Confirm these are still correct for prod: `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`
- [ ] Redeploy

**Verify:** open `https://camphawk.app/sign-in` — the heading should read **"Sign in to CampHawk"** (not "Campsite Finder"), with no Clerk dev banner.

---

## 4. Stripe → live mode  (20 min)  ⚠️ no revenue until this is right
Local uses **test** keys. Everything below must be the **live-mode** equivalents.

- [ ] Stripe dashboard → toggle to **live mode** (top-left) and complete business/bank activation if not already
- [ ] Recreate the two subscription **Prices** in live mode ($5/mo and $50/yr) → copy their live `price_…` IDs
- [ ] Add to Vercel Env Vars (Production):
  - `STRIPE_SECRET_KEY = sk_live_…`
  - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = pk_live_…`
  - `STRIPE_PRICE_ID_MONTHLY = price_… (live)`
  - `STRIPE_PRICE_ID_YEARLY = price_… (live)`
- [ ] Stripe → **Developers → Webhooks → Add endpoint** (in **live** mode):
  - URL: `https://camphawk.app/api/webhooks/stripe`
  - Events to send (exactly these three):
    - `checkout.session.completed`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
  - Copy the endpoint's **Signing secret** → Vercel `STRIPE_WEBHOOK_SECRET = whsec_… (live)`
- [ ] Redeploy

**Verify:** go through a real checkout on `https://camphawk.app` with a real card (you can immediately refund/cancel). Confirm: (a) you land back on the app subscribed, (b) Stripe → live payments shows the charge, (c) the webhook endpoint shows a `200` for `checkout.session.completed`.

---

## 5. App URL  (2 min)
- [ ] Vercel Env Vars (Production): set `NEXT_PUBLIC_APP_URL = https://camphawk.app`
      (local currently points at an ngrok tunnel; harmless in code today but keep prod correct)
- [ ] Redeploy

---

## 6. Twilio A2P 10DLC  (waiting on Twilio)
- [ ] Twilio Console → **Messaging → Regulatory Compliance → A2P 10DLC** → confirm the campaign is **Approved**
- [ ] Confirm the registered brand/campaign name and sample messages say **CampHawk** (matches the app + SMS body)
- [ ] Once approved, send yourself a test: add your number on `/sms-opt-in`, tick consent, and trigger a watch that opens up

**Note:** until approved, SMS silently won't deliver. Email alerts work regardless.

---

## Final smoke test (after all of the above + a deploy)
- [ ] Home page loads with the hero background; logo click returns home
- [ ] Search a park → results show map thumbnails; set dates → "Notify me" on booked sites
- [ ] Sign up (live Clerk) → subscribe (live Stripe) → reach the app
- [ ] Create a watch → confirm it appears in the Watches panel
- [ ] `https://camphawk.app/robots.txt` and `/sitemap.xml` return correctly
- [ ] Share a link in Slack/iMessage → the CampHawk logo preview shows (OG image)
- [ ] Worker health: `https://camphawk.app/api/health/worker` returns `{"ok":true}`

---

### Quick reference — Vercel Production env vars
```
# Auth (Clerk, live)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up

# Payments (Stripe, live)
STRIPE_SECRET_KEY=sk_live_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...        # from the LIVE webhook endpoint
STRIPE_PRICE_ID_MONTHLY=price_...      # live
STRIPE_PRICE_ID_YEARLY=price_...       # live

# App
NEXT_PUBLIC_APP_URL=https://camphawk.app

# Monitoring (optional but recommended)
NEXT_PUBLIC_SENTRY_DSN=https://...ingest.sentry.io/...
SENTRY_ORG=...        # optional, for source maps
SENTRY_PROJECT=...    # optional
SENTRY_AUTH_TOKEN=... # optional

# Already set (leave as-is): DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, EMAIL_FROM, RIDB_API_KEY,
# NEXT_PUBLIC_MAPBOX_TOKEN, UPSTASH_REDIS_REST_URL/TOKEN, SYNC_SECRET,
# TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER/MESSAGING_SERVICE_SID
```
