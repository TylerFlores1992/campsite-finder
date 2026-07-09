# CampHawk Quick Cart — Chrome extension

Optional companion to CampHawk. When you open a CampHawk alert link, it can fill
your dates and click **Add to cart** on Recreation.gov — running entirely in your
own browser, in your own signed-in session. **CampHawk servers never see your
Recreation.gov login.**

## ⚠️ Risk

Automating Recreation.gov may violate its Terms of Service and can get your
Recreation.gov account suspended or banned. The feature ships **OFF by default**
and requires an explicit in-extension risk acceptance before it can be enabled.
Use at your own risk.

## How it works

1. CampHawk alert links to a booked-then-opened site include a `#camphawk=IN_OUT`
   URL fragment (e.g. `…/campsites/12345#camphawk=2026-07-10_2026-07-12`). URL
   fragments are never transmitted to rec.gov's servers.
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
- ReserveCalifornia (CA State Parks) is not automated — those alerts link to the
  park page only.
