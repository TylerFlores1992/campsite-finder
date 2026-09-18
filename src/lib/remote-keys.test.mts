import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diffKeystrokes, CARET_MOVING_KEYS, type RemoteKey } from './remote-keys.ts';

const CONNECT = readFileSync(new URL('../app/connect/page.tsx', import.meta.url), 'utf8');
/** Comments are stripped before any structural match, or a guard fails on its own explanation. */
const code = CONNECT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/**
 * The opening tag of the `<tag ...>` element whose attributes contain `needle`, bounded by the
 * ELEMENT and never by a character window. Two reasons, both paid for: a window measured in
 * characters is a guess about layout (four guards in this repo have broken on one), and the first
 * version of the reveal guard sliced +-400 chars around `setShowPassword` — which `indexOf` found
 * at the `useState` DECLARATION, four hundred lines from the button. It passed nothing and failed
 * for the wrong reason.
 */
function jsxOpeningTag(needle: string, tag: string): string {
  const at = code.indexOf(needle);
  assert.ok(at > -1, `anchor missing: ${needle} — this guard is measuring nothing`);
  const start = code.lastIndexOf(`<${tag}`, at);
  assert.ok(start > -1, `no <${tag}> around ${needle}`);
  // Stop at the first `>` OUTSIDE braces: `onClick={() => ...}` and `aria-label={a ? b : c}` both
  // carry a `>` that is not the end of the tag.
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    else if (code[i] === '>' && depth === 0 && i > start) {
      const tagText = code.slice(start, i + 1);
      assert.ok(tagText.includes(needle), `the <${tag}> around ${needle} closed before reaching it`);
      return tagText;
    }
  }
  return assert.fail(`unterminated <${tag}> opening tag around ${needle}`);
}
/** The body of a `const <name> = ...` arrow, up to its closing `};` at the same indent. */
function body(name: string): string {
  const at = code.indexOf(`const ${name} = `);
  assert.ok(at > -1, `anchor missing: const ${name} = — this guard is measuring nothing`);
  const end = code.indexOf('\n  };', at);
  assert.ok(end > at, `closing brace for ${name} not found`);
  return code.slice(at, end);
}
const text = (ks: RemoteKey[]) => ks.filter((k) => k.t === 'text').map((k) => (k as { text: string }).text).join('');
const backspaces = (ks: RemoteKey[]) => ks.filter((k) => k.t === 'key' && k.key === 'Backspace').length;

const EMAIL = 'someone@example.com';

test('an append forwards only the new characters', () => {
  const ks = diffKeystrokes('abc', 'abcde');
  assert.equal(backspaces(ks), 0);
  assert.equal(text(ks), 'de');
});

test('a trim forwards only Backspaces', () => {
  const ks = diffKeystrokes('abcde', 'abc');
  assert.equal(backspaces(ks), 2);
  assert.equal(text(ks), '');
});

test('no change forwards nothing', () => {
  assert.deepEqual(diffKeystrokes('abc', 'abc'), []);
});

test('a rewrite is a correction, NOT a replay of the whole buffer', () => {
  // The arm that shipped before 2026-09-18 re-sent the entire value here.
  const ks = diffKeystrokes('abcd', 'abce');
  assert.equal(backspaces(ks), 1);
  assert.equal(text(ks), 'e');
});

test('THE REPORTED BUG: an autocorrect in the password never re-types the email', () => {
  // The production shape: one overlay buffer, an email typed into the remote email field,
  // then a password typed straight after it with no space — one token to an Android IME, so
  // a single autocorrect rewrites a character inside it.
  const before = `${EMAIL}Sekrit9`;
  const after = `${EMAIL}Secret9`;
  const ks = diffKeystrokes(before, after);
  assert.ok(!text(ks).includes(EMAIL), 'the email was forwarded into the password field');
  assert.ok(text(ks).length <= 8, `forwarded ${text(ks).length} characters for a one-word correction`);
  // And the correction is correct, not merely small.
  assert.equal(before.slice(0, before.length - backspaces(ks)) + text(ks), after);
});

test('every keystroke after the email costs one character, not an email', () => {
  // Walk a password in one character at a time with the buffer still holding the email —
  // the case a user who never taps a different field is in.
  let prev = EMAIL;
  let forwarded = '';
  for (const ch of 'hunter2!') {
    const ks = diffKeystrokes(prev, prev + ch);
    forwarded += text(ks);
    assert.equal(backspaces(ks), 0);
    prev += ch;
  }
  assert.equal(forwarded, 'hunter2!');
});

test('it can never delete more than it typed', () => {
  // The safety property that makes forwarding Backspaces acceptable at all: the count is
  // bounded by `prev`, and `prev` only ever holds characters this module already forwarded.
  // A "select all and replace" therefore costs our own keystrokes, never the remote field's
  // own contents.
  for (const [a, b] of [['abcdef', 'xyz'], ['abc', ''], ['', 'abc'], [EMAIL, 'p']] as const) {
    assert.ok(backspaces(diffKeystrokes(a, b)) <= Array.from(a).length,
      `deleted more than it had typed: ${a} -> ${b}`);
  }
});

