'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, ShieldCheck, AlertTriangle } from 'lucide-react';

// Remote one-time recreation.gov sign-in. Primary path: the user enters their
// rec.gov email/password into a normal form here; the credentials are sent over the
// encrypted WebSocket to the private mini-PC that runs the browser session, which
// types them into rec.gov and saves them there (encrypted) so it can sign back in
// by itself when the session drops — saving is required, see the checkbox below. That form handles the vast majority of logins on its own.
// The live streamed rec.gov window is reserved for the one case the form genuinely
// can't clear: rec.gov throwing a CAPTCHA / 2FA challenge, which the broker signals with
// a 'manual' message so the user can finish that step by hand. A wrong password also
// comes back as 'manual', so it lands in that window rather than as an error here.
//
// A broker that never answers at all is the remaining case, and it is NOT a credential
// problem — it means the mini-PC helper is on older code or briefly offline. The submit
// handler below waits 90s (the broker can legitimately stay silent for ~34s) and then
// says so, rather than telling the user to re-check a password that was fine.

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
  const loginTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // form-submit safety timeout
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // "still working" nudge
  const clearProgressTimer = () => { if (progressTimerRef.current) { clearTimeout(progressTimerRef.current); progressTimerRef.current = null; } };
  // Always clears BOTH — the progress nudge must never outlive the attempt it
  // describes, or a finished sign-in still says "still working".
  const clearLoginTimer = () => {
    if (loginTimerRef.current) { clearTimeout(loginTimerRef.current); loginTimerRef.current = null; }
    clearProgressTimer();
  };
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  // 'form' = our own credential fields (primary); 'stream' = fall back to the live
  // rec.gov window when the broker can't finish automatically.
  const [mode, setMode] = useState<'form' | 'stream'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
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
      setError('Could not reach the sign-in service. Is your CampHawk server online?');
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
      // Purely additive: a broker too old to send 'ack' just never triggers this,
      // and the existing timeout still covers that case. When it DOES arrive we
      // know the helper received the request, so the wait is real progress.
      else if (m.t === 'ack') setNote('Signing you in on the helper — this can take up to a minute.');
      else if (m.t === 'frame' && m.data) drawFrame(m.data, m.w || 1000, m.h || 760);
      else if (m.t === 'done') { clearLoginTimer(); setStatus('done'); ws.close(); }
      // Broker couldn't finish from the credentials alone — reveal the live window.
      else if (m.t === 'manual') { clearLoginTimer(); setSubmitting(false); setMode('stream'); setNote(m.message || 'Please finish signing in in the window below.'); }
      else if (m.t === 'error') { clearLoginTimer(); setStatus('error'); setError(m.message || 'The sign-in service reported an error.'); }
    };
  }, []);

  function drawFrame(b64: string, w: number, h: number) {
    const canvas = canvasRef.current, img = imgRef.current;
    if (!canvas || !img) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    img.onload = () => canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
    img.src = `data:image/jpeg;base64,${b64}`;
  }

  useEffect(() => () => { wsRef.current?.close(); clearLoginTimer(); }, []);

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
    <div className="min-h-dvh bg-ch-paper px-4 py-8 font-ch-body text-ch-ink">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 text-ch-ink">
          <ShieldCheck size={22} className="text-ch-green" />
          <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">Connect recreation.gov</h1>
        </div>
        {/* WORDING MATCHED TO TrustPanel. This page used to say the credentials
            go to "your own CampHawk server", which reads as a machine the USER
            owns; the trust panel says "a private machine we run". Only one can be
            true, and a sceptical user reading both pages will spot the gap on the
            exact screen where they're deciding whether to hand over a password.
            Both now say the same thing: a private machine we run, separate from
            the web servers and the database. */}
        <p className="mt-1 text-ch-body text-ch-muted">
          Sign in so CampHawk can add openings to your cart. Your recreation.gov email and password
          are sent over an encrypted connection to a private machine we run — the one that keeps
          your session open — and saved there, encrypted, so auto-cart can sign back in on its own.{' '}
          <strong>They never reach CampHawk&apos;s web servers or database.</strong>
        </p>

        {status === 'idle' && (
          <div className="mt-6 rounded-ch-card border border-ch-line bg-ch-card shadow-ch-card p-6 text-center">
            <p className="text-ch-body text-ch-ink-2">
              Click below to start a secure sign-in. You&apos;ll enter your recreation.gov email and
              password, and this page closes itself automatically once you&apos;re in.
            </p>
            <button
              onClick={start}
              className="mt-4 rounded-ch-btn bg-ch-green px-5 py-2.5 text-ch-body font-bold text-white hover:bg-ch-green-deep"
            >
              Start secure sign-in
            </button>
          </div>
        )}

        {status === 'connecting' && (
          <div className="mt-6 flex items-center justify-center gap-2 rounded-ch-card border border-ch-line bg-ch-card shadow-ch-card p-10 text-ch-muted">
            <Loader2 size={18} className="animate-spin" /> Opening a secure recreation.gov window…
          </div>
        )}

        {/* Primary: our own credential form (real native inputs — the mobile keyboard
            just works). Submitting sends the credentials to the mini-PC to type into
            rec.gov. Hidden once we fall back to the streamed window. */}
        {status === 'live' && mode === 'form' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!email || !password) return;
              setSubmitting(true);
              setNote('');
              send({ t: 'login', email, password, remember });
              // THE BROKER IS SILENT FOR A LONG TIME BY DESIGN, and 40s was not long
              // enough. Its worst case before the first message is roughly:
              //   openLoginModalAndFill  1.5s + 8s (email field) + 1.2s + 8s (password)
              //   then doLogin's confirmation loop  15 x 1s
              // ≈ 34s, before page-load time — so a login that was working could trip
              // the old 40s timeout, and the message then blamed the user's password.
              // It is never the password: a wrong one comes back as 'manual'.
              clearLoginTimer();
              progressTimerRef.current = setTimeout(() => {
                setNote('Still working — signing in to recreation.gov can take up to a minute.');
              }, 20000);
              loginTimerRef.current = setTimeout(() => {
                clearProgressTimer();
                setSubmitting(false);
                setStatus('error');
                // Say what is actually likely, in the order it is likely. A silent
                // broker usually means the mini-PC helper is running older code that
                // doesn't understand this sign-in yet — nothing the user can fix by
                // retyping their password, which is what the old wording told them to do.
                setError(
                  "The sign-in helper didn't respond. That usually means it needs updating or briefly dropped offline — not that your details are wrong. Try again in a minute, and email alerts@camphawk.app if it keeps happening.",
                );
              }, 90000);
            }}
            className="mt-6 space-y-3 rounded-ch-card border border-ch-line bg-ch-card shadow-ch-card p-5"
          >
            <label className="block text-sm font-medium text-ch-ink-2">
              recreation.gov email
              <input
                type="email"
                autoComplete="username"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className="mt-1 w-full rounded-ch-input border border-ch-line px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ch-green disabled:opacity-60"
              />
            </label>
            <label className="block text-sm font-medium text-ch-ink-2">
              recreation.gov password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className="mt-1 w-full rounded-ch-input border border-ch-line px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ch-green disabled:opacity-60"
              />
            </label>
            <label className="flex items-start gap-2 text-ch-meta text-ch-ink-2">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                disabled={submitting}
                className="mt-0.5 h-4 w-4 rounded border-ch-line accent-[#1E7A4C] focus:ring-ch-green"
              />
              <span>
                <strong>Save my login to keep auto-cart connected (required).</strong>{' '}It&apos;s
                stored, encrypted, on a private machine we run, so it can sign back in on its own
                when the session drops. It never reaches CampHawk&apos;s web servers or database.
              </span>
            </label>
            <button
              type="submit"
              disabled={submitting || !email || !password || !remember}
              className="flex w-full items-center justify-center gap-2 rounded-ch-btn bg-ch-green px-5 py-2.5 text-ch-body font-bold text-white hover:bg-ch-green-deep disabled:opacity-50"
            >
              {submitting ? <><Loader2 size={15} className="animate-spin" /> Signing you in…</> : 'Sign in'}
            </button>
            {!remember && (
              <p className="text-center text-ch-fine text-ch-ochre-ink">
                Auto-cart needs your saved login to stay connected — check the box above to continue.
              </p>
            )}
            <p className="text-center text-ch-fine text-ch-muted">
              Saved encrypted on a private machine we run — never on CampHawk&apos;s web servers
              or database.
            </p>
          </form>
        )}

        {/* Fallback: the live streamed rec.gov window (also used if the form can't
            finish automatically). Mounted whenever live so frames keep drawing, but
            only shown once we switch to 'stream' mode. */}
        {(status === 'live' || status === 'connecting') && (
          <div className={status === 'live' && mode === 'stream' ? 'mt-6' : 'hidden'}>
            {note && <p className="mb-2 rounded-ch-input bg-ch-ochre-soft px-3 py-2 text-xs text-ch-ochre-ink">{note}</p>}
            <p className="mb-2 text-ch-fine text-ch-muted">Tap the window and type as usual — the keyboard opens when you tap a field. Sign in and it finishes on its own.</p>
            <div className="relative">
              {/* Canvas only DISPLAYS the stream — it can't hold a mobile keyboard. */}
              <canvas
                ref={canvasRef}
                className="pointer-events-none w-full rounded-ch-input border border-ch-line bg-white shadow-sm"
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
                className="absolute inset-0 h-full w-full cursor-crosshair touch-none rounded-ch-input bg-transparent text-transparent caret-transparent opacity-0 outline-none"
              />
            </div>
          </div>
        )}

        {status === 'done' && (
          <div className="mt-6 rounded-ch-card border border-[#BFDDC9] bg-ch-green-soft p-8 text-center">
            <CheckCircle2 size={32} className="mx-auto text-ch-green" />
            <h2 className="mt-2 font-ch-display text-lg font-bold text-ch-green-deep">You&apos;re connected!</h2>
            <p className="mt-1 text-sm text-ch-green-deep">
              Auto-cart is now active. When a site you&apos;re watching opens, it&apos;s added to your
              recreation.gov cart automatically — just finish checkout on your phone.
            </p>
            <a href="/" className="mt-4 inline-block rounded-ch-btn bg-ch-green px-5 py-2.5 text-ch-body font-bold text-white hover:bg-ch-green-deep">
              Done
            </a>
          </div>
        )}

        {status === 'error' && (
          <div className="mt-6 rounded-ch-card border border-[#E7C98C] bg-ch-ochre-soft p-6 text-center">
            <AlertTriangle size={26} className="mx-auto text-ch-ochre" />
            <p className="mt-2 text-sm text-ch-ochre-ink">{error || 'Something went wrong.'}</p>
            <button
              onClick={start}
              className="mt-4 rounded-ch-input bg-ch-ink px-5 py-2.5 font-ch-display text-sm font-semibold text-white hover:bg-ch-ink-2"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
