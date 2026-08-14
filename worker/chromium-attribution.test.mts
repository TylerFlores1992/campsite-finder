/**
 * TELLING THE TWO CHROMIUM FAMILIES APART.
 *
 * On 2026-08-12 a single chrome.exe on one of our profiles reached 9.4 GB private, growing
 * ~395 MB/min, and drove Windows COMMIT to 99% of 50 GB. At that point `supervise.ps1` could
 * not start a shell ("the paging file is too small", then an OutOfMemoryException), so the
 * process whose entire job is recovery failed at the one moment it exists for - and with it
 * every remote lever, because they all ride a poller on that box. It ended with somebody
 * power-cycling the machine by hand.
 *
 * WHICH FAMILY LEAKED WAS GUESSED TWICE AND WRONG BOTH TIMES, and it could not have been
 * settled by reading the regexes, because both profiles live under the same directory:
 *
 *     RC       ...\scripts\auto-cart-bot\.rc-bot-profile
 *     rec.gov  ...\scripts\auto-cart-bot\profiles\<userId>
 *
 * Two consequences, both tested here:
 *
 *   1. `memory` reported a COUNT and a TOTAL and nothing else, so it could not attribute the
 *      growth to either family. A diagnostic that cannot distinguish the two candidate causes
 *      of the failure it was written for is not yet a diagnostic.
 *   2. `kill-chrome recgov` matched `auto-cart-bot` and therefore ALSO matched the RC
 *      profile - so the lever you reach for precisely BECAUSE restart-rc leaves rec.gov alone
 *      would have taken the live RC session down with it. Having three scopes is only worth
 *      anything if two of them are survivable at 07:50.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const botFile = readFileSync('scripts/auto-cart-bot/bot-commands.mjs', 'utf8');

/** The real shapes, as they appear on the box - see rc-keepwarm.mjs and bot.mjs. */
const RC = String.raw`--user-data-dir=C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\.rc-bot-profile`;
const RECGOV = String.raw`--user-data-dir=C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\profiles\user_42`;
const THEIRS = String.raw`--user-data-dir=C:\Users\Tyler\AppData\Local\Google\Chrome\User Data`;

/**
 * Pull a `$pat = '...'` line out of the handler exactly as the box will use it.
 *
 * The patterns are PowerShell string literals inside a JS string literal, so `\\S` in the
 * source is the two characters `\S` that .NET's regex engine sees. Reading them out of the
 * file rather than restating them is the point: a test that copies the pattern tests the
 * copy, which is the mistake `rc-holds-readout.test.mts` was written to avoid.
 */
function scopePattern(scope: string): RegExp {
  const m = botFile.match(new RegExp(`${scope}: "\\$pat = '(.+?)';"`));
  assert.ok(m, `could not find the ${scope} pattern in bot-commands.mjs`);
  return new RegExp(m![1]!.replace(/\\\\/g, '\\'));
}

test('kill-chrome rc reaches only the RC profile', () => {
  const rc = scopePattern('rc');
  assert.ok(rc.test(RC), 'the RC profile is in scope');
  assert.ok(!rc.test(RECGOV), 'a rec.gov profile is not');
  assert.ok(!rc.test(THEIRS), "and never the browser of whoever is sitting at the machine");
});

test('kill-chrome recgov does NOT reach the RC profile', () => {
  // THE BUG (2026-08-14). `--user-data-dir=\S*auto-cart-bot` matches the RC path too,
  // because `auto-cart-bot` is its PARENT directory. Killing the RC Chromium is killing the
  // session - the access token lives in that browser - so this scope was one keystroke from
  // ending a session it has no business touching.
  const recgov = scopePattern('recgov');
  assert.ok(recgov.test(RECGOV), 'rec.gov profiles are in scope');
  assert.ok(!recgov.test(RC), 'the RC profile must NOT be, or the scope is a lie');
  assert.ok(!recgov.test(THEIRS), 'and never somebody else browser');
});

test('kill-chrome all reaches both of ours and nothing else', () => {
  const all = scopePattern('all');
  assert.ok(all.test(RC) && all.test(RECGOV), 'both families');
  assert.ok(!all.test(THEIRS), 'still never a personal profile');
});

test('memory names the profile directory per process, not just a count', () => {
  // A count cannot be attributed and a total cannot be attributed. The growth RATE across
  // two readings is the signature (~320-395 MB/min in all three sightings), and a rate is
  // only useful once you know WHICH process it belongs to.
  const mem = botFile.slice(botFile.indexOf("'memory':"), botFile.indexOf("'kill-chrome':"));
  assert.match(mem, /--user-data-dir=\(\\\\S\+\)/,
    'it must capture the user-data-dir, not merely match on it');
  assert.match(mem, /\$o\.ProcessId/, 'and report a pid, so two readings can be paired up');
  assert.match(mem, /rc-bot-profile.*fam = 'rc'/,
    'the RC family is decided by the specific path');
  // ORDER IS LOAD-BEARING: `.rc-bot-profile` sits *inside* `auto-cart-bot`, so testing the
  // general pattern first would file every RC process under rec.gov - which is precisely the
  // misattribution this whole test exists to prevent.
  assert.ok(
    mem.indexOf("fam = 'rc'") < mem.indexOf("fam = 'recgov'"),
    'the specific profile must be tested BEFORE the directory that contains it',
  );
  assert.match(mem, /FAMILY/, 'and it totals per family, which is the line you compare');
});

