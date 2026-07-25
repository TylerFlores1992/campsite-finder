# App icon & splash sources (Capacitor)

These are the **source** images the `@capacitor/assets` pipeline expands into every
per-platform icon/splash size inside `ios/` and `android/`. They're generated from
`public/logo-badge.png` (the CampHawk hawk-over-landscape badge) on a cream `#faf7f2`
ground — see the sharp recipe in the commit that added this folder if you need to
regenerate.

| File | Size | Used for |
|------|------|----------|
| `icon-only.png` | 1024² | iOS app icon + Android legacy icon. **Opaque, no alpha** (App Store rejects icons with an alpha channel). |
| `icon-foreground.png` | 1024² | Android **adaptive** icon foreground (badge sits inside the ~64% safe zone so the launcher mask never clips it). Transparent. |
| `icon-background.png` | 1024² | Android adaptive icon background (solid cream). |
| `splash.png` | 2732² | Light launch screen — badge centered with wide safe padding so any device crop still shows it. |
| `splash-dark.png` | 2732² | Dark-mode launch screen (badge on deep forest green). |

## Applying them

Runs on the build machine, **after** the native projects exist:

```
npx cap add ios      # and/or: npx cap add android
npm run cap:assets   # = npx @capacitor/assets generate --assetPath assets
npm run cap:sync
```

`cap:assets` writes the generated icons/splash into `ios/` and `android/` (both
git-ignored). Re-run it whenever these sources change. See `docs/SETUP.md` →
"Building the mobile app".
