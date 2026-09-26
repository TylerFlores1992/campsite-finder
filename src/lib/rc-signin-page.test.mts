/**
 * A sign-in CAPTCHA in the evening pages the owner (src/lib/rc-signin-page.ts). Pinned:
 * which sign-ins page, which hours text, and that the text is one link-free GSM-7 segment —
 * a camphawk.app link is refused by `sendSms`, and two segments is the shape that was
 * Undelivered/30007 on 2026-08-05.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captchaPagePlan, captchaSmsBody, PAGING_LABELS } from './rc-signin-page';

test('only a CAPTCHA pages', () => {
  for (const outcome of ['password-form', 'cookie-answered', 'failed', 'failed-after-password', undefined]) {
    assert.equal(captchaPagePlan({ outcome, label: 'rehearsal' }, 20).page, false, String(outcome));
  }
  assert.equal(captchaPagePlan(null, 20).page, false);
});

test('rehearsal, on-demand and evening page; auto-login and warmup belong to the voice alarm', () => {
  for (const label of ['rehearsal', 'on-demand', 'evening']) {
    const p = captchaPagePlan({ outcome: 'captcha', label }, 20);
    assert.equal(p.page, true, label);
    assert.equal(p.sms, true, label);
    assert.equal(p.email, true, label);
  }
  for (const label of ['auto-login', 'warmup', 'test-login', 'unknown']) {
    assert.equal(captchaPagePlan({ outcome: 'captcha', label }, 20).page, false, label);
  }
  assert.deepEqual([...PAGING_LABELS].sort(), ['evening', 'on-demand', 'rehearsal']);
});

test('a text only between 07:00 and 21:59 Pacific; email at any hour', () => {
  const d = { outcome: 'captcha', label: 'on-demand' };
  assert.equal(captchaPagePlan(d, 6).sms, false);
  assert.equal(captchaPagePlan(d, 7).sms, true);
  assert.equal(captchaPagePlan(d, 21).sms, true);
  assert.equal(captchaPagePlan(d, 22).sms, false);
  assert.equal(captchaPagePlan(d, 3).sms, false);
  assert.equal(captchaPagePlan(d, 3).email, true);
  assert.equal(captchaPagePlan(d, 3).page, true);
});

test('the text is one ASCII segment with no link', () => {
  for (const label of ['rehearsal', 'on-demand', 'evening']) {
    const b = captchaSmsBody(label);
    assert.ok(b.length <= 160, `${label}: ${b.length} chars`);
    assert.match(b, /^[\x20-\x7E]+$/, 'ASCII only — an em dash tips it into UCS-2');
    assert.doesNotMatch(b, /camphawk\.app|https?:/i);
    assert.match(b, /CAPTCHA/);
  }
});

test('the route pages from the rc-signin event branch, after the write, inside `after`', () => {
  const route = readFileSync(new URL('../app/api/auto-cart/rc-holds/route.ts', import.meta.url), 'utf8');
  const write = route.indexOf('await recordBotEvent(body.event');
  const page = route.indexOf('schedulePageForSigninEvent(body.event);');
  const ret = route.indexOf("state: 'event-recorded'");
  assert.ok(write > 0, 'recordBotEvent call not found');
  assert.ok(page > write && page < ret, 'scheduled after the event is stored, before the branch returns');
  // And the helper really defers to `after` and only for rc-signin.
  const fn = route.slice(route.indexOf('function schedulePageForSigninEvent('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(event\.kind !== 'rc-signin'\) return;/);
  assert.match(body, /after\(\(\) => pageOwnerForSigninCaptcha\(detail\)/);
});
