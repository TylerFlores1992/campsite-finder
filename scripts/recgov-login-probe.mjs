// Drive the REAL recreation.gov login helper against a local fixture of rec.gov's shape.
//
// WHY THIS EXISTS.  On 2026-09-18 an Android user was told to reconnect auto-cart, the
// reconnect failed with correct credentials, and the only evidence anywhere was eight-second
// timeouts in logs/broker.log.  Nothing in this repo could exercise `openLoginModalAndFill`
// at all: it needs a browser on recreation.gov, and a browser here cannot reach it —
// `page.goto('https://www.recreation.gov/')` fails ERR_CERT_AUTHORITY_INVALID because the
// agent proxy re-terminates TLS and Chromium's own verifier does not trust its CA (`curl`
// does; the CA is in the system bundle and not in Chromium's).  So the helper was only ever
// tested by a person on a phone, days later.
//
// WHAT IT REPRODUCES, and it is taken from the box's own log rather than imagined:
//     19 x locator resolved to hidden <input value="" name="email" type="hidden"/>
// recreation.gov's page carries a HIDDEN input[name=email] ahead of the login modal in
// document order, so `EMAIL_SEL.first()` resolved to it and could never become visible.
// The fixture puts exactly that input exactly there.
//
// THE CONTROL IS THE POINT.  `legacyFill` below is a verbatim copy of the four lines that
// shipped before the fix, kept ONLY as the negative arm: the probe FAILS unless the old
// selector still cannot find the field and the shipped one can.  A rig that only exercises
// the fix cannot tell "the fix works" from "the fixture is too easy" — and this repo has
// published a verdict from a rig whose control never reproduced the failure.
//
// A SECOND ARM, ADDED 2026-09-20.  The hidden-input fix held and the failure moved one step:
// the email submits and no password field ever appears.  `noPassword` below is that shape,
// and it is the control for the page census the refusal now carries — the probe FAILS unless
// the refusal names what IS on the page (a code input, an alert, the second step's buttons)
// AND unless the address the fixture echoes back into a button label has been redacted out of
// it.  Both directions: delete the census and it fails, delete the redaction and it fails.
//
// IT TOUCHES NO CREDENTIAL AND NO REAL HOST.  A local http server, a synthetic email and a
// synthetic password, and nothing is ever printed but a boolean for whether they arrived.
//
// NOT scripts/auto-cart-bot/ DELIBERATELY: `CH_BOT_CODE_AT` is
// `git log -1 --format=%cI -- scripts/auto-cart-bot`, so a file there makes
// `autocart.bot_version` report the box as "MISSING bot-side changes", and the honest
// response to that warn is a box update — which ends the RC session.  This probe can never
// run on the box.
//
// USAGE:  node scripts/recgov-login-probe.mjs
//         RECGOV_PROBE_HEADED=1 node scripts/recgov-login-probe.mjs   (watch it)
import http from 'node:http';
import { chromium } from 'playwright-core';
import { openLoginModalAndFill } from './auto-cart-bot/recgov-login.mjs';

const EXE = process.env.RECGOV_PROBE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const EMAIL = 'probe-user@example.invalid';
const PASSWORD = 'probe-password-not-a-secret';

