'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, ShieldCheck, AlertTriangle } from 'lucide-react';

// Remote one-time recreation.gov sign-in. Primary path: the user enters their
// rec.gov email/password into a normal form here; the credentials are sent over the
// encrypted WebSocket to their own CampHawk mini-PC, which types them into rec.gov
// once and never stores them. If that can't complete automatically (CAPTCHA/2FA/odd
// form), we fall back to the live streamed rec.gov login (the mini-PC also screencasts
// the page the whole time) so the user can finish it by hand.

type Status = 'idle' | 'connecting' | 'live' | 'done' | 'error';

export default function ConnectPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // A real, focusable text input that catches the on-screen keyboard on phones — a
  // <canvas> can't raise a soft keyboard. Tapping the stream focuses this (within the
  // tap gesture, so iOS/Android open the keyboard), and we forward what's typed.
  const kbRef = useRef<HTMLInputElement>(null);
  const kbPrevRef = useRef(''); // last seen value of the hidden input, for delta diffing
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  // 'form' = our own credential fields (primary); 'stream' = fall back to the live
  // rec.gov window when the broker can't finish automatically.
  const [mode, setMode] = useState<'form' | 'stream'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState('');

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
      setError('Could not reach the sign-in service. Is the mini PC online?');
      return;
    }
    wsRef.current = ws;
    imgRef.current = new Image();

    ws.onopen = () => send({ token }); // first message authenticates us
    ws.onerror = () => { setStatus('error'); setError('Connection to the sign-in service failed.'); };
    ws.onclose = () => setStatus((s) => (s === 'done' ? 'done' : s === 'error' ? 'error' : 'idle'));
    ws.onmessage = (ev) => {
      let m: { t: string; data?: string; w?: number; h?: number; message?: string };
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'ready' || m.t === 'live') setStatus('live');
      else if (m.t === 'frame' && m.data) drawFrame(m.data, m.w || 1000, m.h || 760);
      else if (m.t === 'done') { setStatus('done'); ws.close(); }
      // Broker couldn't finish from the credentials alone — reveal the live window.
      else if (m.t === 'manual') { setSubmitting(false); setMode('stream'); setNote(m.message || 'Please finish signing in in the window below.'); }
      else if (m.t === 'error') { setStatus('error'); setError(m.message || 'The sign-in service reported an error.'); }
    };
  }, []);

  function drawFrame(b64: string, w: number, h: number) {
    const canvas = canvasRef.current, img = imgRef.current;
    if (!canvas || !img) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    img.onload = () => canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
    img.src = `data:image/jpeg;base64,${b64}`;
  }

  useEffect(() => () => wsRef.current?.close(), []);

  // Lock zoom while on this page. Pinch/double-tap zoom shifts the visual viewport,
  // which threw off the tap→page coordinate math (taps landed in the wrong spot —
  // the "acts odd when you zoom" bug). Restored on leave so other pages can zoom.
  useEffect(() => {
    const head = document.head;
    const existing = head.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
    const prev = existing?.content ?? null;
    const meta = existing ?? document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
    if (!existing) head.appendChild(meta);
    return () => {
      if (!existing) meta.remove();
      else if (prev !== null) meta.content = prev;
    };
  }, []);

  // Map a pointer event to 0..1 coords of the tap surface (the overlay itself), which
  // the broker scales onto the remote page. Using the event's own target rect keeps
  // this accurate regardless of layout.
  const rel = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };
  const btn = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');

  // Non-text keys only (they don't change the input's value, so the value-diff below
  // won't see them): Enter/Tab/arrows/etc. Backspace/Delete DO shrink the value and are
  // handled by the diff, so they're intentionally NOT here (avoids double-sending).
  const named = ['Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (status !== 'live') return;
    if (named.includes(e.key)) {
      send({ t: 'key', key: e.key });
      e.preventDefault();
    }
  };

  // Text channel — the reliable one across iOS/Android/desktop. React's `onBeforeInput`
  // often doesn't expose `inputType`/`data`, so instead we let the hidden input hold the
  // typed text and diff its value on every `input` event (composition-friendly, and it
  // catches soft-keyboard backspace that keydown misses on Android). Append → forward the
  // new chars as text; shrink → forward Backspace(s). Cursor edits mid-string are rare in
  // a login, so a non-append/non-trim change just replays the whole value.
  const onTextInput = (e: React.FormEvent<HTMLInputElement>) => {
    if (status !== 'live') return;
    const v = e.currentTarget.value;
    const prev = kbPrevRef.current;
    if (v.length > prev.length && v.startsWith(prev)) {
      for (const ch of v.slice(prev.length)) send({ t: 'text', text: ch });
    } else if (v.length < prev.length && prev.startsWith(v)) {
      for (let i = 0; i < prev.length - v.length; i++) send({ t: 'key', key: 'Backspace' });
    } else if (v !== prev) {
      for (const ch of v) send({ t: 'text', text: ch });
    }
    kbPrevRef.current = v;
  };

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 text-gray-900">
          <ShieldCheck size={22} className="text-green-600" />
          <h1 className="font-display text-xl font-bold">Connect recreation.gov</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Sign in once so CampHawk can add openings to your cart. Your recreation.gov email and
          password are sent over an encrypted connection to your own CampHawk mini-PC, used once to
          sign in, and never stored.
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

        {/* Primary: our own credential form (real native inputs — the mobile keyboard
            just works). Submitting sends the credentials to the mini-PC to type into
            rec.gov. Hidden once we fall back to the streamed window. */}
        {status === 'live' && mode === 'form' && (
          <form
            onSubmit={(e) => { e.preventDefault(); if (!email || !password) return; setSubmitting(true); send({ t: 'login', email, password }); }}
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
            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-5 py-2.5 font-display text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
            >
              {submitting ? <><Loader2 size={15} className="animate-spin" /> Signing you in…</> : 'Sign in'}
            </button>
            <p className="text-center text-[11px] text-gray-400">
              Sent encrypted to your CampHawk mini-PC, used once, never stored.
            </p>
          </form>
        )}

        {/* Fallback: the live streamed rec.gov window (also used if the form can't
            finish automatically). Mounted whenever live so frames keep drawing, but
            only shown once we switch to 'stream' mode. */}
        {(status === 'live' || status === 'connecting') && (
          <div className={status === 'live' && mode === 'stream' ? 'mt-6' : 'hidden'}>
            {note && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{note}</p>}
            <p className="mb-2 text-xs text-gray-400">Tap the window and type as usual — the keyboard opens when you tap a field. Sign in and it finishes on its own.</p>
            <div className="relative">
              {/* Canvas only DISPLAYS the stream — it can't hold a mobile keyboard. */}
              <canvas
                ref={canvasRef}
                className="pointer-events-none w-full rounded-xl border border-gray-300 bg-white shadow-sm"
              />
              {/* A transparent, full-size text input overlaid on the stream. It IS the
                  tap target, so focus — and the phone's on-screen keyboard — never leaves
                  it (the old off-screen input lost focus on touch-end, so the keyboard
                  flickered away). `touch-none` stops the browser treating a tap/drag as a
                  scroll (which was also blurring it). Kept empty + preventDefault so each
                  keystroke is a clean delta forwarded to the remote page. */}
              <input
                ref={kbRef}
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="recreation.gov sign-in"
                onPointerMove={(e) => status === 'live' && send({ t: 'move', ...rel(e) })}
                onPointerDown={(e) => { kbRef.current?.focus(); send({ t: 'down', ...rel(e), button: btn(e.button) }); }}
                onPointerUp={(e) => send({ t: 'up', ...rel(e), button: btn(e.button) })}
                onWheel={(e) => send({ t: 'wheel', dx: e.deltaX, dy: e.deltaY })}
                onKeyDown={onKeyDown}
                onInput={onTextInput}
                onContextMenu={(e) => e.preventDefault()}
                className="absolute inset-0 h-full w-full cursor-crosshair touch-none rounded-xl bg-transparent text-transparent caret-transparent opacity-0 outline-none"
              />
            </div>
          </div>
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
