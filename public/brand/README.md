# Brand artwork

| File | Status | Used for |
|---|---|---|
| `app-header.jpg` | **present** | Phone header band + desktop hero on Available now |
| `logo-badge.png` | **present** | Logo mark in the desktop header (transparent, tRNS) |
| `hero-bg.png` | **MISSING** | Full-page background (the pale hawk-over-valley scene) |

The header and logo were recovered from the base64 embedded in the supplied
mobile HTML. The background was not in that file — drop it here as
`hero-bg.png`, then set `HAS_BRAND_ART = true` in
`src/components/v2/BrandBackdrop.tsx`. Until then the app uses its flat
ch-paper ground, which is a deliberate design rather than a broken one.

Notes:
- `app-header.jpg` carries the wordmark on its left edge and the tagline on its
  right, so it is rendered with `object-contain` while expanded — any horizontal
  crop clips one of them ("ampHawk" at narrow widths). Keep that in mind if the
  image is ever re-exported: moving the text inward would allow `object-cover`
  and a tighter band.
- A `.webp` export of the two large files would be worth doing; the handoff
  brief asks for it and `hero-bg` in particular sits on every page.
