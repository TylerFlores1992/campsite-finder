# Brand artwork

Drop the three supplied images here with these exact names. Each has a working
fallback until then, so the app is never broken by a missing file.

| File | Used for | Wire-up |
|---|---|---|
| `hero-bg.png` | Page background (pale hawk-over-valley scene) | set `HAS_BRAND_ART = true` in `src/components/v2/BrandBackdrop.tsx` |
| `logo-badge.png` | Logo mark in the header (framed hawk badge, transparent) | set `HAS_BRAND_ART = true` in `src/components/v2/BrandMark.tsx` |
| `app-header.png` | Wide header art on Available now (hawk + "CampHawk / Find your next adventure") | set `HAS_BRAND_ART = true` in `src/components/v2/BrandHeader.tsx` |

Notes:
- Prefer `.webp` for the two large ones if you can export it — the handoff brief
  asks for webp, and `hero-bg.png` is full-bleed so its weight is on every page.
  If you do, change the extension in the component alongside the flag.
- `logo-badge.png` needs a transparent background; it sits on white chrome.
- `app-header.png` is cropped with `object-cover`, so the hawk should sit in the
  middle third horizontally or it will be trimmed on narrow screens.
