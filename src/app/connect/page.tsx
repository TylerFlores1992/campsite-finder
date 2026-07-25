'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, ShieldCheck, AlertTriangle } from 'lucide-react';

// Remote one-time recreation.gov sign-in. The user enters their rec.gov email/password
// into a normal form here; the credentials are sent over the encrypted WebSocket to
// their own CampHawk mini-PC, which types them into rec.gov once and never stores them.
// If that can't complete automatically (wrong password / CAPTCHA / 2FA), we ask them to
// recheck their login and try again — we no longer drop them into a live screen-share of
// the rec.gov window, which was clumsy on mobile and rarely got anyone through.

type Status = 'idle' | 'connecting' | 'live' | 'done' | 'error';

// Shown when the broker can't finish sign-in from the submitted credentials alone.
const CREDENTIAL_HELP =
  'We couldn’t finish signing you in. Please double-check your recreation.gov email and password, then try again. If they’re correct, your recreation.gov account may require a security step (like a CAPTCHA or 2-factor code) that blocks automatic sign-in.';

export default function ConnectPage() {
  const wsRef = useRef<WebSocket | null>(null);
  const loginTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // form-submit safety timeout
  const clearLoginTimer = () => { if (loginTimerRef.current) { clearTimeout(loginTimerRef.current); loginTimerRef.current = null; } };
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const send = (o: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
  };

  const start = useCallback(async () => {
    setStatus('connecting');
    setError('');
    let token: string, brokerUrl: string;
    try {
      const r = await fetch('/api/user/connect-token', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `mint failed (${r.status})`);
      ({ token, brokerUrl } = await r.json());
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Could not start a session.');
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(brokerUrl);
    } catch {
      setStatus('error');
      setError('Could not reach the sign-in service. Is your CampHawk server online?');
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => send({ token }); // first message authenticates us
    ws.onerror = () => { setStatus('error'); setError('Connection to the sign-in service failed.'); };
    ws.onclose = () => setStatus((s) => (s === 'done' ? 'done' : s === 'error' ? 'error' : 'idle'));
    ws.onmessage = (ev) => {
      let m: { t: string; data?: string; w?: number; h?: number; message?: string };
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'ready' || m.t === 'live') setStatus('live');
      else if (m.t === 'done') { clearLoginTimer(); setStatus('done'); ws.close(); }
      // Broker couldn't finish from the credentials alone. Rather than drop the user
      // into the barely-usable live screen-share, ask them to recheck their login.
      else if (m.t === 'manual') { clearLoginTimer(); setSubmitting(false); setStatus('error'); setError(CREDENTIAL_HELP); }
      else if (m.t === 'error') { clearLoginTimer(); setStatus('error'); setError(m.message || 'The sign-in service reported an error.'); }
    };
  }, []);

  useEffect(() => () => { wsRef.current?.close(); clearLoginTimer(); }, []);

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 text-gray-900">
          <ShieldCheck size={22} className="text-green-600" />
          <h1 className="font-display text-xl font-bold">Connect recreation.gov</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Sign in so CampHawk can add openings to your cart. Your recreation.gov email and password
          are sent over an encrypted connection to your own CampHawk server and saved there,
          encrypted, so auto-cart stays connected — <strong>never uploaded to CampHawk&apos;s cloud</strong>.
        </p>

        {status === 'idle' && (
          <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-6 text-center">
            <p className="text-sm text-gray-600">
              Click below to start a secure sign-in. You&apos;ll enter your recreation.gov email and
              password, and this page closes itself automatically once you&apos;re in.
            </p>
            <button
              onClick={start}
              className="mt-4 rounded-xl bg-green-600 px-5 py-2.5 font-display text-sm font-semibold text-white hover:bg-green-700"
            >
              Start secure sign-in
            </button>
          </div>
        )}

        {status === 'connecting' && (
          <div className="mt-6 flex items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white p-10 text-gray-500">
            <Loader2 size={18} className="animate-spin" /> Opening a secure recreation.gov window…
          </div>
        )}

        {/* Our own credential form (real native inputs — the mobile keyboard just works).
            Submitting sends the credentials to the mini-PC to type into rec.gov. */}
        {status === 'live' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!email || !password) return;
              setSubmitting(true);
              send({ t: 'login', email, password, remember });
              // Safety net: if the mini-PC broker doesn't answer (e.g. it's on older code
              // that doesn't know the 'login' message), don't hang — surface a retry.
              clearLoginTimer();
              loginTimerRef.current = setTimeout(() => {
                setSubmitting(false);
                setStatus('error');
                setError('Automatic sign-in didn’t respond in time. Please double-check your recreation.gov email and password, then try again.');
              }, 40000);
            }}
            className="mt-6 space-y-3 rounded-2xl border border-gray-200 bg-white p-5"
          >
            <label className="block text-sm font-medium text-gray-700">
              recreation.gov email
              <input
                type="email"
                autoComplete="username"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-60"
              />
            </label>
            <label className="block text-sm font-medium text-gray-700">
              recreation.gov password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-60"
              />
            </label>
            <label className="flex items-start gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                disabled={submitting}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <span>
                <strong>Save my login to keep auto-cart connected (required).</strong>{' '}It&apos;s
                stored, encrypted, on your own CampHawk server so the bot can re-connect on its own
                if the session drops. Never uploaded to CampHawk&apos;s cloud.
              </span>
            </label>
            <button
              type="submit"
              disabled={submitting || !email || !password || !remember}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-5 py-2.5 font-display text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
            >
              {submitting ? <><Loader2 size={15} className="animate-spin" /> Signing you in…</> : 'Sign in'}
            </button>
            {!remember && (
              <p className="text-center text-[11px] text-amber-700">
                Auto-cart needs your saved login to stay connected — check the box above to continue.
              </p>
            )}
            <p className="text-center text-[11px] text-gray-400">
              Saved encrypted on your own CampHawk server — never uploaded to CampHawk&apos;s cloud.
            </p>
          </form>
        )}

        {status === 'done' && (
          <div className="mt-6 rounded-2xl border border-green-200 bg-green-50 p-8 text-center">
            <CheckCircle2 size={32} className="mx-auto text-green-600" />
            <h2 className="mt-2 font-display text-lg font-bold text-green-900">You&apos;re connected!</h2>
            <p className="mt-1 text-sm text-green-800">
              Auto-cart is now active. When a site you&apos;re watching opens, it&apos;s added to your
              recreation.gov cart automatically — just finish checkout on your phone.
            </p>
            <a href="/" className="mt-4 inline-block rounded-xl bg-green-600 px-5 py-2.5 font-display text-sm font-semibold text-white hover:bg-green-700">
              Done
            </a>
          </div>
        )}

        {status === 'error' && (
          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center">
            <AlertTriangle size={26} className="mx-auto text-amber-500" />
            <p className="mt-2 text-sm text-amber-900">{error || 'Something went wrong.'}</p>
            <button
              onClick={start}
              className="mt-4 rounded-xl bg-gray-900 px-5 py-2.5 font-display text-sm font-semibold text-white hover:bg-gray-800"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
