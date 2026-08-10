/**
 * A submit button that disables itself cannot submit a native form.
 *
 * THE BUG THIS EXISTS FOR (2026-08-09). `HoldConfirm`'s "Yes — hold it for me" button had
 * `disabled={busy}` with `onClick={() => setBusy(true)}`, on a `<form method="POST">` with
 * no `onSubmit` handler — so the browser's own submission was the only thing that could
 * send it. React flushes state from a discrete click synchronously, so the re-render
 * disabled the button BEFORE the default action ran, and a disabled submit button cancels
 * the submission. The spinner span forever and nothing was ever sent.
 *
 * It went unnoticed because everything downstream was healthy: the endpoint answered 400
 * and 303 in half a second from curl, the route was public, the token was valid. Nothing
 * was broken except that the request was never made — which is indistinguishable, from
 * the user's side, from a server that never answers.
 *
 * It sat on the single action the whole 8am auto-cart flow depends on: without it a hold
 * never reaches `requested`, and `dueHolds` only ever returns `requested`.
 *
 * The four other forms in the app are safe for a reason worth knowing: they all use
 * `onSubmit` with `preventDefault` and fetch, so no native submission has to survive the
 * re-render. Only a NATIVE-submitting form is vulnerable, which is what this checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

test('a natively-submitting form never disables its own submit button', () => {
  const offenders: string[] = [];

  for (const file of tsxFiles('src')) {
    const src = readFileSync(file, 'utf8');
    // Each <form …> and the markup up to its close. A form that handles its own submit in
    // JS (onSubmit + preventDefault) does not depend on the browser's default action and
    // is not at risk.
    for (const m of src.matchAll(/<form\b([\s\S]*?)<\/form>/g)) {
      const block = m[0];
      const isNative = /method=["']POST["']/i.test(block) && !/preventDefault\(\)/.test(block);
      if (!isNative) continue;
      // `disabled` bound to anything other than a literal false is the hazard — the value
      // is state, and state set by this button's own click is what breaks it.
      if (/type=["']submit["'][\s\S]{0,300}?disabled=\{(?!false\})/.test(block)) {
        offenders.push(file);
      }
    }
  }

  assert.deepEqual(
    offenders, [],
    'a native <form method="POST"> must not disable its submit button — the disable wins ' +
    'the race against the browser\'s default action and the form never submits. Set the ' +
    'busy flag in the form\'s onSubmit and guard double-submits with a ref.',
  );
});

test('the hold confirm sets busy on submit, not on click', () => {
  // The specific regression, named. Generic rules drift; this one is the action the 8am
  // flow cannot proceed without, so it gets its own assertion.
  const src = readFileSync('src/components/v2/HoldConfirm.tsx', 'utf8');
  assert.ok(!/onClick=\{\(\) => setBusy\(true\)\}/.test(src), 'busy must not be set from onClick');
  assert.match(src, /onSubmit=\{/, 'busy is set in onSubmit, once submission is already in flight');
  assert.match(src, /submitted\.current/, 'double-submits are stopped by a ref, not by disabling');
});

test('the hold confirm has a way out', () => {
  // Reached from an email or a push notification, so it is often the only CampHawk page
  // open — and it lives outside the (app) route group, so it gets no nav bar. Without a
  // link home the user is stranded on a decision screen.
  const src = readFileSync('src/components/v2/HoldConfirm.tsx', 'utf8');
  assert.match(src, /href="\/"/, 'the brand mark links home');
  assert.match(src, /Logo/, 'and it is the CampHawk mark, as everywhere else in the app');
});
