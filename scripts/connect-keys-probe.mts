// Reproduce the /connect streamed sign-in's "the email gets typed into the password field"
// bug, in a real browser, offline — and prove the shipped diff no longer does it.
//
// THE REPORT (Android, 2026-09-18): "I type in email and as I'm typing in password it starts
// auto filling the email in the password section with every keystroke."
//
// THE MECHANISM the probe is built around.  `/connect`'s stream mode has no access to the
// remote page's fields; it overlays one transparent <input> on the canvas and forwards the
// DIFFERENCE in that input's value as keystrokes.  Two things then combine:
//   * the buffer was never cleared when the user tapped a different remote field, so it still
//     held the email while they typed the password, and
//   * the old diff's third arm re-sent the WHOLE buffer on any change that was neither an
//     append nor a trim — which is what an Android IME produces the moment it autocorrects.
//     An email and a password typed with no space between them are ONE token to Gboard, so
//     that arm keeps firing.
//
// WHY A BROWSER AND NOT JUST A UNIT TEST.  The unit tests pin the decision; what no
// hand-written value sequence can establish is what a real IME actually does to an input's
// value.  This drives Chromium's own composition machinery over CDP
// (`Input.imeSetComposition`, the path an Android IME uses) and feeds the values the BROWSER
// produced through the REAL shipped `diffKeystrokes` — not a copy of it.
//
// THE CONTROL IS THE POINT.  `legacyDiff` is the arm that shipped before the fix, kept only
// so the probe can refuse a verdict it has not earned: unless the OLD code re-types the email
// against this exact sequence, the sequence is not reproducing the bug and the new code
// passing proves nothing.
//
// EVERYTHING IS COUNTED IN THE PASSWORD PHASE ONLY.  Typing the email into the email field is
// the correct behaviour, so a metric that counted the whole run would report the feature
// working as a failure — the first version of this probe did exactly that.
//
// USAGE:  npx tsx scripts/connect-keys-probe.mts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { diffKeystrokes, type RemoteKey } from '../src/lib/remote-keys.ts';

const EXE = process.env.CONNECT_PROBE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const EMAIL = 'probe-user@example.invalid';
// Composed as "Sekrit9" and committed as "Secret9" — one ordinary autocorrect, which is all
// it takes to leave the append/trim arms.
const TYPED = 'Sekrit9';
const CORRECTED = 'Secret9';

// ------------------------------------------------ the arm that shipped before the fix
function legacyDiff(prev: string, next: string): RemoteKey[] {
  const out: RemoteKey[] = [];
  if (next.length > prev.length && next.startsWith(prev)) {
    for (const ch of next.slice(prev.length)) out.push({ t: 'text', text: ch });
  } else if (next.length < prev.length && prev.startsWith(next)) {
    for (let i = 0; i < prev.length - next.length; i++) out.push({ t: 'key', key: 'Backspace' });
  } else if (next !== prev) {
    for (const ch of next) out.push({ t: 'text', text: ch });   // <-- replays the whole buffer
  }
  return out;
}

// ------------------------------------------------------------------- the real browser
const PAGE = `<!doctype html><meta charset="utf-8"><title>connect overlay</title><body>
<input id="kb" type="text" inputmode="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">
<script>
  window.__phase = 'email'; window.__email = []; window.__password = [];
  const kb = document.getElementById('kb');
  kb.addEventListener('input', () => (window.__phase === 'email' ? window.__email : window.__password).push(kb.value));
  // What /connect's resetBuffer() does when the user taps a different remote field: clear the
  // overlay and forget what we had forwarded. It sends nothing.
  window.__tap = () => { kb.value = ''; window.__phase = 'password'; };
  // The other half of the report: the user tapped nothing, so the buffer kept the email.
  window.__keepBuffer = () => { window.__phase = 'password'; };
  kb.focus();
</script>`;

const srv = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox'] });