// ---------------------------------------------------------------- the fixture
// `hidden` places the trap: a hidden input[name=email] BEFORE the modal, which is the one
// fact the production log establishes about rec.gov's markup.
const page = ({ hidden = true, twoStep = false, opener = true, slowModal = 0, noPassword = false }) => `<!doctype html>
<meta charset="utf-8"><title>rec.gov fixture</title>
<body>
${hidden ? '<form id="newsletter"><input type="hidden" name="email" value=""></form>' : ''}
<header>${opener ? '<button id="opener" type="button">Sign Up / Log In</button>' : '<span>no control here</span>'}</header>
<div id="modal"></div>
<script>
window.__got = { email: null, password: null, submitted: false };
function mountModal() {
  const m = document.getElementById('modal');
  if (m.firstChild) return;                       // a real modal toggles; ours opens once
  m.innerHTML = \`<div role="dialog">
      <input id="em" type="email" name="email" autocomplete="username">
      \${${twoStep || noPassword} ? '' : '<input id="pw" type="password" name="password" autocomplete="current-password">'}
      <button id="go" type="button">Log In</button>
    </div>\`;
  document.getElementById('go').addEventListener('click', () => {
    window.__got.email = document.getElementById('em').value;
    const pw = document.getElementById('pw');
    window.__got.password = pw ? pw.value : null;
    window.__got.submitted = true;
  });
  ${noPassword ? `document.getElementById('em').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    setTimeout(() => {
      // The step after the email, with NO password field anywhere — which is what the box
      // logged on 2026-09-20. The button label carries the address on purpose: the probe
      // asserts it does not survive into the refusal.
      document.querySelector('[role=dialog]').innerHTML =
        '<div role="alert">We sent you something</div>'
        + '<input id="code" type="text" name="code" placeholder="Enter the code we sent">'
        + '<button type="button">Continue as ' + ${JSON.stringify(EMAIL)} + '</button>'
        + '<a href="#other">Use a different address</a>';
    }, 300);
  });` : ''}
  ${twoStep ? `document.getElementById('em').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    setTimeout(() => {
      if (document.getElementById('pw')) return;
      const pw = document.createElement('input');
      pw.id = 'pw'; pw.type = 'password'; pw.name = 'password'; pw.autocomplete = 'current-password';
      document.querySelector('[role=dialog]').insertBefore(pw, document.getElementById('go'));
    }, 400);
  });` : ''}
}
${opener ? `document.getElementById('opener').addEventListener('click', () => ${slowModal ? `setTimeout(mountModal, ${slowModal})` : 'mountModal()'});` : ''}
</script>`;

// `must` / `mustNot` are asserted against the REFUSAL, and they are the whole reason the
// fifth case is worth running: a refusal that merely fails proves the field is absent, which
// was never in doubt. What is under test is whether it says what is there instead.
const CASES = [
  { name: 'one-step modal, hidden input[name=email] first (the production shape)', opts: {}, expect: 'pass' },
  { name: 'two-step modal (email, then the password appears)', opts: { twoStep: true }, expect: 'pass' },
  { name: 'modal takes 3s to mount', opts: { slowModal: 3000 }, expect: 'pass' },
  {
    name: 'no "Log In" control on the page at all',
    opts: { opener: false },
    expect: 'fail',
    must: [/no VISIBLE recreation\.gov email field/],
  },
  {
    name: 'email submitted, NO password field ever appears (the 2026-09-20 shape)',
    opts: { noPassword: true },
    expect: 'fail',
    must: [
      /no VISIBLE recreation\.gov password field/,   // the refusal we already had
      /password inputs on the page: 0 match\(es\)/,   // and its reading: none, as the box logged
      /\[name=code\]/,                                // …and now, WHAT IS THERE instead
      /\(placeholder\)/,                              // the attribute's presence
      /alertx1/,                                       // a banner, by class and not by its words
      /"Continue as \[address\]"/,                    // the label, with the address taken out
      /"Use a different address"/,                     // the way back, which names the second step
    ],
    mustNot: [
      new RegExp(EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),  // the address itself
      /Enter the code we sent/,                        // the placeholder's TEXT
      /We sent you something/,                         // the page's own copy
    ],
  },
];

// -------------------------------------------- the control: what shipped before the fix
const LEGACY_EMAIL_SEL =
  'input[type="email"], input[name="email"], input[autocomplete="username"], input[autocomplete="email"], input#email';
const LEGACY_PW_SEL =
  'input[type="password"], input[name="password"], input[autocomplete="current-password"], input#password';
