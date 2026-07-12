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
        <p className="font-display text-3xl font-extrabold text-green-800">
          Something went wrong
        </p>
        <p className="mt-2 text-gray-600 max-w-sm">
          We hit an unexpected error. Try again — if it keeps happening, please
          reach out.
        </p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="px-6 py-3 rounded-2xl bg-green-600 hover:bg-green-700 text-white font-display font-semibold shadow-md transition-colors"
        >
          Try again
        </button>
        <a
          href="/"
          className="px-6 py-3 rounded-2xl bg-white border border-gray-200 text-gray-700 font-display font-semibold hover:bg-gray-50 transition-colors"
        >
          Home
        </a>
      </div>
    </div>
  );
}
