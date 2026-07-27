"use client";

import { useIsNativeApp } from "@/lib/native/context";

/**
 * Full-page background artwork.
 *
 * Fixed behind everything so scrolling doesn't drag a large image around, with
 * three layers tuned by eye against real cards:
 *
 *  1. a 45% ch-paper scrim — enough to calm the art, not so much that it
 *     disappears. The first attempt used 78% and the page looked flat again,
 *     which defeated the point of having a background at all.
 *  2. a TOP wash, because the artwork's hawk crosses exactly where page
 *     headings and their muted subtitles sit. Local, so the sides and bottom
 *     keep the scenery.
 *  3. a bottom fade, because the results grid runs long and by then the art is
 *     just noise behind content.
 *
 * Cards are opaque, so only page-level text ever sits directly on this.
 *
 * OFF ON PHONES AND IN THE NATIVE APP. At desktop widths the art has room to be
 * scenery; at 390px the same image sits right behind the controls and the screen
 * reads as congested. Two separate switches because they answer different
 * questions: the `sm:` breakpoint handles a narrow browser window, and the
 * native check handles a tablet running the app, which is wide but should still
 * look like an app rather than a website.
 */

/** Set false to fall back to the flat ch-paper ground. */
export const HAS_BRAND_ART = true;

/**
 *  "camp"   — pale square scene: hawk, river, tent. Low contrast, sits under
 *             content easily. Source had white letterbox bars, trimmed before
 *             conversion.
 *  "valley" — wider mountain-and-river scene. Richer, so it takes a heavier
 *             scrim and gives less back for it.
 */
const VARIANT: "camp" | "valley" = "camp";

const ART = {
  camp: { url: "/brand/hero-bg.webp", scrim: 0.45, position: "center 22%" },
  valley: { url: "/brand/hero-bg-alt.webp", scrim: 0.6, position: "center 30%" },
} as const;

const PAPER = "245, 247, 242"; // --ch-paper

export default function BrandBackdrop() {
  const art = ART[VARIANT];
  const isNative = useIsNativeApp();

  return (
    // The paper ground lives HERE, not on the layout wrapper. An opaque wrapper
    // painted straight over this fixed layer, so the artwork only appeared in
    // the strip below the footer on short pages. Rendering the base colour here
    // means the layout can stay transparent and the page still has a ground even
    // with the art switched off.
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 bg-ch-paper">
      {!HAS_BRAND_ART || isNative ? null : (
        // hidden below sm — the paper ground above is all a phone gets.
        <div className="hidden sm:block">
      <div
        className="absolute inset-0 bg-cover bg-no-repeat"
        style={{ backgroundImage: `url('${art.url}')`, backgroundPosition: art.position }}
      />
      <div className="absolute inset-0" style={{ background: `rgba(${PAPER}, ${art.scrim})` }} />
      <div
        className="absolute inset-x-0 top-0 h-[240px]"
        style={{
          background: `linear-gradient(to bottom, rgba(${PAPER},.92), rgba(${PAPER},0))`,
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[45%]"
        style={{
          background: `linear-gradient(to bottom, rgba(${PAPER},0), rgba(${PAPER},.95))`,
        }}
      />
        </div>
      )}
    </div>
  );
}
