import type { Metadata } from "next";
import Settings from "@/components/v2/Settings";
import { currentUserIsAdmin } from "@/lib/admin";

export const metadata: Metadata = {
  title: "Settings — CampHawk",
  // Private to the account.
  robots: { index: false, follow: false },
};

/**
 * Settings. Not a nav destination — it's reached from the account menu, the
 * same place people already look for it — but it IS a real route, so it can be
 * linked to from the nudges that send people here.
 */
export default async function V2SettingsPage() {
  // Resolved on the SERVER and handed down as a boolean. Settings is a client
  // component, so doing this there would mean shipping the admin allowlist —
  // or a hardcoded email — into the JS bundle, which is what the old homepage
  // does. The /admin page enforces access itself regardless; this only decides
  // whether the link is drawn.
  const isAdmin = await currentUserIsAdmin();

  return (
    <div className="mx-auto max-w-[46rem] px-5 py-6">
      <h1 className="mb-4 font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
        Settings
      </h1>
      <Settings isAdmin={isAdmin} />
    </div>
  );
}
