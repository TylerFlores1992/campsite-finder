#!/usr/bin/env tsx
/**
 * ReserveCalifornia cart-mechanism canary — the tripwire for the fragile part.
 *
 * The RC auto-cart approach (see docs/CONTEXT.md → "ReserveCalifornia auto-cart") rests
 * on a handful of undocumented facts reverse-engineered from RC's own web bundle. The
 * real risk isn't that we got them wrong — it's that RC quietly CHANGES them in a
 * routine rebuild and the feature stops working with no error anywhere. This asserts
 * those facts still hold, so that silent breakage becomes a loud one.
 *
 * It needs NO login and holds NO inventory — it reads the public bundle and pokes the
 * cart endpoint unauthenticated (expecting a 401). Safe to run on a schedule.
 *
 * Run:  NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-cart-canary.mts
 * Exit: 0 = all invariants hold; 1 = at least one broke (prints which). The non-zero
 * exit is what a wrapping Routine/cron keys its alert off.
 *
 * WHEN THIS FIRES: don't panic and don't trust the old notes — RC changed something.
 * Re-capture the cart flow from a live authenticated trace and update both this file's
 * INVARIANTS and the findings in scripts/auto-cart-bot/reservecalifornia.mjs.
 */

const RC_HOME = 'https://www.reservecalifornia.com/';
const RC_CART_ENDPOINT =
  'https://rdapi.reservecalifornia.com/api/webaccesscustomer/load/shoppingcart';

// The load-bearing facts, each with a plain-English "why we care". If RC renames or
// moves any of these, the corresponding half of the auto-cart design breaks.
const BUNDLE_INVARIANTS: Array<{ needle: string; why: string }> = [
  {
    needle: 'setItem("shoppingCartKey"',
    why: 'the cart key must live in localStorage["shoppingCartKey"] — the whole adopt/clone mechanism writes exactly this',
  },
  {
    needle: 'getItem("shoppingCartKey"',
    why: 'the app must READ the key from localStorage (not the URL) — this is why a cart is session/storage-scoped',
  },
  {
    needle: 'webaccesscustomer/load/shoppingcart',
    why: 'the endpoint that loads a cart by key must still exist at this path',
  },
  {
    needle: 'extendShoppingCartTimer',
    why: 'the extendable-hold assumption (past 15 min) depends on this call existing',
  },
];

/**
 * The precart chunk carries the second half of the design: how a facility's required
 * "extras" are answered. Both the KEY NAMES and the checkbox value rule were read out of
 * this file, and getting either wrong fails in the most misleading way available — RC
 * answers HTTP 200 with `IsSuccess: false` naming the field, which reads as a wrong VALUE
 * when it is really a wrong KEY. Five rounds of guessing were spent there.
 *
 * The chunk's filename is content-hashed, so it must be discovered through the import
 * graph (index → Route → FacilityPreCart) rather than pinned.
 */
const PRECART_INVARIANTS: Array<{ needle: string; why: string }> = [
  {
    needle: 'extraId:',
    why: 'the wire key is lowerCamel `extraId` — PascalCase is silently ignored and the required-field error never clears',
  },
  {
    needle: 'extraValue:',
    why: 'the wire key is lowerCamel `extraValue` — same failure mode as extraId',
  },
  {
    needle: 'UnitDetail.Extras',
    why: 'the extras we must answer are read from UnitDetail.Extras.$values in the load response',
  },
  {
    needle: 'IsWebRequired',
    why: 'which extras are mandatory is decided by this flag; without it we cannot tell what must be answered',
  },
  {
    needle: 'IsWebViewable',
    why: 'only viewable extras are submitted — sending the others is a difference from what the real UI does',
  },
];

type Check = { name: string; ok: boolean; detail: string };

async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  // The worker reaches RC directly; this script runs behind the agent proxy, which
  // NODE_USE_ENV_PROXY wires into Node's fetch. Give RC a real browser UA — its WAF
  // 403s obvious bots, and a canary that trips the WAF would cry wolf.
  return fetch(url, {
    ...init,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      ...(init?.headers ?? {}),
    },
  });
}

/** Find the current hashed main bundle URL from the index — the filename rotates on
 *  every RC deploy, so it must be discovered, never hard-coded. */
async function resolveBundleUrl(): Promise<string> {
  const res = await proxiedFetch(RC_HOME);
  if (!res.ok) throw new Error(`RC home returned ${res.status}`);
  const html = await res.text();
  const m = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (!m) throw new Error('could not find /assets/index-*.js in RC home — page shape changed');
  return new URL(m[0], RC_HOME).toString();
}

/** Follow the import graph to the precart chunk. Every filename is content-hashed, so
 *  each hop must be read out of the file before it — pinning any of them means the canary
 *  keeps checking a bundle RC no longer serves. */
async function resolvePrecartChunkUrl(indexJs: string): Promise<string> {
  const chunkIn = (js: string, prefix: string) => {
    const m = js.match(new RegExp(`${prefix}-[A-Za-z0-9_-]{6,12}\\.js`));
    if (!m) throw new Error(`no ${prefix}-*.js reference found`);
    return new URL(`/assets/${m[0]}`, RC_HOME).toString();
  };
  // index lazy-loads a single Route chunk, which is what actually lists every page.
  const routeRes = await proxiedFetch(chunkIn(indexJs, 'Route'));
  if (!routeRes.ok) throw new Error(`Route chunk returned ${routeRes.status}`);
  return chunkIn(await routeRes.text(), 'FacilityPreCart');
}

