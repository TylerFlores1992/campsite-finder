import Link from "next/link";
import {
  campgroundOpeningsBody,
  campgroundOpeningsHeading,
  campgroundPlace,
} from "@/lib/seo";
import { supportsAutoCart } from "./providers";
import type { Campground } from "@/lib/types";

/**
 * "Is <campground> fully booked?" — the body copy the cancellation retarget
 * rests on. See the header of `lib/seo.ts` for why the pages were retargeted at
 * all; this is the half that makes the new title honest.
 *
 * A SERVER COMPONENT, ON PURPOSE, AND THAT IS THE WHOLE POINT.
 * `CampgroundDetail` is a client component. Next still server-renders its first
 * pass, so a crawler does receive its markup today — but that is a property of
 * how it happens to be mounted, not a guarantee, and this repo has already paid
 * for that distinction once: these pages spent their whole first life shipping a
 * loading skeleton to Google because the detail view fetched in `useEffect`.
 * Putting the SEO-load-bearing prose in a component with no "use client" means
 * it cannot regress that way — there is no hook to add, no state to wait on, and
 * it stays out of the client bundle, which is bytes a search visitor on a phone
 * at a trailhead does not have to download to read a paragraph.
 *
 * PLACED BELOW THE CALENDAR, NEVER ABOVE IT. Someone who arrives from "kirk
 * creek campground cancellations" wants to see whether anything is open right
 * now; the availability grid is the answer and it must stay the first thing they
 * reach. This is what they read when the grid says no — which is the ordinary
 * case, and the moment the product becomes worth paying for. Keyword prose
 * ahead of the useful widget is the doorway-page pattern, and it would trade a
 * real ranking signal (people arriving and staying) for a fake one.
 *
 * IT LINKS OUT, because a leaf page with no exits wastes the one crawl it gets.
 * The state page is the internal-linking parent that carries equity down to
 * 6,934 leaves, and `/camping` is how a crawler finds the other 46 states.
 */
export interface CampgroundOpeningsProps {
  campground: Campground;
  /** The state landing page, when this campground's state has one — three
      states don't clear the minimum, and a link to a 404 is worse than none. */
  stateName?: string | null;
  stateSlug?: string | null;
}

export default function CampgroundOpenings({
  campground,
  stateName,
  stateSlug,
}: CampgroundOpeningsProps) {
  const place = campgroundPlace(campground);
  const paragraphs = campgroundOpeningsBody(
    campground.name,
    place,
    supportsAutoCart(campground.source),
  );

  return (
    <section className="mt-5 rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      {/* An h2, not an h1 — the campground's name is the h1 and must stay so.
          A page with two competing top-level headings tells Google it is about
          two things and it ranks for neither. */}
      <h2 className="font-ch-display text-ch-h font-bold text-ch-ink">
        {campgroundOpeningsHeading(campground.name)}
      </h2>

      <div className="mt-2 max-w-[70ch] space-y-3">
        {paragraphs.map((text) => (
          <p key={text.slice(0, 40)} className="text-ch-body leading-relaxed text-ch-ink-2">
            {text}
          </p>
        ))}
      </div>

      {stateName && stateSlug && (
        <p className="mt-4 text-ch-meta text-ch-muted">
          {"Also booked out? See "}
          <Link
            href={`/camping/${stateSlug}`}
            className="font-semibold text-ch-green hover:underline"
          >
            {`every ${stateName} campground we watch`}
          </Link>
          {", or "}
          <Link href="/camping" className="font-semibold text-ch-green hover:underline">
            browse by state
          </Link>
          {"."}
        </p>
      )}
    </section>
  );
}
