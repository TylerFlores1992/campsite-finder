import type { Metadata } from "next";
import WatchesList from "@/components/v2/WatchesList";

export const metadata: Metadata = {
  title: "Your watches — CampHawk",
  robots: { index: false, follow: false },
};

export default function V2WatchesPage() {
  return (
    <div className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
      <h1 className="mb-4 font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
        Your watches
      </h1>
      <WatchesList />
    </div>
  );
}
