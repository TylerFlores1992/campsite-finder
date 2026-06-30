'use client';

import { useState } from 'react';
import { Bell, Loader2, Check } from 'lucide-react';
import EmailCaptureModal from './EmailCaptureModal';

interface WatchButtonProps {
  campgroundId: string;
  campgroundName: string;
  startDate: string;
  endDate: string;
  siteType?: string | null;
  userId: string;
}

function getSavedEmail(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cf_user_email');
}

export default function WatchButton({
  campgroundId,
  campgroundName,
  startDate,
  endDate,
  siteType,
  userId,
}: WatchButtonProps) {
  const [state, setState] = useState<'idle' | 'prompt' | 'loading' | 'watching'>('idle');

  async function createWatch(email?: string) {
    setState('loading');
    try {
      if (email) {
        localStorage.setItem('cf_user_email', email);
        await fetch('/api/user/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
          body: JSON.stringify({ email }),
        });
      }
      await fetch('/api/watches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ campgroundId, startDate, endDate, siteType }),
      });
      setState('watching');
    } catch {
      setState('idle');
    }
  }

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (state !== 'idle') return;
    if (getSavedEmail()) {
      createWatch();
    } else {
      setState('prompt');
    }
  }

  if (state === 'watching') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-700 font-medium">
        <Check size={12} /> Alert set
      </span>
    );
  }

  return (
    <>
      <button
        onClick={handleClick}
        disabled={state === 'loading'}
        title={`Get notified when ${campgroundName} has availability`}
        className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors disabled:opacity-50"
      >
        {state === 'loading' ? <Loader2 size={11} className="animate-spin" /> : <Bell size={11} />}
        {state === 'loading' ? 'Saving…' : 'Notify me'}
      </button>

      {state === 'prompt' && (
        <EmailCaptureModal
          campgroundName={campgroundName}
          onConfirm={(email) => createWatch(email)}
          onClose={() => setState('idle')}
        />
      )}
    </>
  );
}
