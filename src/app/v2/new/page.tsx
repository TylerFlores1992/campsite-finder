import type { Metadata } from "next";
import NewWatch from "@/components/v2/NewWatch";

export const metadata: Metadata = {
  title: "New watch — CampHawk",
  robots: { index: false, follow: false },
};

export default async function V2NewWatchPage({
  searchParams,
}: {
  searchParams: Promise<{ campground?: string; start?: string; end?: string }>;
}) {
  const { campground, start, end } = await searchParams;

  return (
    <div className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
      <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">New watch</h1>
      <p className="mt-1 mb-4 text-ch-meta text-ch-muted">
        We check every 15 seconds and tell you the second it opens.
      </p>
      <NewWatch initialCampgroundId={campground} initialStart={start} initialEnd={end} />
    </div>
  );
}
