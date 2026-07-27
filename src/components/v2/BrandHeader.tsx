/**
 * Wide header art for Available now.
 *
 * The supplied image already contains the "CampHawk / Find your next adventure"
 * lockup, so this does NOT overlay its own headline — printing a second one on
 * top would double the wordmark. The page's real <h1> is rendered visually
 * hidden instead, so the heading still exists for screen readers and search
 * engines while sighted users get the artwork's own typography.
 *
 * Falls back to the flat green band the hero shipped with, headline included,
 * so the page reads correctly before the asset lands.
 */

/** Set to true once public/brand/app-header.png is committed. */
export const HAS_BRAND_ART = false;

export interface BrandHeaderProps {
  /** The page heading. Visible in the fallback, sr-only over the artwork. */
  title: string;
  subtitle?: string;
}

export default function BrandHeader({ title, subtitle }: BrandHeaderProps) {
  if (!HAS_BRAND_ART) {
    return (
      <section className="border-b border-ch-line bg-[#24382A]">
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
    <section className="border-b border-ch-line bg-[#24382A]">
      {/* Shorter on phones so the art doesn't eat the fold before the search
          rail. object-cover with a centred focal point keeps the hawk in frame. */}
      <div className="relative h-[132px] w-full overflow-hidden sm:h-[190px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/app-header.png"
          alt=""
          className="size-full object-cover object-center"
        />
      </div>
      <h1 className="sr-only">{title}</h1>
      {subtitle && (
        <div className="mx-auto max-w-[var(--ch-max)] px-5 py-3">
          <p className="max-w-[52ch] text-[13.5px] text-white/90">{subtitle}</p>
        </div>
      )}
    </section>
  );
}
