/**
 * Page hero for Available now.
 *
 * TEXT ONLY, ON THE BACKDROP. This used to stretch app-header.jpg across a
 * full-bleed band, which was wrong twice over:
 *
 *  1. That file is 900px wide. Filling a 1900px viewport upscaled it past 2x —
 *     visibly soft, with a single wing blown up across the whole width. Artwork
 *     can't be asked to do a job its resolution doesn't support.
 *  2. Once BrandBackdrop landed, the band was a second image competing with the
 *     one already behind the whole page. Two pieces of scenery stacked on top of
 *     each other read as clutter, not richness.
 *
 * So the hero is now type over the backdrop. The imagery is still there — it's
 * just the page's, and it stays sharp because nothing is being stretched.
 *
 * app-header.jpg is still used at its natural size in the phone header band,
 * where 900px is more than enough.
 */

export interface BrandHeaderProps {
  title: string;
  subtitle?: string;
}

export default function BrandHeader({ title, subtitle }: BrandHeaderProps) {
  return (
    <section className="mx-auto max-w-[var(--ch-max)] px-5 pt-8 pb-2 sm:pt-14 sm:pb-4">
      <h1 className="max-w-[15ch] font-ch-display text-[clamp(28px,4.2vw,var(--text-ch-hero))] font-extrabold leading-[1.05] tracking-[-.035em] text-ch-ink">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-3 max-w-[54ch] text-[14.5px] leading-relaxed text-ch-ink-2">{subtitle}</p>
      )}
      {/* Short rule in the availability green — a small anchor so the type block
          doesn't float on the artwork with nothing holding it down. */}
      <div className="mt-5 h-[3px] w-14 rounded-full bg-ch-green" />
    </section>
  );
}
