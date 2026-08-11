/**
 * A data-modifying statement must go through `mutate`, never `query`.
 *
 * ── THE BUG (2026-08-11) ───────────────────────────────────────────────────────────────
 * `query()` routes to the `exec_select` RPC and `mutate()` to `exec_dml`. `exec_select`
 * cannot run an UPDATE, so `claimBotCommands` — written with `query` — threw on every
 * single call. Its `.catch(() => [])` turned that into an empty list, which is EXACTLY what
 * the feed returns when nobody has asked a question.
 *
 * So the mini-PC diagnostics channel never worked, and could not have. Two commands sat at
 * "queued, nothing has picked it up" for two minutes while the box was blamed; the box was
 * never sent anything. `claimBotUpdate` had the same defect, which would have made the
 * update grant permanently unwinnable, and `requestBotCommand`'s INSERT would have 500'd
 * the admin panel's "Ask" button.
 *
 * ── WHY A TEST AND NOT CARE ────────────────────────────────────────────────────────────
 * Nothing about the call site looks wrong. `query` and `mutate` take the same arguments,
 * return the same shape, and differ only in an RPC name three files away — and TypeScript
 * cannot tell them apart, because the difference is in the SQL string. It is invisible by
 * reading either file alone, which is the definition of something a test has to hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Every `query(...)`/`queryOne(...)` call whose SQL begins with a data-modifying verb.
 *
 * Anchored on the first word of the template literal, and it skips comments and whitespace
 * between the paren and the backtick — `claimBotCommands` had a nine-line comment there,
 * and a naive pattern matched the other two offenders while sailing past the one that was
 * actually breaking in production.
 */
function offenders(src: string): string[] {
  const found: string[] = [];
  const re = /\bquery(?:One)?\s*(?:<[\s\S]*?>)?\s*\(\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*`\s*(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/^(INSERT|UPDATE|DELETE|MERGE)$/i.test(m[1])) {
      found.push(src.slice(0, m.index).split('\n').length + ': ' + m[1].toUpperCase());
    }
  }
  return found;
}

test('no data-modifying SQL is routed through query()', () => {
  const bad: string[] = [];
  for (const f of [...walk('src/lib'), ...walk('src/app')]) {
    for (const hit of offenders(readFileSync(f, 'utf8'))) bad.push(`${f}:${hit}`);
  }
  assert.deepEqual(bad, [], `these must use mutate(), not query():\n  ${bad.join('\n  ')}`);
});

test('the detector actually catches the three real cases', () => {
  // A test that cannot fail is not a test. These are the exact shapes that shipped broken,
  // including the one with a comment block between the paren and the backtick.
  assert.deepEqual(offenders('const r = await query<{ id: number }>(`UPDATE t SET a = 1 RETURNING id`, [])'),
    ['1: UPDATE']);
  assert.deepEqual(offenders('const [row] = await query<{ id: number }>(`INSERT INTO t (a) VALUES ($1) RETURNING id`)'),
    ['1: INSERT']);
  assert.deepEqual(
    offenders('return await query<{ id: number }>(\n  // a comment\n  // another\n  `UPDATE t SET b = 2 RETURNING id`)'),
    ['1: UPDATE'],
  );
  // And does not fire on the ordinary case, or on the word appearing in a WHERE clause.
  assert.deepEqual(offenders("await query<T>(`SELECT id FROM t WHERE note = 'UPDATE'`)"), []);
  assert.deepEqual(offenders('await mutate<T>(`UPDATE t SET a = 1 RETURNING id`)'), []);
});

test('query and mutate really do route to different RPCs', () => {
  // The premise of the whole file. If these ever converge, the rule above stops mattering —
  // and a rule nobody needs is worse than none, because it still costs a reader time.
  const client = readFileSync('src/lib/db/client.ts', 'utf8');
  const q = client.match(/export async function query<[\s\S]*?\n}/)?.[0] ?? '';
  const m = client.match(/export async function mutate<[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(q, /rpc\('exec_select'/, 'query must use exec_select');
  assert.match(m, /rpc\('exec_dml'/, 'mutate must use exec_dml');
});

test('a claim that could not be attempted is not reported as a lost race', () => {
  // The catch is what made this invisible: an exception and an empty result are genuinely
  // different facts — "we could not ask" versus "somebody else won" — and collapsing them is
  // the same mistake as `status = 'sent'` meaning only that Twilio returned 2xx.
  for (const [file, fn] of [
    ['src/lib/bot-commands.ts', 'claimBotCommands'],
    ['src/lib/bot-update.ts', 'claimBotUpdate'],
  ] as const) {
    const src = readFileSync(file, 'utf8');
    const whole = src.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.ok(whole, `could not find ${fn}`);
    // COMMENTS STRIPPED, because the comment explaining this bug quotes the very pattern it
    // forbids — `.catch(() => [])` — and an absence assertion that matches its own rationale
    // fails on a correct file. Fifth time in this codebase; it is always worth the helper.
    const body = whole.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/\.catch\(\(\)\s*=>\s*(\[\]|false)\)/.test(body),
      `${fn} must not swallow its failure silently`);
    assert.match(body, /console\.error/, `${fn} must say when it could not run`);
  }
});
