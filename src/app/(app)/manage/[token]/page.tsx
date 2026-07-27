import type { Metadata } from "next";
import ManageWatch from "@/components/v2/ManageWatch";

/**
 * NEVER INDEXED, and this is the one place it genuinely matters: the URL
 * contains the magic-link token that authorises managing the watch. A token in
 * the index is a token anyone can use.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Per-watch manage screen, in the redesign.
 *
 * Token-authorized like the old /manage/<token>, so a link from an SMS still
 * works with no login. The token is only passed through here — every op is
 * scoped server side in /api/manage/<token>.
 */
export default async function V2ManagePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ManageWatch token={token} />;
}
