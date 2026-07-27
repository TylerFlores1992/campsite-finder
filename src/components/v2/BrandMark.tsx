/**
 * The brand mark, with a graceful fallback.
 *
 * Prefers the real badge artwork at /brand/logo-badge.png. Until that file
 * exists the drawn HawkGlyph stands in, so the header is never broken and
 * dropping the asset in is the only step needed to switch over — no code change.
 *
 * Sized in CSS rather than via next/image because the mark is decorative chrome
 * at a fixed small size; the layout cost of a broken load is zero either way.
 */
import HawkGlyph from "@/components/ui/HawkGlyph";

/** Set to true once public/brand/logo-badge.png is committed. */
export const HAS_BRAND_ART = true;

export default function BrandMark({ size = 26 }: { size?: number }) {
  if (!HAS_BRAND_ART) {
    return <HawkGlyph size={size} className="shrink-0 text-ch-green" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/logo-badge.png"
      alt=""
      width={size}
      height={size}
      className="shrink-0 select-none object-contain"
      draggable={false}
    />
  );
}
