# CampHawk Quick Cart — Chrome extension

Optional companion to CampHawk. When you open a CampHawk alert link, it can fill
your dates and add the site to your cart on **Recreation.gov** or
**ReserveCalifornia** — running entirely in your own browser, in your own signed-in
session. **CampHawk servers never see your login for either site.**

The two sites work differently. Recreation.gov is driven through the DOM (fill the
date fields, click Add to cart). ReserveCalifornia is API-driven: we POST the same
request the site itself makes, using the token and cart key captured from your own
session. That makes RC the more reliable of the two — there are no selectors to
break — but it needs your cart to already exist (see below).

## ⚠️ Risk

Automating Recreation.gov or ReserveCalifornia may violate their Terms of Service
and can get that account suspended or banned. The feature ships **OFF by default**
and requires an explicit in-extension risk acceptance before it can be enabled.
Use at your own risk.

## How it works

1. CampHawk alert links to a booked-then-opened site include a URL fragment —
   `#camphawk=IN_OUT` on rec.gov (e.g.
   `…/campsites/12345#camphawk=2026-07-10_2026-07-12`) or
   `#camphawk-rc=UNIT_ARRIVAL_NIGHTS_SLEEPINGUNIT` on ReserveCalifornia. URL
   fragments are never transmitted to either site's servers.
2. The content script reads the dates, shows a small CampHawk banner, and offers
   a **Fill dates & add to cart** button.
3. If you've turned the toggle on *and* accepted the risk, it also runs
   automatically on page load.

## Install (unpacked, for testing)

1. Chrome → `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` folder
4. Click the CampHawk icon → read the disclaimer → check "I accept" → flip the
   toggle on (or leave it off and use the button manually)

## Known limitations

- Recreation.gov is a React SPA with no stable public DOM contract. The date-field
  and Add-to-cart selectors in `content.js` are best-effort with fallbacks and may
  need re-tuning when rec.gov changes its markup. The manual banner button is the
  fallback; the extension never breaks the page.
- Toolbar icons are omitted (Chrome shows a default). Add PNG icons + an `"icons"`
  block to `manifest.json` before any Web Store submission.
- **ReserveCalifornia needs an existing cart.** RC addresses a cart by a
  `shoppingCartKey` GUID, and a key we mint ourselves creates a phantom cart the RC
  UI never shows — so the banner asks you to click the 🛒 icon once first. The real
  key is captured from RC's own API traffic by `rc-inject.js`.
- **ReserveCalifornia payload fields are best-effort.** `extraValues`,
  `customerClassificationId` and `sleepingUnit.name` were captured from one real
  add-to-cart and may not generalise across unit types. RC's rejection is reported
  in the banner; book manually if it fires.
