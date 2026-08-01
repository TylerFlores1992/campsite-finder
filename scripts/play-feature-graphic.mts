// Google Play's FEATURE GRAPHIC — 1024×500, required, and the one store asset with no
// Apple equivalent, so nothing in docs/APP-STORE.md covers it.
//
//   npx tsx scripts/play-feature-graphic.mts [--out=path]
//
// Built from the real brand artwork (`public/brand/app-header.jpg`, the same lockup the
// app header uses) rather than a mock, so the listing and the app agree. The source is
// 900×295 and the target is 1024×500 — a different aspect ratio — so it is scaled to
// COVER and anchored to the bottom, which is where the wordmark and tagline live; a
// plain resize would letterbox or crop the lockup off.
//
// Play rejects feature graphics that carry device frames, screenshots, or claims that
// duplicate store metadata, so this deliberately adds ONE line of text and nothing else.
// It must also read at thumbnail size, hence the large type and the scrim.

import sharp from 'sharp';
import { resolve } from 'path';

const W = 1024;
const H = 500;
const GREEN_DEEP = '#16603B';

const out = resolve(
  process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? 'play-feature-graphic.png'
);

// The tagline sits in a scrim so it stays legible over whatever part of the artwork
// lands behind it. Kept to one short line: at the size Play renders this in a list,
// anything longer is unreadable and reads as clutter.
const overlay = Buffer.from(`
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <text x="${W / 2}" y="${H - 78}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="46" font-weight="bold"
        fill="#FFFFFF">Campsite cancellation alerts</text>
  <text x="${W / 2}" y="${H - 34}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="25"
        fill="#CFE4D6">Checked every 15 seconds, around the clock</text>
</svg>`);

// FIT THE WHOLE ARTWORK, DON'T CROP INTO IT. Two earlier attempts failed in instructive
// ways: cover-resizing the full 900×295 put its own wordmark band behind this graphic's
// caption ("apHawk" and "FIND YOUR NEXT" ghosting either side of the headline), and
// cropping above that band left a source 4.4:1 wide being covered into a 2.05:1 box,
// which zooms 2.4× and amputates the eagle's wings.
//
// So: scale the artwork to the full width, keep the entire lockup intact, sit it at the
// top, and let the leftover green band at the bottom carry the caption. Nothing overlaps
// anything, and the brand mark on the listing is the same one in the app header.
const ART_H = Math.round((295 / 900) * W); // 336 — the artwork at full width
const artwork = await sharp('public/brand/app-header.jpg').resize(W, ART_H).toBuffer();

const base = await sharp({
  create: { width: W, height: H, channels: 4, background: GREEN_DEEP },
})
  .composite([{ input: artwork, top: 0, left: 0 }])
  .png()
  .toBuffer();

await sharp(base)
  .composite([{ input: overlay, top: 0, left: 0 }])
  .png()
  .toFile(out);

const meta = await sharp(out).metadata();
console.log(`[feature-graphic] ${out} — ${meta.width}×${meta.height} ${meta.format}`);
if (meta.width !== W || meta.height !== H) {
  console.error('WRONG SIZE — Play requires exactly 1024×500');
  process.exit(1);
}
