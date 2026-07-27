'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import Logo from '@/components/Logo';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    // No-ops unless a Sentry DSN is configured.
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-[#F3EFE0] px-4 text-center">
      <Logo markSize={40} />
      <div>
        <p className="font-ch-display text-3xl font-extrabold text-ch-green-deep">
          Something went wrong
        </p>
        <p className="mt-2 text-ch-ink-2 max-w-sm">
          We hit an unexpected error. Try again — if it keeps happening, please
          reach out.
        </p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="px-6 py-3 rounded-2xl bg-ch-green hover:bg-ch-green-deep text-white font-ch-display font-semibold shadow-md transition-colors"
        >
          Try again
        </button>
        <a
          href="/"
          className="px-6 py-3 rounded-2xl bg-white border border-ch-line text-ch-ink-2 font-ch-display font-semibold hover:bg-ch-paper transition-colors"
        >
          Home
        </a>
      </div>
    </div>
  );
}