test('an astral character is never split into half a surrogate pair', () => {
  const ks = diffKeystrokes('', 'a\u{1F600}b');
  assert.deepEqual(text(ks), 'a\u{1F600}b');
  assert.equal(ks.filter((k) => k.t === 'text').length, 3, 'one message per CODE POINT');
});

test('Backspace and Delete are NOT caret-moving keys', () => {
  // They shrink the buffer, so the diff already sees them. Forwarding them here as well
  // would eat a character the user meant to keep.
  assert.ok(!CARET_MOVING_KEYS.includes('Backspace'));
  assert.ok(!CARET_MOVING_KEYS.includes('Delete'));
  for (const k of ['Enter', 'Tab', 'ArrowLeft']) assert.ok(CARET_MOVING_KEYS.includes(k), `${k} moves the caret`);
});

// ── /connect actually USES it — the fix-present-and-inert shape ────────────────────────────

test('/connect forwards through diffKeystrokes and keeps no replay arm of its own', () => {
  assert.match(code, /import \{[^}]*diffKeystrokes[^}]*\} from '@\/lib\/remote-keys'/,
    'the page must import the shared diff, not carry a copy');
  const fn = body('onTextInput');
  assert.match(fn, /diffKeystrokes\(kbPrevRef\.current, v\)/, 'onTextInput must call the shared diff');
  // The whole bug in one token: the old arms tested `startsWith` and then re-sent the value.
  assert.doesNotMatch(fn, /startsWith/, 'onTextInput has grown its own diff back');
});

test('/connect drops the buffer when the remote caret may have moved', () => {
  // Half the report is that the buffer still held the EMAIL when the user tapped the password
  // field. A tap and a caret-moving key are the two ways that happens.
  assert.match(code, /^\s*onPointerDown=\{\(e\) => \{[^}]*resetBuffer\(\)/m,
    'a tap on the stream must drop the buffer');
  const keys = body('onKeyDown');
  assert.match(keys, /CARET_MOVING_KEYS\.includes\(e\.key\)/);
  assert.match(keys, /resetBuffer\(\)/, 'a caret-moving key must drop the buffer');
});

test('dropping the buffer sends NOTHING to the remote page', () => {
  // It is forgetting what we typed, not asking rec.gov to unwind it. A resetBuffer that
  // forwarded Backspaces would delete the email out of the field the user just left.
  const fn = body('resetBuffer');
  assert.doesNotMatch(fn, /send\(/, 'resetBuffer must not forward anything');
  assert.match(fn, /kbPrevRef\.current = ''/);
  assert.match(fn, /kbRef\.current\.value = ''/, 'the input itself must be cleared, not just the tracker');
});

test('the password reveal is a button, never a submit', () => {
  // A bare <button> inside a <form> defaults to type=submit, so the tap meant to reveal the
  // password would send the credentials instead. Anchored on the TOGGLE'S OWN ELEMENT: the call
  // site, not `setShowPassword` — which `indexOf` finds first at the useState declaration.
  const toggle = jsxOpeningTag('setShowPassword((v) => !v)', 'button');
  assert.match(toggle, /type="button"/, 'the reveal toggle must be type="button"');
});

test('the password field actually reveals, and reveals without autocorrecting', () => {
  const pw = jsxOpeningTag("type={showPassword ? 'text' : 'password'}", 'input');
  // Revealing turns it into type=text, and Android will capitalise the first character of a
  // password that was typed correctly unless these are off.
  for (const attr of ['autoCapitalize="none"', 'autoCorrect="off"', 'spellCheck={false}']) {
    assert.ok(pw.includes(attr), `the password field must carry ${attr}`);
  }
});

// ── the probes — nothing runs them, so nothing notices when they rot ───────────────────────

test('the sign-in probes parse and keep their deliberate playwright-core import', () => {
  // NOT added to worker/rc-mem-dump.test.mts's probe list, which covers the leak probes: that
  // file is under `worker/**`, the FIRST entry in worker-deploy.yml's `paths:`, so editing it
  // restarts all three pollers — and this change is a web page and a bot helper. Same two
  // properties, asserted where they cost nothing.
  const probes = ['scripts/recgov-login-probe.mjs', 'scripts/connect-keys-probe.mts'];
  let checked = 0;
  for (const name of probes) {
    const url = new URL(`../../${name}`, import.meta.url);
    const src = readFileSync(url, 'utf8');
    assert.match(src, /from 'playwright-core'/,
      `${name} must import playwright-core — bare 'playwright' is not installed in the sandbox`);
    assert.doesNotMatch(src, /from 'playwright'/, `${name} imports bare playwright`);
    if (name.endsWith('.mjs')) {
      const r = spawnSync(process.execPath, ['--check', fileURLToPath(url)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${name} does not parse: ${r.stderr}`);
    }
    // A probe whose control cannot fail is a probe that proves nothing — this repo has
    // published a verdict from one. Both carry an arm that exercises the PRE-FIX behaviour.
    assert.match(src, /legacy/i, `${name} has lost its pre-fix control arm`);
    checked++;
  }
  assert.equal(checked, probes.length, 'a probe went missing — this guard must not silently shrink');
});
