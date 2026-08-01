// Every Play Store graphic asset, regenerable in one command.
//
//   npx tsx scripts/play-assets.mts [--outDir=.play-assets]
//
// Play needs the 512×512 icon and the 1024×500 feature graphic as separate uploads from
// anything the app itself ships, and neither has an Apple equivalent, so nothing in the
// iOS pipeline produces them. Both come from committed brand sources, so a re-run always
// matches the app rather than drifting toward whatever was uploaded by hand once.
//
// Screenshots are NOT here and cannot be: the sandbox reaches neither Mapbox nor
// recreation.gov's photo CDN, so every map and photo strip renders blank. They are
// captured on a physical device — see docs/PLAY-STORE.md §3.

import sharp from 'sharp';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

const outDir = resolve(
  process.argv.find((a) => a.startsWith('--outDir='))?.split('=')[1] ?? '.play-assets'
);
mkdirSync(outDir, { recursive: true });

// --- 512×512 app icon ------------------------------------------------------------
// assets/icon-only.png is a clean 1024 square (the same source @capacitor/assets uses
// for the launcher icons), so this is a pure downscale — never upscale a store asset,
// the artefacts are obvious at listing size.
const iconOut = resolve(outDir, 'play-icon-512.png');
await sharp('assets/icon-only.png').resize(512, 512).png().toFile(iconOut);

// --- 1024×500 feature graphic ----------------------------------------------------
const W = 1024;
const H = 500;
const GREEN_DEEP = '#16603B';

// Fit the WHOLE lockup and give the caption its own band. Cover-resizing put the
// artwork's own wordmark behind the caption (ghosted text either side of the headline);
// cropping above that band left a 4.4:1 source being covered into 2.05:1, which zooms
// 2.4× and clips the eagle's wings. Both were rendered and rejected on 2026-08-01.
const ART_H = Math.round((295 / 900) * W); // 336
const artwork = await sharp('public/brand/app-header.jpg').resize(W, ART_H).toBuffer();

const caption = Buffer.from(`
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <text x="${W / 2}" y="${H - 78}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="46" font-weight="bold"
        fill="#FFFFFF">Campsite cancellation alerts</text>
  <text x="${W / 2}" y="${H - 34}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="25"
        fill="#CFE4D6">Checked every 15 seconds, around the clock</text>
</svg>`);

const featureOut = resolve(outDir, 'play-feature-graphic.png');
await sharp({ create: { width: W, height: H, channels: 4, background: GREEN_DEEP } })
  .composite([
    { input: artwork, top: 0, left: 0 },
    { input: caption, top: 0, left: 0 },
  ])
  .png()
  .toFile(featureOut);

for (const [label, file, want] of [
  ['icon', iconOut, '512×512'],
  ['feature graphic', featureOut, '1024×500'],
] as [string, string, string][]) {
  const m = await sharp(file).metadata();
  const got = `${m.width}×${m.height}`;
  console.log(`[play-assets] ${label.padEnd(16)} ${file}  ${got}`);
  if (got !== want) {
    console.error(`  WRONG SIZE — Play requires exactly ${want}`);
    process.exit(1);
  }
}
