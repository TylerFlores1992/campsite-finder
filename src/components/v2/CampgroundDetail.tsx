"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import Tag from "@/components/ui/Tag";
import { buttonClasses } from "@/components/ui/Button";
import AvailabilityGrid from "./AvailabilityGrid";
import WatchCta from "./WatchCta";
import { providerLabel, supportsAutoCart } from "./providers";
import type { Campground } from "@/lib/types";

/**
 * Campground detail — a drill-in, not a nav destination.
 *
 * KEEPS WHAT THE MOCKUP DROPPED. The handoff detail screen showed a calendar and
 * a site list only; the live page also carries photos, amenities and contact
 * info. Porting the mockup literally would have deleted all of that, so those
 * blocks are here, restyled. A redesign shouldn't quietly remove content.
 */
export interface CampgroundDetailProps {
  campgroundId: string;
  /** Dates carried from the search, so the calendar opens where the user was. */
  startDate?: string;
  endDate?: string;
}

export default function CampgroundDetail({
  campgroundId,
  startDate,
  endDate,
}: CampgroundDetailProps) {
  const [campground, setCampground] = useState<Campground | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [brokenPhotos, setBrokenPhotos] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/campgrounds/${encodeURIComponent(campgroundId)}`)
      .then((r) => {
        if (r.status === 404) throw new Error("We don't have this campground.");
        if (!r.ok) throw new Error(`Couldn't load this campground (${r.status})`);
        return r.json();
      })
      .then((j: { campground: Campground }) => {
        if (!cancelled) setCampground(j.campground);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campgroundId]);

  if (loading) {
    return (
      <div className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
        <div className="h-8 w-40 animate-pulse rounded bg-ch-line motion-reduce:animate-none" />
        <div className="mt-4 h-[420px] animate-pulse rounded-ch-card bg-ch-card motion-reduce:animate-none" />
      </div>
    );
  }

  if (error || !campground) {
    return (
      <div className="mx-auto max-w-[var(--ch-max)] px-5 py-10">
        <h1 className="font-ch-display text-ch-title font-extrabold">Not found</h1>
        <p className="mt-2 text-ch-body text-ch-muted">{error}</p>
        <Link href="/v2" className={buttonClasses({ variant: "quiet", className: "mt-4" })}>
          Back to search
        </Link>
      </div>
    );
  }

  const { name, address, source, photos, amenities, phone, description } = campground;
  const place = [address?.city, address?.state].filter(Boolean).join(", ");
  const month = startDate?.slice(0, 7);
  const livePhotos = (photos ?? []).filter((p) => !brokenPhotos.has(p.url));

  return (
    <div className="mx-auto max-w-[var(--ch-max)] px-5 py-5">
      <Link
        href="/v2"
        className="inline-flex items-center gap-1 pb-3 text-[13px] font-bold text-ch-green hover:text-ch-green-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        Back to search
      </Link>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {supportsAutoCart(source) && <Tag kind="cart">Auto-cart</Tag>}
            <Tag kind="src">{providerLabel(source, campgroundId)}</Tag>
          </div>
          <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">{name}</h1>
          {place && <p className="mt-1 text-ch-meta text-ch-muted">{place}</p>}
        </div>
        {/* Same gate as the result cards — one component so a non-subscriber
            can't reach the New watch screen from here while being stopped
            everywhere else. */}
        <WatchCta
          campgroundId={campgroundId}
          startDate={startDate}
          endDate={endDate}
          fullWidth={false}
          className="px-5"
          label="Watch this campground"
        />
      </div>

      {/* Photo URLs come from the provider catalogs and DO rot — a dead one used
          to leave a broken icon in a large empty block. Failures drop out of the
          strip, and the strip disappears entirely if they all fail, rather than
          reserving space for nothing. */}
      {livePhotos.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {livePhotos.slice(0, 4).map((p, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${p.url}-${i}`}
              src={p.url}
              alt={p.title ?? `${name} photo ${i + 1}`}
              loading="lazy"
              onError={() => setBrokenPhotos((prev) => new Set(prev).add(p.url))}
              className={cxImg(i)}
            />
          ))}
        </div>
      )}

      <AvailabilityGrid campgroundId={campgroundId} initialMonth={month} initialDay={startDate} />

      {(description || amenities?.length > 0 || phone) && (
        <section className="mt-5 rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
          <h2 className="font-ch-display text-ch-h font-bold">About</h2>
          {description && (
            <p className="mt-2 max-w-[70ch] text-ch-body leading-relaxed text-ch-ink-2">
              {description}
            </p>
          )}
          {amenities?.length > 0 && (
            <>
              <h3 className="mt-4 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
                Amenities
              </h3>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {amenities.map((a) => (
                  <li
                    key={a}
                    className="rounded-ch-chip border border-ch-line px-3 py-1.5 text-ch-meta text-ch-ink-2 capitalize"
                  >
                    {a}
                  </li>
                ))}
              </ul>
            </>
          )}
          {phone && (
            <p className="mt-4 text-ch-body text-ch-ink-2">
              <span className="text-ch-muted">Phone: </span>
              <a className="font-semibold text-ch-green hover:underline" href={`tel:${phone}`}>
                {phone}
              </a>
            </p>
          )}
        </section>
      )}

      {/* End date is carried through so a later "watch these dates" prefill has it. */}
      {endDate && <span className="sr-only">Selected checkout {endDate}</span>}
    </div>
  );
}

/** First photo runs wide on larger screens; the rest are square thumbs. */
function cxImg(i: number): string {
  return i === 0
    ? "col-span-2 h-32 w-full rounded-ch-input object-cover sm:h-36"
    : "h-32 w-full rounded-ch-input object-cover sm:h-36";
}