async function legacyFill(p, email, password) {
  let opener = p.getByRole('button', { name: /log ?in/i }).first();
  if (!(await opener.isVisible().catch(() => false))) opener = p.getByRole('link', { name: /log ?in/i }).first();
  if (!(await opener.isVisible().catch(() => false))) opener = p.locator('button:has-text("Log In"), a:has-text("Log In")').first();
  if (await opener.isVisible().catch(() => false)) { await opener.click().catch(() => {}); await p.waitForTimeout(1500); }
  const em = p.locator(LEGACY_EMAIL_SEL).first();
  await em.waitFor({ state: 'visible', timeout: 8000 });
  await em.fill(email);
  let pw = p.locator(LEGACY_PW_SEL).first();
  if (!(await pw.isVisible().catch(() => false))) {
    await p.keyboard.press('Enter').catch(() => {});
    await p.waitForTimeout(1200);
    pw = p.locator(LEGACY_PW_SEL).first();
    await pw.waitFor({ state: 'visible', timeout: 8000 });
  }
  await pw.fill(password);
  const submit = p.locator('[role="dialog"] button:has-text("Log In"), [role="dialog"] button:has-text("Sign In"), form button[type="submit"]').first();
  if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {});
  else await pw.press('Enter').catch(() => {});
}

// ------------------------------------------------------------------------ the run
let opts = {};
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(opts));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const browser = await chromium.launch({
  headless: !process.env.RECGOV_PROBE_HEADED,
  executablePath: EXE,
  args: ['--no-sandbox'],
});

/** Run one fill implementation against one fixture. Never prints a credential. */
async function run(fill, caseOpts) {
  opts = caseOpts;
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(base);
  let err = null;
  try { await fill(p, EMAIL, PASSWORD); } catch (e) { err = String(e?.message || e); }
  await p.waitForTimeout(300);
  const got = await p.evaluate(() => window.__got).catch(() => null);
  await ctx.close();
  return {
    ok: !err && !!got?.submitted && got.email === EMAIL && got.password === PASSWORD,
    err,
    // Booleans only. The values are synthetic, and printing them anyway would make this the
    // kind of diagnostic that has to be filtered later.
    detail: got ? `submitted=${got.submitted} email=${got.email === EMAIL} password=${got.password === PASSWORD}` : 'no page state',
  };
}

let failures = 0;
console.log(`rec.gov login helper — fixture probe (${base})\n`);
for (const c of CASES) {
  const now = await run(openLoginModalAndFill, c.opts);
  const want = c.expect === 'pass';
  // THE VERDICT LINE HAS TO INCLUDE THE CONTENT CHECKS, and the first version printed it
  // before running them — so a case whose census had been deleted printed `OK` with five
  // FAIL lines underneath and a count at the foot of the output. A reader scanning the OK
  // column sees a clean run; a header that disagrees with the body beneath it is worse than
  // no header, because it is the line people quote.
  const bad = [];
  for (const re of c.must ?? []) if (!now.err || !re.test(now.err)) bad.push(`never says ${re}`);
  for (const re of c.mustNot ?? []) if (now.err && re.test(now.err)) bad.push(`LEAKS ${re}`);
  const good = now.ok === want && bad.length === 0;
  if (!good) failures += (now.ok === want ? 0 : 1) + bad.length;
  console.log(`${good ? 'OK  ' : 'FAIL'} shipped   ${c.name}`);
  console.log(`         ${now.ok ? now.detail : `refused: ${now.err ?? now.detail}`}`);
  for (const b of bad) console.log(`         FAIL — the refusal ${b}`);
  if (!want && now.err) console.log(`         refusal reads: ${now.err}`);
}

console.log('\n--- CONTROL: the selector that shipped before 2026-09-18 ---');
const legacy = await run(legacyFill, {});
console.log(`${legacy.ok ? 'FAIL' : 'OK  '} legacy    one-step modal, hidden input[name=email] first`);
console.log(`         ${legacy.ok ? 'it PASSED — the fixture does not reproduce the bug, so the run above proves nothing' : `refused: ${legacy.err}`}`);
if (legacy.ok) failures++;
// The exact production symptom, or the fixture is reproducing something else.
if (!legacy.ok && !/resolved to hidden/.test(legacy.err ?? '')) {
  failures++;
  console.log('         FAIL — it refused for a DIFFERENT reason than the box logged');
}

// A control that never reproduces the failure is the whole hazard, so say which way it went.
console.log(`\n${failures ? `x ${failures} FAILURE(S)` : '+ the fix holds and the old selector still cannot'}`);
await browser.close();
srv.close();
process.exit(failures ? 1 : 0);
