/**
 * Full-page background artwork.
 *
 * Fixed and behind everything, so scrolling doesn't drag a large image around
 * and content never has to sit on a busy area. The supplied scene is very pale,
 * which is what makes this readable at all — a saturated background would fight
 * every card on top of it. A white scrim is layered over it anyway so text
 * contrast doesn't depend on the artwork staying pale if it's ever re-exported.
 *
 * Until public/brand/hero-bg.png exists this renders NOTHING and the app keeps
 * its flat ch-paper ground, which is a perfectly good design rather than a
 * broken one.
 */

/** Set to true once public/brand/hero-bg.png is committed. */
export const HAS_BRAND_ART = false;

export default function BrandBackdrop() {
  if (!HAS_BRAND_ART) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/brand/hero-bg.png')" }}
      />
      {/* Keeps body text at full contrast regardless of what's underneath. */}
      <div className="absolute inset-0 bg-ch-paper/82" />
    </div>
  );
}
