'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, ShieldCheck, AlertTriangle } from 'lucide-react';

// Remote one-time recreation.gov sign-in. This page streams a live rec.gov login
// running on the mini-PC (via the broker + Cloudflare Tunnel) so anyone can do
// their one-time sign-in from any computer. Your password goes straight into
// recreation.gov on the machine that stores the session — never to CampHawk.

type Status = 'idle' | 'connecting' | 'live' | 'done' | 'error';

export default function ConnectPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

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

  // Map a pointer event to 0..1 canvas-relative coords the broker scales to the page.
  const rel = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };
  const btn = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (status !== 'live') return;
    const named = ['Enter', 'Backspace', 'Tab', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      send({ t: 'text', text: e.key });
      e.preventDefault();
    } else if (named.includes(e.key)) {
      send({ t: 'key', key: e.key });
      e.preventDefault();
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 text-gray-900">
          <ShieldCheck size={22} className="text-green-600" />
          <h1 className="font-display text-xl font-bold">Connect recreation.gov</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Sign in once so CampHawk can add openings to your cart. This is a live recreation.gov
          window running on the CampHawk machine — your password goes straight to recreation.gov and
          is never seen or stored by CampHawk.
        </p>

        {status === 'idle' && (
          <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-6 text-center">
            <p className="text-sm text-gray-600">
              Click below to open a secure recreation.gov sign-in. Sign in as you normally would; this
              page closes itself automatically once you&apos;re in.
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

        {(status === 'live' || status === 'connecting') && (
          <div className={status === 'live' ? 'mt-6' : 'hidden'}>
            <p className="mb-2 text-xs text-gray-400">Click into the window, then type as usual. Sign in and it finishes on its own.</p>
            <canvas
              ref={canvasRef}
              tabIndex={0}
              onPointerMove={(e) => status === 'live' && send({ t: 'move', ...rel(e) })}
              onPointerDown={(e) => { canvasRef.current?.focus(); send({ t: 'down', ...rel(e), button: btn(e.button) }); }}
              onPointerUp={(e) => send({ t: 'up', ...rel(e), button: btn(e.button) })}
              onWheel={(e) => send({ t: 'wheel', dx: e.deltaX, dy: e.deltaY })}
              onKeyDown={onKeyDown}
              onContextMenu={(e) => e.preventDefault()}
              className="w-full cursor-crosshair rounded-xl border border-gray-300 bg-white shadow-sm outline-none focus:ring-2 focus:ring-green-500"
            />
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