async function run(): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. Bundle invariants.
  let bundleUrl = '';
  try {
    bundleUrl = await resolveBundleUrl();
    const res = await proxiedFetch(bundleUrl);
    if (!res.ok) throw new Error(`bundle returned ${res.status}`);
    const js = await res.text();
    for (const inv of BUNDLE_INVARIANTS) {
      const ok = js.includes(inv.needle);
      checks.push({
        name: `bundle: ${inv.needle}`,
        ok,
        detail: ok ? 'present' : `MISSING — ${inv.why}`,
      });
    }

    // 1b. Precart chunk invariants — the extras contract.
    try {
      const precartUrl = await resolvePrecartChunkUrl(js);
      const pRes = await proxiedFetch(precartUrl);
      if (!pRes.ok) throw new Error(`precart chunk returned ${pRes.status}`);
      const pJs = await pRes.text();
      for (const inv of PRECART_INVARIANTS) {
        const ok = pJs.includes(inv.needle);
        checks.push({
          name: `precart: ${inv.needle}`,
          ok,
          detail: ok ? 'present' : `MISSING — ${inv.why}`,
        });
      }
      // ExtraType 0 = CheckBox lives in its own tiny enum chunk. If RC renumbers it, a
      // required checkbox stops being recognised as one and we answer it with the wrong
      // kind of value — a silent failure, so assert the number, not just the name.
      const enumUrl = new URL(
        `/assets/${pJs.match(/extraTypes-[A-Za-z0-9_-]{6,12}\.js/)?.[0] ?? ''}`,
        RC_HOME,
      ).toString();
      const eRes = await proxiedFetch(enumUrl);
      const eJs = eRes.ok ? await eRes.text() : '';
      const ok = /\[\s*e\.CheckBox\s*=\s*0\s*\]|e\[e\.CheckBox=0\]/.test(eJs);
      checks.push({
        name: 'precart: ExtraType.CheckBox === 0',
        ok,
        detail: ok
          ? 'present'
          : 'MISSING — the ExtraType enum was renumbered; a required checkbox would be answered as free text',
      });
    } catch (err) {
      checks.push({
        name: 'precart: chunk',
        ok: false,
        detail: `could not read the precart chunk (${(err as Error).message}) — cannot verify the extras contract`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'bundle: fetch',
      ok: false,
      detail: `could not read the RC bundle (${(err as Error).message}) — cannot verify cart internals`,
    });
  }

  // 2. Cart endpoint is alive and still auth-gated. Unauthenticated it must answer 401
  //    (exists, needs a token) — NOT 404 (moved/renamed) and NOT 200 (auth dropped).
  try {
    const res = await proxiedFetch(RC_CART_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', installationsidentity: 'cali', storeid: '111' },
      body: JSON.stringify({ shoppingCartKey: '00000000-0000-0000-0000-000000000000' }),
    });
    const ok = res.status === 401;
    checks.push({
      name: 'endpoint: load/shoppingcart auth-gate',
      ok,
      detail: ok
        ? '401 as expected (exists, token required)'
        : `expected 401, got ${res.status} — endpoint moved, or the auth model changed`,
    });
  } catch (err) {
    checks.push({
      name: 'endpoint: load/shoppingcart auth-gate',
      ok: false,
      detail: `could not reach the cart endpoint (${(err as Error).message})`,
    });
  }

  return checks;
}

const checks = await run();
const failed = checks.filter((c) => !c.ok);
const stamp = new Date().toISOString();

console.log(`RC cart-mechanism canary — ${stamp}`);
for (const c of checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name} — ${c.detail}`);

// `--notify` emails the owner ON FAILURE ONLY, so a daily schedule stays silent until
// something actually breaks — the whole point is to turn a silent RC change into one
// loud message, not a daily "still fine" that trains you to ignore it.
if (failed.length && process.argv.includes('--notify')) {
  const to = process.env.CANARY_ALERT_EMAIL ?? 'tylerflores1992@gmail.com';
  try {
    const { sendEmail } = await import('../src/lib/notifications/email');
    const lines = failed.map((c) => `• ${c.name} — ${c.detail}`).join('<br>');
    await sendEmail({
      to,
      subject: `⚠️ ReserveCalifornia cart-mechanism canary FAILED (${failed.length})`,
      html: `<p><strong>RC changed something the auto-cart design depends on.</strong> ${stamp}</p>
<p>${lines}</p>
<p>Re-capture the cart flow from a live authenticated trace, then update
<code>scripts/auto-cart-bot/reservecalifornia.mjs</code> and <code>docs/CONTEXT.md</code>.
Until then, treat RC auto-cart as unverified.</p>`,
    });
    console.log(`\nAlerted ${to}.`);
  } catch (err) {
    console.log(`\nCould not email the alert (${(err as Error).message}) — the non-zero exit stands.`);
  }
}

if (failed.length) {
  console.log(`\n${failed.length} invariant(s) BROKE. ReserveCalifornia changed something the`);
  console.log('auto-cart design depends on. Re-capture the flow before trusting it, and update');
  console.log('scripts/auto-cart-bot/reservecalifornia.mjs + docs/CONTEXT.md.');
  process.exit(1);
}
console.log('\nAll cart-mechanism invariants hold.');
process.exit(0);
