// The report channel must not publish a secret it was merely handed by the engine.
//
// This file outlives the injected sign-in that produced its motivating incident. On
// 2026-08-16 a user's real ReserveCalifornia password reached `client_reports` because
// WebKit quotes the failing SOURCE EXPRESSION in a TypeError and the bundle's global error
// listener reported the message verbatim. The sign-in has since been reverted; the rule has
// not, because the mechanism belongs to the reporter and not to that one call site — ANY
// future expression touching a secret is published the same way.
//
// Same lesson as the OAuth authorization code reported via `location.href` on 2026-08-09,
// and the same remedy: do not publish a field you would then have to filter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildPrecartScript } from '../src/lib/rc-precart-script.js';

/** Run the REAL served `scrub`, not a copy of the regex — a copy would assert the copy. */
function scrubbed(input: string): string {
  const bundle = buildPrecartScript();
  const src = bundle.slice(bundle.indexOf('function scrub'), bundle.indexOf('function href'));
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  ctx.input = input;
  vm.runInContext(`${src}\n out = scrub(input);`, ctx);
  return String(ctx.out);
}

test("scrub drops WebKit's source quote, keeping the diagnosis", () => {
  const out = scrubbed(
    "TypeError: window.__chRcLogin is not a function. "
    + `(In 'window.__chRcLogin("a@b.com", "hunter2!")', 'window.__chRcLogin' is undefined)`,
  );
  assert.ok(!out.includes('hunter2!'), `the password survived: ${out}`);
  assert.ok(!out.includes('a@b.com'), `the email survived: ${out}`);
  assert.match(out, /is not a function/, 'the useful half must survive — only the quote goes');
});

test('an ordinary message is untouched', () => {
  // A scrubber that eats real diagnostics gets deleted by the next person it inconveniences,
  // and would take the rule above with it.
  const msg = 'ReferenceError: chFind is not defined';
  assert.equal(scrubbed(msg), msg);
});

test('a JWT is still redacted — the older rule is not lost', () => {
  const out = scrubbed('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig here');
  assert.match(out, /<token>/);
  assert.ok(!out.includes('eyJhbGci'));
});
