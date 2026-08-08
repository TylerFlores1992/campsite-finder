import Link from 'next/link';
import { performAction, previewHold } from '@/lib/notifications/actions';
import HoldConfirm from '@/components/v2/HoldConfirm';

// Public one-tap action landing (feature D): a tapped alert link lands here, the
// action is performed, and we show a small confirmation with the inverse action.
// Acting on load mirrors unsubscribe links; every action is reversible, so an
// accidental email-client prefetch is harmless.
//
// EXCEPT `hold`, WHICH IS NOT REVERSIBLE (2026-08-08). Every other action here can be
// undone with a second tap — stop/reopen, mute, keep. `hold` commits the bot to carting
// a real site at 08:00, which takes it off the market for every other camper; that is the
// exact behaviour the whole opt-in design exists to prevent, so it must not happen
// without a person deciding. Two things went wrong on the same link:
//   • tapping the PUSH notification performed the hold before the owner had seen which
//     site it was — no campground, no site number, no dates, no chance to check;
//   • acting on GET means an email scanner or a link preview can fire it unasked, which
//     for a reversible action is harmless and for this one is not.
// So `hold` gets a preview page and a POST to confirm. Everything else keeps its single
// tap, because making stop-watching a two-step flow would be worse, not safer.
export const dynamic = 'force-dynamic';

export default async function WatchActionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Read-only. Returns null for every other action and for a dead offer, so the
  // fall-through below is the unchanged one-tap path.
  const preview = await previewHold(token);
  if (preview) return <HoldConfirm preview={preview} />;

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
    <main className="min-h-screen flex items-center justify-center bg-ch-paper px-4">
      <div className="max-w-md w-full bg-white rounded-2xl border border-ch-line shadow-sm p-8 text-center">
        <div className="text-3xl mb-3">{result.ok ? '✅' : '⚠️'}</div>
        <h1 className="text-lg font-semibold text-ch-ink mb-2">
          {result.ok ? 'Done' : 'Hmm'}
        </h1>
        <p className="text-ch-ink-2">{result.message}</p>

        {result.ok && result.inverseUrl && inverseLabel && (
          <a
            href={result.inverseUrl}
            className="inline-block mt-6 px-5 py-2.5 rounded-lg bg-ch-green text-white font-medium hover:bg-ch-green-deep"
          >
            {inverseLabel}
          </a>
        )}

        <div className="mt-6">
          <Link href="/" className="text-sm text-ch-muted hover:text-ch-ink-2">Back to CampHawk</Link>
        </div>
      </div>
    </main>
  );
}