test('memory still refuses to print a whole Chromium command line', () => {
  // Chromium argv carries flags and sometimes URLs. The rule this file is built on is that a
  // field you would have to filter is better not collected - the precart diagnostic shipped
  // an OAuth authorization code by reporting `location.href`. The profile DIRECTORY is the
  // one field needed to attribute a leak, so it is the only one taken.
  const mem = botFile.slice(botFile.indexOf("'memory':"), botFile.indexOf("'kill-chrome':"));
  const code = mem.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/\$o\.CommandLine'/.test(code) && !/-f .*CommandLine/.test(code),
    'the command line must never be formatted into the answer');
});

test('every Chromium kill pattern matches Chrome\'s QUOTED child processes', async () => {
  /**
   * THE BUG THIS EXISTS FOR (2026-08-14), and it cost an entire night.
   *
   * Playwright launches the PARENT Chromium with the profile path unquoted. Chrome then
   * re-quotes it when it spawns its own renderer/GPU/utility children:
   *
   *   parent:  --user-data-dir=C:\…\.rc-bot-profile
   *   child:   --user-data-dir="C:\…\.rc-bot-profile"
   *
   * stop-rc.ps1 and stop-all.ps1 matched with `[^"]*`, which CANNOT cross that opening
   * quote — so every stop killed the parent and left every child alive, still holding the
   * real Chrome lock on the user-data-dir. Deleting our own lock file does not touch that
   * lock. The orphans accumulated (seven were found on one profile), and the next browser
   * to open it met a LOCKED profile and rendered a BLANK PAGE — which is the white
   * ReserveCalifornia page that was blamed, in turn, on RC, the WAF, a service worker, the
   * JS bundle, Playwright's version, the profile data and the token-capture hook.
   *
   * `kill-chrome` used `\S*` and was right the whole time, which is exactly why that lever
   * worked when stop-rc did not — a difference nobody could see by reading either file.
   * Guarded mechanically or not at all.
   */
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = 'scripts/auto-cart-bot/mini-pc';
  const PROFILE = 'C:\\Users\\Tyler\\campsite-finder\\scripts\\auto-cart-bot\\.rc-bot-profile';
  const parent = `--user-data-dir=${PROFILE}`;
  const child = `--user-data-dir="${PROFILE}"`;

  const sources: [string, string][] = readdirSync(dir)
    .filter((f) => f.endsWith('.ps1'))
    .map((f) => [`${dir}/${f}`, readFileSync(`${dir}/${f}`, 'utf8')]);
  sources.push(['scripts/auto-cart-bot/bot-commands.mjs',
    readFileSync('scripts/auto-cart-bot/bot-commands.mjs', 'utf8')]);

  let checked = 0;
  for (const [file, src] of sources) {
    for (const line of src.split('\n')) {
      // Assignments only — the header comments quote the BROKEN pattern deliberately, to
      // explain it, and a test that failed on its own explanation would be fixed by deleting
      // the explanation. Same trap as `code()` stripping comments elsewhere in this suite.
      const m = /^\s*\$[A-Za-z_]\w*\s*=\s*'(--user-data-dir=[^']+)'/.exec(line)
        ?? /^\s*(?:rc|recgov|all):\s*"\$pat = '(--user-data-dir=[^']+)'/.exec(line);
      if (!m) continue;
      checked++;
      // Unescape the JS-string doubling used in bot-commands.mjs (\\S* in source is \S*).
      const pattern = m[1].replace(/\\\\/g, '\\');
      let re: RegExp;
      try { re = new RegExp(pattern); } catch { continue; }
      // recgov deliberately EXCLUDES the RC profile via a negative lookahead, so it is
      // asserted on its own directory instead of on the one it is built to skip.
      const subject = /\(\?!/.test(pattern)
        ? [parent, child].map((s) => s.replace('.rc-bot-profile', 'profiles\\u1'))
        : [parent, child];
      assert.ok(re.test(subject[0]), `${file}: ${pattern} misses the UNQUOTED parent`);
      assert.ok(
        re.test(subject[1]),
        `${file}: ${pattern} misses Chrome's QUOTED child processes. ` +
        'Killing the parent then leaves them holding the profile lock, and the next ' +
        'browser to open that profile renders a blank page. Use \\S*, never [^"]*.',
      );
    }
  }
  assert.ok(checked >= 3, `expected to find the kill patterns, checked only ${checked}`);
});
