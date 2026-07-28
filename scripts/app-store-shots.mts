/**
 * App Store screenshots at Apple's 6.9" size (1320 x 2868).
 *
 * Renders the REAL production build on localhost with the native User-Agent, so
 * the store gating (no price, no checkout) applies exactly as it does in the app.
 */
import { chromium } from "playwright-core";

const BASE = "http://localhost:3100";
const OUT = process.env.SHOTS_OUT ?? "/tmp/camphawk-shots";

// 6.9" iPhone: 440 x 956 CSS at 3x = 1320 x 2868 device pixels.
const VIEWPORT = { width: 440, height: 956 };
const SCALE = 3;

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 CampHawkApp";

const shots: { name: string; path: string; settle?: number; scrollTo?: number }[] = [
  { name: "01-home", path: "/", settle: 3000 },
  {
    name: "02-openings",
    path: "/search?lat=47.03790&lng=-122.90070&place=Olympia%2C%20Washington&radius=50&start=2026-08-21&end=2026-08-23",
    settle: 6000,
    // Past the form, onto the results — the payoff, not the input.
    scrollTo: 1450,
  },
  {
    name: "03-search",
    path: "/search?lat=47.03790&lng=-122.90070&place=Olympia%2C%20Washington&radius=50&start=2026-08-21&end=2026-08-23",
    settle: 6000,
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
    text: document.body.innerText.slice(0, 90).replace(/\s+/g, " "),
  }));
  console.log(`${s.name}: saved | price text present: ${box.prices} | "${box.text}"`);
}

await browser.close();
