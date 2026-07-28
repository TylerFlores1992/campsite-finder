import V2Nav from "@/components/v2/V2Nav";
import BrandBackdrop from "@/components/v2/BrandBackdrop";

/**
 * Chrome for the app itself — nav, backdrop, footer.
 *
 * A ROUTE GROUP, so it wraps /, /search, /watches, /new, /settings,
 * /campground/<id> and /manage/<token> without adding a path segment. The pages
 * that shouldn't carry app chrome stay outside it: /terms, /privacy, /connect,
 * the Clerk routes, /admin and the token action pages.
 *
 * The noindex that used to live here is GONE. It was what kept the dark launch
 * out of Google; removing it is what makes the server-rendered campground
 * pages, their per-page metadata and the JSON-LD actually count. If this file
 * ever regains a robots block, all of that silently stops working.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
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
            <a className="hover:text-ch-ink-2" href="/support">Support</a>
            <a className="hover:text-ch-ink-2" href="/terms">Terms</a>
            <a className="hover:text-ch-ink-2" href="/privacy">Privacy</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
