# Brand artwork

Web-ready assets, all committed:

| File | Size | Used for |
|---|---|---|
| `app-header.jpg` | 43 KB | Phone header band + desktop hero |
| `logo-badge.png` | 10 KB | Logo mark in the desktop header (transparent) |
| `hero-bg.webp` | 27 KB | Page backdrop — pale camp scene (**active**) |
| `hero-bg-alt.webp` | 61 KB | Page backdrop — valley scene (alternative) |

Originals live in `assets/brand-src/` and are NOT served. They were 632 KB and
1.8 MB; converting to webp cut them by ~96%, which matters because the backdrop
loads on every page. Regenerate with sharp:

```js
// pale camp scene — the source has white letterbox bars, so trim first
sharp('assets/brand-src/hero-bg-camp.png')
  .trim({ threshold: 6 }).resize({ width: 1600 }).webp({ quality: 72 })
  .toFile('public/brand/hero-bg.webp');

sharp('assets/brand-src/hero-bg-valley.png')
  .resize({ width: 1920, withoutEnlargement: true }).webp({ quality: 72 })
  .toFile('public/brand/hero-bg-alt.webp');
```

Switch backdrops with `VARIANT` in `src/components/v2/BrandBackdrop.tsx`.

Notes:
- `app-header.jpg` carries the wordmark on its left edge and the tagline on its
  right. The phone band uses object-contain so neither is clipped; the desktop
  hero crops to object-top, which removes the baked-in lockup deliberately (the
  desktop nav already shows the wordmark) and leaves clean scenery for the
  overlaid headline.
- The backdrop's scrim was tuned against real cards. 78% looked flat — 45% plus
  a local top wash keeps the art visible while page headings stay readable.
