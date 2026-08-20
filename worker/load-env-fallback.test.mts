// A MISSING .env MUST NOT LOOK LIKE A REJECTED TOKEN.
//
// `load-env.mjs`'s own header records the failure it exists to prevent: `rc-hold-runner.mjs`
// shipped without it and answered `feed 401`, "which reads exactly like a wrong token".
//
// It reappeared one directory deeper, inside the fix. `mini-pc/report-applied.mjs` called
// `loadEnv(import.meta.url)`, which resolved `mini-pc/.env` — a file that does not exist,
// because the `.env` is one level up in `scripts/auto-cart-bot/`. `loadEnv` returned
// SILENTLY, so `AUTOCART_TOKEN` was absent, the POST was answered 401, and the script printed
//
//     [report-applied] server said 401 - the admin page will still show the OLD commit
//
// which reads as a wrong token. `bot_update_requests.applied_sha` therefore stopped moving on
// 2026-08-19 and still read `746cd5a` after two successful manual updates on 08-20 — a stale
// field that a reader then reasons from. It misled this session for most of a day.
//
// Two properties are pinned: the canonical fallback, and that a 401 says WHICH of the two
// faults it was.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../scripts/auto-cart-bot/load-env.mjs';

const CANONICAL = path.resolve('scripts/auto-cart-bot/.env');

test('a .env beside the caller still wins', () => {
  // The original behaviour, and the reason the parameter exists: a directory that puts its
  // own `.env` there deliberately must keep overriding. The fallback is additive.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-env-'));
  try {
    const own = path.join(dir, '.env');
    fs.writeFileSync(own, 'CH_TEST_OWN_DIR=yes\n');
    const read = loadEnv(pathToFileURL(path.join(dir, 'caller.mjs')).href);
    assert.equal(read, own, 'the caller directory is searched first');
    assert.equal(process.env.CH_TEST_OWN_DIR, 'yes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CH_TEST_OWN_DIR;
  }
});

test('a caller with no .env beside it falls back to scripts/auto-cart-bot/.env', () => {
  /**
   * The actual fix. `mini-pc/report-applied.mjs` is the caller that made this necessary.
   *
   * IT WRITES THE CANONICAL FILE ONLY IF THERE ISN'T ONE, AND RESTORES EXACTLY. On a
   * developer's box that file holds the live AUTOCART_TOKEN and the RC credentials' sibling
   * config; a test that overwrote it would be a far worse bug than the one being fixed. If
   * one exists we assert the weaker property instead and SAY SO, rather than quietly
   * skipping — a test that silently proves nothing is the shape this repo keeps paying for.
   */
  const existed = fs.existsSync(CANONICAL);
  if (existed) {
    // Weaker, but real: whatever that file is, a caller from mini-pc/ must reach it.
    const read = loadEnv(pathToFileURL(path.resolve('scripts/auto-cart-bot/mini-pc/x.mjs')).href);
    assert.equal(read, CANONICAL,
      'a real .env is present, so this asserts reachability only — the write half is untested here');
    return;
  }
  try {
    fs.writeFileSync(CANONICAL, 'CH_TEST_FALLBACK=reached\n');
    const read = loadEnv(pathToFileURL(path.resolve('scripts/auto-cart-bot/mini-pc/x.mjs')).href);
    assert.equal(read, CANONICAL, 'a caller in mini-pc/ must reach the canonical .env');
    assert.equal(process.env.CH_TEST_FALLBACK, 'reached', 'and actually load it');
  } finally {
    fs.rmSync(CANONICAL, { force: true });
    delete process.env.CH_TEST_FALLBACK;
  }
});

test('the search is BOUNDED — it must not wander up to the repo root', () => {
  // Walking up arbitrarily would eventually find an unrelated `.env` and load it without
  // saying so, which is a worse failure than the silent miss being fixed: wrong values are
  // harder to spot than absent ones. Two candidates, both named.
  const src = fs.readFileSync('scripts/auto-cart-bot/load-env.mjs', 'utf8');
  const fn = src.slice(src.indexOf('export function loadEnv'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /path\.join\(dir, '\.env'\), path\.join\(here, '\.env'\)/,
    'exactly two candidates: the caller directory, then this module directory');
  assert.ok(!/\.\.\/|while \(|for \(.*parent/.test(body),
    'no walking up — a loop here reaches the repo root eventually');
});

test('loadEnv RETURNS what it read, so a caller can say it found nothing', () => {
  // The silent `return` is the half that made this expensive. A miss is now expressible.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-env-'));
  try {
    const read = loadEnv(pathToFileURL(path.join(dir, 'caller.mjs')).href);
    // Null only when the canonical file is absent too — which is the case in CI and in a
    // web session, and is asserted conditionally so this cannot fail on a dev box.
    if (!fs.existsSync(CANONICAL)) {
      assert.equal(read, null, 'no file anywhere must be a NULL, not a silent undefined');
    } else {
      assert.equal(read, CANONICAL);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a 401 says whether the token was MISSING or REJECTED', () => {
  // Those need completely different fixes and printed the identical line for over a day.
  // `envSource` was written for exactly this on 2026-08-07 and nothing here was calling it.
  const src = fs.readFileSync('scripts/auto-cart-bot/mini-pc/report-applied.mjs', 'utf8');
  assert.match(src, /import \{ loadEnv, envSource \}/, 'envSource must be imported');
  assert.match(src, /const envFile = loadEnv\(import\.meta\.url\)/,
    'the resolved path is kept, or the message cannot name the file it read');
  const at = src.indexOf('r.status === 401');
  assert.ok(at > -1, 'the 401 must be handled specifically');
  const arm = src.slice(at, at + 700);
  assert.match(arm, /envSource\('AUTOCART_TOKEN'\)/, 'and the source reported');
  assert.match(arm, /NOT SET/, 'the missing case must say so in words');
  assert.match(arm, /envFile/, 'and name the .env it actually read, or NONE FOUND');
});
