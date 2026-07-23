import Link from 'next/link';
import Logo from '@/components/Logo';
import ManageWatch from '@/components/ManageWatch';

// Public per-watch manage page — authorized by the magic-link token in the URL
// (same model as the /w/ action links), so a tapped SMS opens it with no login.
export const dynamic = 'force-dynamic';

export default async function ManageWatchPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header — the page usually opens from a tapped SMS, so the logo doubles as
          the way back to CampHawk. */}
      <header className="border-b border-gray-200 bg-white/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center justify-between">
          <Link
            href="/"
            aria-label="Go to CampHawk"
            className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
          >
            <Logo markSize={32} />
          </Link>
          <span className="text-xs font-medium text-gray-400">Manage watch</span>
        </div>
      </header>

      <div className="mx-auto max-w-lg px-4 py-8">
        <ManageWatch token={token} />
      </div>
    </main>
  );
}
