/**
 * Desktop hero for Available now.
 *
 * DESKTOP ONLY. On phones the collapsing band in V2Nav carries the same
 * artwork; rendering both would show it twice.
 *
 * The art is 3.05:1. At the 1120px content width that is 367px tall, far too
 * much for a page header, so it is cropped to a band with object-cover. That
 * crop removes the artwork's own "CampHawk / Find your next adventure" lockup
 * (baked into its left and right edges) — which is fine here, because the
 * desktop nav already carries the wordmark, and it frees the band to be pure
 * scenery with OUR headline over it.
 *
 * The first version left the band silent: cropped art, no text, then the search
 * rail. That read as decoration nobody asked for. A headline over a scrim gives
 * the page something to say at the point where the eye lands.
 */

/** Set to true once public/brand/app-header.jpg is committed. */
export const HAS_BRAND_ART = true;

export interface BrandHeaderProps {
  title: string;
  subtitle?: string;
}

export default function BrandHeader({ title, subtitle }: BrandHeaderProps) {
  if (!HAS_BRAND_ART) {
    return (
      <section className="hidden border-b border-ch-line bg-[#24382A] sm:block">
        <div className="mx-auto max-w-[var(--ch-max)] px-5 py-12">
          <h1 className="max-w-[18ch] font-ch-display text-[clamp(26px,5vw,var(--text-ch-hero))] font-extrabold leading-[1.08] tracking-[-.035em] text-white">
            {title}
          </h1>
          {subtitle && <p className="mt-3 max-w-[52ch] text-[14.5px] text-white/90">{subtitle}</p>}
        </div>
      </section>
    );
  }

  return (
    <section className="relative hidden border-b border-ch-line bg-[#24382A] sm:block">
      <div className="relative h-[230px] w-full overflow-hidden lg:h-[260px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {/* object-TOP, not center. The artwork's own wordmark and tagline sit
            along its bottom edge; a centred crop leaves them half-visible under
            our headline, so the page shows the brand twice and neither cleanly.
            Anchoring to the top keeps the sky, the hawk and the peaks — pure
            scenery — and pushes the baked-in lockup out of frame entirely. */}
        <img
          src="/brand/app-header.jpg"
          alt=""
          className="size-full object-cover object-top"
        />
        {/* Left-weighted scrim: keeps the headline legible without flattening
            the whole image, so the hawk and the valley still read on the right. */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#16291F]/85 via-[#16291F]/45 to-transparent" />

        <div className="absolute inset-0">
          <div className="mx-auto flex h-full max-w-[var(--ch-max)] flex-col justify-center px-5">
            <h1 className="max-w-[16ch] font-ch-display text-[clamp(26px,3.4vw,var(--text-ch-hero))] font-extrabold leading-[1.06] tracking-[-.035em] text-white drop-shadow-[0_2px_16px_rgba(10,26,18,.55)]">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-3 max-w-[46ch] text-[14.5px] leading-relaxed text-white/92 drop-shadow-[0_1px_10px_rgba(10,26,18,.6)]">
                {subtitle}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
