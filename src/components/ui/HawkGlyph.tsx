/**
 * HawkGlyph — the small-size brand mark.
 *
 * The full badge (src/components/Logo.tsx `HawkMark`) packs a hawk, two mountain
 * ridges, a lake and a reflection into 64px. That reads fine at 34px in the
 * header and turns to mud at favicon and app-icon sizes, which is what the
 * handoff brief flagged. This is the bird alone: one path, no scene, no
 * gradient, so it survives 16px.
 *
 * The silhouette is the same path as the badge's hawk, scaled and centred to
 * fill a square viewBox rather than sitting in the badge's upper third — so the
 * two marks are recognisably the same bird, not two different drawings.
 *
 * Colour comes from `currentColor` in glyph mode, so it inherits wherever it's
 * placed. `variant="badge"` adds the rounded green tile for the app icon, where
 * a bare silhouette on the OS background would lose its shape.
 */
interface HawkGlyphProps {
  size?: number;
  /** "glyph" = bare silhouette (favicon, inline). "badge" = tile behind it (app icon). */
  variant?: "glyph" | "badge";
  className?: string;
  /** Omit to keep it decorative; supply when the mark is the only label. */
  title?: string;
}

// A soaring raptor seen from below: head, body tapering to a tail, and two
// swept wings. Drawn as separate shapes rather than the badge's single path.
//
// The badge's hawk CANNOT be reused here. Lifted out of its scene it reads as a
// conifer — the wings form a triangular mass with the tail as a trunk, and with
// no sky or ridgeline for context the eye lands on "pine tree", which is a
// disastrous misread for a camping brand. A head and a visible gap between the
// wings are what force the bird reading at 16px.
const HEAD = "M32 11.6a5 5 0 1 1 0 10 5 5 0 0 1 0-10z";
// Short, broad tail. A long thin one reads as a trunk and drags the whole mark
// back toward the tree misread.
const BODY = "M28.2 20.6h7.6l-2.2 17.2a1.6 1.6 0 0 1-3.2 0L28.2 20.6z";
// Thick enough to hold ink at 16px — thin wings break up and grey out.
const WING_L = "M29 22.4C21.6 17.8 11.4 16.6 2 21.8c8.8.9 14.6 4 19 8.8l8 8.6V22.4z";
const WING_R = "M35 22.4C42.4 17.8 52.6 16.6 62 21.8c-8.8.9-14.6 4-19 8.8l-8 8.6V22.4z";

export default function HawkGlyph({
  size = 32,
  variant = "glyph",
  className,
  title,
}: HawkGlyphProps) {
  const badge = variant === "badge";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : "true"}
    >
      {title ? <title>{title}</title> : null}
      {badge && <rect width="64" height="64" rx="14" fill="var(--color-ch-green, #1E7A4C)" />}
      {/* Nudged up and in so the wingspan clears the tile's rounded corners. */}
      <g
        transform={badge ? "translate(32 30) scale(0.82) translate(-32 -30)" : undefined}
        fill={badge ? "#FFFFFF" : "currentColor"}
      >
        <path d={HEAD} />
        <path d={BODY} />
        <path d={WING_L} />
        <path d={WING_R} />
      </g>
    </svg>
  );
}
