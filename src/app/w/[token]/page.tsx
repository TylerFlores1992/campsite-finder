import Link from 'next/link';
import { performAction } from '@/lib/notifications/actions';

// Public one-tap action landing (feature D): a tapped alert link lands here, the
// action is performed, and we show a small confirmation with the inverse action.
// Acting on load mirrors unsubscribe links; every action is reversible, so an
// accidental email-client prefetch is harmless.
export const dynamic = 'force-dynamic';

export default async function WatchActionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await performAction(token);

  const inverseLabel =
    result.action === 'stop' || result.action === 'cancel'
      ? 'Reopen this watch'
      : result.action === 'reopen'
        ? 'Stop watching'
        : result.action === 'keep'
          ? 'Stop watching'
          : null;

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
        <div className="text-3xl mb-3">{result.ok ? '✅' : '⚠️'}</div>
        <h1 className="text-lg font-semibold text-gray-800 mb-2">
          {result.ok ? 'Done' : 'Hmm'}
        </h1>
        <p className="text-gray-600">{result.message}</p>

        {result.ok && result.inverseUrl && inverseLabel && (
          <a
            href={result.inverseUrl}
            className="inline-block mt-6 px-5 py-2.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700"
          >
            {inverseLabel}
          </a>
        )}

        <div className="mt-6">
          <Link href="/" className="text-sm text-gray-400 hover:text-gray-600">Back to CampHawk</Link>
        </div>
      </div>
    </main>
  );
}
