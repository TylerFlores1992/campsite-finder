import ManageWatch from '@/components/ManageWatch';

// Public per-watch manage page — authorized by the magic-link token in the URL
// (same model as the /w/ action links), so a tapped SMS opens it with no login.
export const dynamic = 'force-dynamic';

export default async function ManageWatchPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="max-w-lg mx-auto">
        <ManageWatch token={token} />
      </div>
    </main>
  );
}
