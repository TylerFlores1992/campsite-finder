/**
 * A CAPTCHA IN THE EVENING PAGES THE OWNER — pure decision and wording, no I/O.
 *
 * The nightly rehearsal meeting a CAPTCHA used to page NOBODY: it wrote `ok = false` to the
 * rehearsal singleton and turned `autocart.rc_login` red on a dashboard nobody reads at 20:00,
 * and the first human signal was the T−25 voice call the next morning — a CAPTCHA to solve
 * over RustDesk with twenty-five minutes left. At 20:00 there are twelve hours; the whole value
 * of the rehearsal is that lead time, and without a page it was spent unread.
 *
 * WHICH SIGN-INS PAGE: the nightly `rehearsal`, an `on-demand` rehearsal and the flag-gated
 * `evening` sign-in. NOT `auto-login` / `warmup`: those run near a release and the existing
 * session alarm (the T−25 voice call) already owns that window — a text there would be a
 * second, weaker voice on the same incident. The voice call is unchanged and stays the last
 * resort.
 *
 * WHEN: 07:00-21:59 Pacific sends a text. Outside that it is email only — an on-demand
 * rehearsal can run at any hour, and a text at 03:00 is not how to deliver "solve this when you
 * can". The rehearsal itself refuses within six hours of a release, so a quiet-hours CAPTCHA
 * never has a cart behind it that the voice call would not also cover.
 */

export const PAGING_LABELS = ['rehearsal', 'on-demand', 'evening'] as const;
export const SMS_FROM_HOUR = 7;
export const SMS_UNTIL_HOUR = 22; // exclusive

export interface SigninPagePlan {
  page: boolean;
  sms: boolean;
  email: boolean;
  why: string;
}

/** `detail` is an `rc-signin` event's detail object; `pacificHour` is 0-23. */
export function captchaPagePlan(detail: unknown, pacificHour: number): SigninPagePlan {
  const d = (detail && typeof detail === 'object' ? detail : {}) as { outcome?: unknown; label?: unknown };
  if (d.outcome !== 'captcha') return { page: false, sms: false, email: false, why: 'not a CAPTCHA' };
  if (!(PAGING_LABELS as readonly unknown[]).includes(d.label)) {
    return { page: false, sms: false, email: false, why: `a ${String(d.label)} CAPTCHA is the voice alarm's` };
  }
  const daytime = pacificHour >= SMS_FROM_HOUR && pacificHour < SMS_UNTIL_HOUR;
  return {
    page: true,
    sms: daytime,
    email: true,
    why: daytime ? 'CAPTCHA at a sane hour — text and email' : 'CAPTCHA in quiet hours — email only',
  };
}

/**
 * One GSM-7 segment, no link (a camphawk.app link is refused by `sendSms` and carriers filter
 * it), ASCII only. The remedy is the manual sign-in because the rehearsal has already DROPPED
 * the token on its way through — there is no live session left for `rc-login.bat` to destroy.
 */
export function captchaSmsBody(label: string): string {
  const which = label === 'evening' ? 'evening sign-in' : label === 'on-demand' ? 'test sign-in' : 'nightly sign-in test';
  return `CampHawk: RC ${which} hit a CAPTCHA. Solve it on the mini-PC over RustDesk now: run rc-login.bat and sign in.`;
}
