'use client';

import { useEffect, useState } from 'react';
import { Zap, X } from 'lucide-react';

/** Opt-in for the personal auto-cart bot. Flipping it on just enrolls the user
 *  (adds them to the bot's roster); the bot + a one-time rec.gov login still
 *  have to be set up by whoever runs the bot. Turning it on pops a short
 *  "what's next" guide so nobody is left wondering why nothing happened. */
export default function AutoCartToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    fetch('/api/user/autocart')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => setEnabled(!!d.enabled))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  async function toggle() {
    const next = !enabled;
    setSaving(true);
    setEnabled(next); // optimistic
    try {
      const r = await fetch('/api/user/autocart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      setEnabled(!!d.enabled);
      if (d.enabled) setShowGuide(true); // show the "what's next" steps on enable
    } catch {
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  return (
    <>
      <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
            <Zap size={13} className="text-amber-500" />
            Auto-cart openings
            <span className="text-[10px] font-normal text-gray-400">(beta)</span>
          </span>
          <button
            role="switch"
            aria-checked={enabled}
            aria-label="Enable auto-cart"
            onClick={toggle}
            disabled={saving}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
              enabled ? 'bg-green-600' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
        <p className="mt-1 text-[11px] text-gray-400 leading-snug">
          {enabled
            ? 'On — openings you’re watching are added to your recreation.gov cart automatically. One-time recreation.gov sign-in required.'
            : 'Have openings added to your recreation.gov cart automatically, so you just check out.'}{' '}
          <a href="/auto-cart" target="_blank" className="text-green-700 underline underline-offset-2">
            How it works
          </a>
        </p>
      </div>

      {showGuide && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Auto-cart next steps"
        >
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowGuide(false)} />
          <div className="relative w-full max-w-sm rounded-2xl bg-white shadow-xl p-5 max-h-[85vh] overflow-y-auto">
            <button
              onClick={() => setShowGuide(false)}
              className="absolute top-3 right-3 text-gray-400 hover:text-gray-600"
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <div className="flex items-center gap-2">
              <Zap size={18} className="text-amber-500" />
              <h3 className="font-display font-bold text-gray-900">Auto-cart is on!</h3>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              When a site you&apos;re watching opens, it&apos;s added to your recreation.gov cart
              automatically — you just finish checkout on your phone.
            </p>

            <div className="mt-4 rounded-xl bg-green-50 border border-green-100 px-3.5 py-3">
              <p className="text-sm text-green-900 font-medium">One-time setup</p>
              <p className="mt-1 text-sm text-green-800 leading-relaxed">
                You&apos;ll sign into <strong>recreation.gov once</strong> so it can add sites to
                your cart — a login window opens, you sign in and close it. Your password is never
                shared or stored.
              </p>
            </div>

            <p className="mt-4 text-xs text-gray-500 leading-relaxed">
              California State Parks aren&apos;t auto-carted — those come as a tap-to-book link in
              your alert to finish on your phone.
            </p>

            <a
              href="/connect"
              className="mt-5 block w-full text-center px-4 py-2.5 rounded-xl bg-green-600 text-white text-sm font-display font-semibold hover:bg-green-700 transition-colors"
            >
              Sign into recreation.gov now
            </a>
            <div className="mt-3 flex items-center gap-3">
              <a
                href="/auto-cart"
                target="_blank"
                className="flex-1 text-center px-4 py-2 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50"
              >
                Read the full guide
              </a>
              <button
                onClick={() => setShowGuide(false)}
                className="px-4 py-2 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50"
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
