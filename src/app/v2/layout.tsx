import type { Metadata } from "next";
import V2Nav from "@/components/v2/V2Nav";
import BrandBackdrop from "@/components/v2/BrandBackdrop";

/**
 * /v2 — the redesigned UI, dark-launched.
 *
 * Nothing in the live app links here. The old routes are untouched, so users see
 * no change until the final swap moves these over the top of them. That swap is
 * one small, revertible commit; until then both UIs run side by side on master,
 * which is what the additive ch-* token layer was built to allow.
 *
 * NOT indexed while it's a work in progress — two copies of the same content in
 * the index would compete with the real pages for ranking.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function V2Layout({ children }: { children: React.ReactNode }) {
  return (
    // font-ch-body scopes the redesign typography to this subtree, so the live
    // app keeps Inter/Sora while /v2 renders in Nunito Sans + Bitter.
    // No background colour here: BrandBackdrop is a fixed layer behind the page,
    // and an opaque wrapper paints straight over it — the artwork only showed in
    // the strip below the footer on short pages. The backdrop supplies the ground.
    // min-h-dvh, NOT min-h-full: percentage heights need every ancestor to have
    // one, and html/body don't, so min-h-full collapsed to the content height and
    // left the footer parked mid-screen on short pages. dvh also tracks mobile
    // browser chrome, which vh does not.
    <div className="flex min-h-dvh flex-col font-ch-body text-ch-ink">
      <BrandBackdrop />
      <V2Nav />
      <main className="flex-1">{children}</main>
      <footer className="mt-auto border-t border-ch-line bg-[#EEF1EB]">
        <div className="mx-auto flex max-w-[var(--ch-max)] flex-wrap items-center justify-between gap-4 px-5 py-5 text-ch-fine text-ch-muted">
          <span>© 2026 CampHawk</span>
          <span className="flex gap-4">
            <a className="hover:text-ch-ink-2" href="/terms">Terms</a>
            <a className="hover:text-ch-ink-2" href="/privacy">Privacy</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