/** Type the email, switch fields the given way, then type the password through the IME. */
async function typeBoth(switchFields: '__tap' | '__keepBuffer') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(base);
  const cdp = await ctx.newCDPSession(page);
  for (const ch of EMAIL) await cdp.send('Input.insertText', { text: ch });
  await page.evaluate((fn) => (window as never as Record<string, () => void>)[fn](), switchFields);
  const at = (await page.inputValue('#kb')).length;   // where the composing region starts NOW
  for (let i = 1; i <= TYPED.length; i++) {
    await cdp.send('Input.imeSetComposition', {
      text: TYPED.slice(0, i), selectionStart: i, selectionEnd: i,
      replacementStart: at, replacementEnd: at + (i - 1),
    });
  }
  // …and the IME commits a CORRECTED word over the composing region, as autocorrect does.
  await cdp.send('Input.imeSetComposition', {
    text: CORRECTED, selectionStart: CORRECTED.length, selectionEnd: CORRECTED.length,
    replacementStart: at, replacementEnd: at + TYPED.length,
  });
  await cdp.send('Input.insertText', { text: CORRECTED });
  const out = await page.evaluate(() => ({
    email: (window as never as { __email: string[] }).__email,
    password: (window as never as { __password: string[] }).__password,
  }));
  await ctx.close();
  return out;
}

const kept = await typeBoth('__keepBuffer');   // the reported state: buffer still holds the email
const tapped = await typeBoth('__tap');        // what /connect does now
await browser.close();
srv.close();

// --------------------------------------------------------------------- the readings
/** Forward a value sequence through a diff, starting from `prev`, and return what went out. */
const forward = (diff: (a: string, b: string) => RemoteKey[], seq: string[], prev: string) => {
  const sent: RemoteKey[] = [];
  for (const v of seq) { for (const m of diff(prev, v)) sent.push(m); prev = v; }
  return sent;
};
const typed = (ks: RemoteKey[]) => ks.filter((k) => k.t === 'text').map((k) => (k as { text: string }).text).join('');
// The email appearing ANYWHERE in what the password field receives is the defect, so count
// occurrences rather than testing a prefix — a replay can land mid-stream.
const copies = (s: string) => s.split(EMAIL).length - 1;

console.log(`connect /stream keystroke forwarding — real-IME probe (${base})`);
console.log(`  buffer kept:  ${kept.email.length} email event(s), ${kept.password.length} password event(s)`);
console.log(`  buffer reset: ${tapped.email.length} email event(s), ${tapped.password.length} password event(s)`);
console.log(`  a correct run forwards ${CORRECTED.length} characters for a ${CORRECTED.length}-character password\n`);

let failures = 0;
const say = (ok: boolean, label: string, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}\n         ${detail}`);
};

// CONTROL FIRST. If the old code does not replay the email against this sequence then the
// sequence is not the bug, and everything below is measuring something else.
const legacyOut = typed(forward(legacyDiff, kept.password, EMAIL));
say(
  copies(legacyOut) >= 1,
  'CONTROL  the pre-fix diff re-types the email into the password field',
  copies(legacyOut) >= 1
    ? `${legacyOut.length} char(s) forwarded, containing the email ${copies(legacyOut)} time(s)`
    : 'it did NOT — this IME sequence does not reproduce the bug, so the readings below prove nothing',
);

// The shipped diff alone, with NO reset — the buffer still holds the email, and it must
// still never re-type it. This is the half that protects a user who never taps.
const keptOut = forward(diffKeystrokes, kept.password, EMAIL);
say(
  copies(typed(keptOut)) === 0,
  'shipped  diff alone, buffer still holding the email',
  `${typed(keptOut).length} char(s) forwarded, email replays: ${copies(typed(keptOut))}`,
);

// And with the reset the page now does when the user taps a different remote field.
const tappedOut = forward(diffKeystrokes, tapped.password, '');
say(
  copies(typed(tappedOut)) === 0 && typed(tappedOut).length <= TYPED.length + CORRECTED.length,
  'shipped  diff + the tap reset (what /connect now does)',
  `${typed(tappedOut).length} char(s) forwarded, email replays: ${copies(typed(tappedOut))}`,
);

// A diff that deletes more than it typed would eat a remote field's own contents.
for (const [label, out] of [['buffer kept', keptOut], ['buffer reset', tappedOut]] as const) {
  const back = out.filter((k) => k.t === 'key').length;
  say(back <= typed(out).length, `shipped  never deletes more than it typed (${label})`,
    `${back} Backspace(s) against ${typed(out).length} character(s)`);
}

console.log(`\n${failures ? `x ${failures} FAILURE(S)` : '+ the email is never re-typed, and the control proves the sequence reproduces the bug'}`);
process.exit(failures ? 1 : 0);
