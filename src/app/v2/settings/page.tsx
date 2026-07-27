import type { Metadata } from "next";
import Settings from "@/components/v2/Settings";

export const metadata: Metadata = {
  title: "Settings — CampHawk",
  robots: { index: false, follow: false },
};

/**
 * Settings. Not a nav destination — it's reached from the account menu, the
 * same place people already look for it — but it IS a real route, so it can be
 * linked to from the nudges that send people here.
 */
export default function V2SettingsPage() {
  return (
    <div className="mx-auto max-w-[46rem] px-5 py-6">
      <h1 className="mb-4 font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
        Settings
      </h1>
      <Settings />
    </div>
  );
}
