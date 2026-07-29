/**
 * App Store screenshots at Apple's required iPhone sizes.
 *
 * Renders the REAL production build on localhost with the native User-Agent, so
 * the store gating (no price, no checkout) applies exactly as it does in the app.
 *
 * `SHOTS_SIZE=6.9` (default) or `6.5`. App Store Connect has a separate upload
 * box per display size and REJECTS anything whose pixel dimensions don't match
 * that box exactly — a 6.9" shot dropped on the 6.5" box is an error, not a
 * resize. 6.9" is the one Apple requires; 6.5" is optional and is what older
 * devices' store pages show.
 */
import { chromium } from "playwright-core";

const BASE = "http://localhost:3100";
const OUT = process.env.SHOTS_OUT ?? "/tmp/camphawk-shots";

/** CSS viewport x deviceScaleFactor must land exactly on an accepted size. */
const SIZES = {
  // 440 x 956 at 3x = 1320 x 2868.
  "6.9": { width: 440, height: 956, scale: 3 },
  // 428 x 926 at 3x = 1284 x 2778.
  "6.5": { width: 428, height: 926, scale: 3 },
} as const;

const SIZE_KEY = (process.env.SHOTS_SIZE ?? "6.9") as keyof typeof SIZES;
const SIZE = SIZES[SIZE_KEY];
if (!SIZE) throw new Error(`SHOTS_SIZE must be one of ${Object.keys(SIZES).join(", ")}`);

const VIEWPORT = { width: SIZE.width, height: SIZE.height };
const SCALE = SIZE.scale;

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 CampHawkApp";

const shots: { name: string; path: string; settle?: number; scrollTo?: number }[] = [
  { name: "01-home", path: "/", settle: 3000 },
  {
    name: "02-openings",
    path: "/search?lat=47.03790&lng=-122.90070&place=Olympia%2C%20Washington&radius=50&start=2026-08-21&end=2026-08-23",
    // A live availability sweep across a 50-mile radius takes longer than it
    // looks. At 6s the button still said "Searching..." and the first result
    // card was an empty placeholder — fine for a smoke test, unusable as a
    // store screenshot. Wait for the search to actually finish.
    settle: 14000,
    // Past the form, onto the results — the payoff, not the input. Landing on a
    // card boundary matters: 1450 sliced the first card in half.
    scrollTo: 1330,
  },
  {
    name: "03-search",
    path: "/search?lat=47.03790&lng=-122.90070&place=Olympia%2C%20Washington&radius=50&start=2026-08-21&end=2026-08-23",
    settle: 14000,
  },
  // NOT the campground detail page. Its photo strip loads from recreation.gov's
  // CDN and the map from Mapbox, neither of which a sandboxed browser can reach —
  // the page renders with a tall blank gap where the photos belong. That one has
  // to be captured on a real device, or from a machine with open network access.
];

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: SCALE,
  userAgent: UA,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message.slice(0, 120)));

for (const s of shots) {
  await page.goto(BASE + s.path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(s.settle ?? 3000);
  if (s.scrollTo) {
    await page.evaluate((y) => window.scrollTo(0, y), s.scrollTo);
    await page.waitForTimeout(1200);
  }
  const file = `${OUT}/${s.name}.png`;
  await page.screenshot({ path: file });
  const box = await page.evaluate(() => ({
    prices: /\$\d/.test(document.body.innerText),
    // A shot captured mid-request shows "Searching..." and empty result cards.
    // It is not an error, which is exactly why it slipped through once.
    loading: /Searching\.\.\./.test(document.body.innerText),
    text: document.body.innerText.slice(0, 90).replace(/\s+/g, " "),
  }));
  console.log(
    `${s.name}: saved | price text: ${box.prices} | still loading: ${box.loading} | "${box.text}"`,
  );
}

await browser.close();
