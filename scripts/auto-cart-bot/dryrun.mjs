// Local dry-run of the remote sign-in pipeline (Option C) — no mini PC, no tunnel.
// Runs the REAL broker.mjs, mints a valid token for a throwaway profile, and
// serves a tiny viewer page. Open the printed URL in your normal browser and sign
// into recreation.gov through it — exactly what a friend would do remotely.
//   node dryrun.mjs
// Clean up after with:  rm -rf profiles/dryrun-test

import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the same AUTOCART_TOKEN the broker will use, so our token verifies.
let SECRET;
for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*AUTOCART_TOKEN\s*=\s*(.*)\s*$/);
  if (m) SECRET = m[1].trim().replace(/^['"]|['"]$/g, '');
}
if (!SECRET) { console.error('No AUTOCART_TOKEN in .env'); process.exit(1); }

const WEB_PORT = 5555;
const BROKER_PORT = 8787;
const UID = 'dryrun-test';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const payloadB64 = b64url(JSON.stringify({ uid: UID, exp: Date.now() + 30 * 60 * 1000 }));
const TOKEN = `${payloadB64}.${b64url(crypto.createHmac('sha256', SECRET).update(payloadB64).digest())}`;

const VIEWER = `<!doctype html><html><head><meta charset=utf8><title>CampHawk dry run</title>
<style>body{font-family:system-ui;margin:24px;max-width:1040px}canvas{border:1px solid #ccc;width:100%;cursor:crosshair;outline:none}
#s{margin:8px 0;color:#555} button{padding:8px 14px;border:0;background:#16a34a;color:#fff;border-radius:8px;font-weight:600}</style>
</head><body>
<h2>CampHawk remote sign-in — dry run</h2>
<div id=s>Click Start, then sign into recreation.gov in the window below.</div>
<button id=go>Start</button>
<canvas id=c tabindex=0 width=1000 height=760></canvas>
<script>
const TOKEN=${JSON.stringify(TOKEN)}, URL="ws://localhost:${BROKER_PORT}";
const c=document.getElementById('c'), s=document.getElementById('s'), img=new Image();
let ws, live=false, W=1000, H=760;
const send=o=>{ if(ws&&ws.readyState===1) ws.send(JSON.stringify(o)); };
const rel=e=>{const r=c.getBoundingClientRect();return{x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))};};
const btn=b=>b===2?'right':b===1?'middle':'left';
document.getElementById('go').onclick=()=>{
  s.textContent='Connecting…';
  ws=new WebSocket(URL);
  ws.onopen=()=>send({token:TOKEN});
  ws.onclose=()=>{ if(!live) s.textContent='Closed.'; live=false; };
  ws.onerror=()=>s.textContent='Connection error — is the broker running?';
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);
    if(m.t==='ready'){live=true;s.textContent='Live — click into the window and sign in.';}
    else if(m.t==='frame'){W=m.w;H=m.h; if(c.width!==W){c.width=W;c.height=H;} img.onload=()=>c.getContext('2d').drawImage(img,0,0,W,H); img.src='data:image/jpeg;base64,'+m.data;}
    else if(m.t==='done'){live=false;s.textContent='✅ SIGNED IN — pipeline works! You can close this.';ws.close();}
    else if(m.t==='error'){s.textContent='Error: '+m.message;}
  };
};
c.addEventListener('pointermove',e=>{if(live)send({t:'move',...rel(e)});});
c.addEventListener('pointerdown',e=>{c.focus();send({t:'down',...rel(e),button:btn(e.button)});});
c.addEventListener('pointerup',e=>send({t:'up',...rel(e),button:btn(e.button)}));
c.addEventListener('wheel',e=>{e.preventDefault();send({t:'wheel',dx:e.deltaX,dy:e.deltaY});},{passive:false});
c.addEventListener('contextmenu',e=>e.preventDefault());
c.addEventListener('keydown',e=>{if(!live)return;const named=['Enter','Backspace','Tab','Delete','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){send({t:'text',text:e.key});e.preventDefault();}
  else if(named.includes(e.key)){send({t:'key',key:e.key});e.preventDefault();}});
</script></body></html>`;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(VIEWER);
}).listen(WEB_PORT, () => {
  console.log(`\n  Viewer:  http://localhost:${WEB_PORT}   ← open this in your browser`);
  console.log(`  (Ignore any Chromium window that pops up — drive it from the viewer page.)\n`);
});

// Launch the real broker, headed + on-screen so WSLg definitely paints frames.
const broker = spawn(process.execPath, ['broker.mjs'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, BROKER_PORT: String(BROKER_PORT),
    CHROME_ARGS: '--disable-gpu --window-position=20,20 --window-size=1000,760' },
});
process.on('SIGINT', () => { broker.kill('SIGKILL'); process.exit(0); });
