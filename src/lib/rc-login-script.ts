/**
 * Signing the USER in to ReserveCalifornia, inside the app's own webview.
 *
 * ## Why here and not on the mini-PC
 *
 * The cart is bound to the SESSION that made it, not to the account — measured 2026-08-06:
 * a second session on the SAME account, freshly logged in with a different token, reads that
 * cart as **0 entries**. So for the site to be in the user's cart at checkout, the session
 * that mints the cart has to be theirs. Logging in for them on our box would produce a cart
 * living in OUR Chromium that their phone could never see.
 *
 * That single fact is what makes this an in-webview flow rather than a server one, and it is
 * also what keeps it defensible: **the password never reaches CampHawk's servers or
 * database.** It is typed on the device, handed to this script through the same
 * `executeScript` channel that already carries the precart, and used against RC's own form.
 *
 * ## The CAPTCHA stops being fatal here
 *
 * `rc-autologin.mjs` treats a challenge as a full stop, correctly: it runs unattended at
 * 07:30 with nobody to solve one, and clicking behind a challenge overlay can never work.
 * **This path has a human holding the phone**, having just tapped "complete the hand-off" —
 * so a challenge is a pause, not a failure. We report it and let them clear it. Do not carry
 * the bot's rule onto this path; it is a different threat model, the same way the 2026-08-09
 * mobile sign-in tests concluded.
 *
 * ## The credentials are NEVER in this served bundle
 *
 * `/api/rc-precart` serves the same bytes to everyone, so this defines a function and takes
 * the credentials as ARGUMENTS. The caller performs a second, one-off `executeScript` with
 * them JSON-encoded — `JSON.stringify` because a password containing a quote or a backslash
 * would otherwise break the script or, worse, change what it does.
 *
 * They are also never reported. `RcReport` stages carry names and outcomes only. The rule is
 * the one the first mobile report broke by sending `location.href` and leaking an OAuth
 * authorization code: **do not collect a field you then have to filter.**
 *
 * ## The selectors are PORTED, not invented
 *
 * Every list below is `rc-autologin.mjs`'s, which is itself ported from `rc-probe.mjs` —
 * the version that actually signed in. Writing a fresh one cost two failed runs in August
 * against walls the probe had already documented. The traps that matter:
 *
 *  - **RC's control says "Log in / Sign up", not "Sign In".** `:has-text()` is a substring
 *    match, so a `Sign In` selector does not match it — that is why the first real
 *    `--test-login` failed while still sitting on the home page.
 *  - **Enter, not the button.** Okta disables Next mid-transaction, so a click reports
 *    success and does nothing.
 *  - **Tick "Keep me signed in".** It is what produces the `idx` cookie, and the reason an
 *    Okta session exists at all.
 *  - **Read Okta's error banner.** It carries the real reason in a sentence; anything else
 *    is a guess derived from which timeout expired.
 */

/** RC's home-page control that leads to the Okta form. Order matters — see the header. */
export const SIGNIN_LINK_SELECTORS = [
  'a:has-text("Log in")',
  'button:has-text("Log in")',
  'a:has-text("Login")',
  'button:has-text("Login")',
  'a:has-text("Sign In")',
  'button:has-text("Sign In")',
  '[href*="signin" i]',
  '[href*="sign-in" i]',
] as const;

/**
 * The same controls as CSS only.
 *
 * `:has-text()` is PLAYWRIGHT'S, not CSS — `querySelector` throws on it. The bot can use the
 * list above because Playwright resolves it; an injected script cannot, and a selector that
 * throws inside a `try` is a selector that silently matches nothing. So the text matching is
 * done in JS against the accessible name, over anchors and buttons only: an injected script
 * that clicks any element whose text says "sign in" is how it starts pressing things nobody
 * meant. Same rule `content-rc.js` already follows for its own Log in button.
 */
export const SIGNIN_TEXTS = ['log in', 'login', 'sign in'] as const;

export const EMAIL_SELECTORS = [
  'input[name="identifier"]',            // Okta Identity Engine
  'input[name="username"]',              // Okta Classic
  '#okta-signin-username',
  'input[autocomplete="username"]',
  'input[type="email"]',
] as const;

export const PASSWORD_SELECTORS = [
  'input[name="credentials.passcode"]',  // Okta Identity Engine
  'input[name="password"]',              // Okta Classic
  '#okta-signin-password',
  'input[type="password"]',
] as const;

/** Okta's own words for what went wrong. Read, never guessed at. */
export const ERROR_SELECTORS = [
  '[role="alert"]',
  '.okta-form-infobox-error',
  '.infobox-error',
] as const;

/**
 * Is a reCAPTCHA CHALLENGE on screen — not merely the passive badge?
 *
 * PORTED VERBATIM IN SUBSTANCE from `rc-autologin.mjs`, including the correction that cost a
 * five-minute wait for a human who had nothing to solve: presence is not a challenge.
 * reCAPTCHA injects a `bframe` on every page that loads the widget, sized 0x0 and hidden, and
 * RC loads it on sign-in pages that automate perfectly well. A real challenge is VISIBLE and
 * has real size **including its ancestors** — the wrapper is toggled hidden between uses, so
 * a bframe can be big and still not be asking anything.
 */
function captchaProbeSource(): string {
  return `
  function chCaptchaVisible() {
    try {
      var fr = Array.prototype.slice.call(document.querySelectorAll(
        'iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"][src*="challenge"]'));
      for (var i = 0; i < fr.length; i++) {
        var f = fr[i], r = f.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) continue;
        var st = getComputedStyle(f);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
        var ok = true;
        for (var el = f.parentElement; el; el = el.parentElement) {
          var s = getComputedStyle(el);
          if (s.visibility === 'hidden' || s.display === 'none') { ok = false; break; }
        }
        if (ok) return true;
      }
    } catch (e) {}
    return false;
  }`;
}

/**
 * The injected sign-in, as source to hand to `executeScript`.
 *
 * Defines `window.__chRcLogin(email, password)` → Promise<{ok, stage, reason}>. It does NOT
 * run on load: the caller invokes it once, with the credentials, in a separate one-off
 * injection. That separation is the whole reason the served bundle can be identical for
 * every user.
 *
 * Stages reported (names only, never values): `signin-open`, `captcha`, `email`, `password`,
 * `submitted`, `signed-in`, `failed`.
 */
export function loginScript(): string {
  return `
${captchaProbeSource()}

  /*
     THE REPORTER'S CHANNEL, AS IT ACTUALLY EXISTS.

     The first version called a function named ch_report, which is not a thing. reporter()
     exposes window.__camphawkRc.send(stage, detail) and nothing else, so every report in
     here would have thrown on its first call - inside a try, so silently. Written from
     memory instead of read, which is the mistake this repo has a rule about.

     NO BACKTICKS IN THIS COMMENT. It lives inside a template literal, so one would terminate
     the string and the parse error surfaces somewhere unrelated - the same trap CLAUDE.md
     records for SQL comments in the poller, which has now cost a build twice.

     Guarded rather than assumed: if the reporter failed to install, the sign-in must still
     work. Losing the diagnostics is survivable; losing the login is not.
  */
  function chSay(stage, detail) {
    try { if (window.__camphawkRc) window.__camphawkRc.send(stage, detail || {}); } catch (e) {}
  }

  var CH_SIGNIN_TEXTS = ${JSON.stringify(SIGNIN_TEXTS)};
  var CH_EMAIL_SELS = ${JSON.stringify(EMAIL_SELECTORS)};
  var CH_PW_SELS = ${JSON.stringify(PASSWORD_SELECTORS)};
  var CH_ERR_SELS = ${JSON.stringify(ERROR_SELECTORS)};

  function chFind(sels) {
    for (var i = 0; i < sels.length; i++) {
      try {
        var el = document.querySelector(sels[i]);
        if (el && el.offsetParent !== null) return el;
      } catch (e) {}
    }
    return null;
  }

  function chWait(sels, ms) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + ms;
      (function tick() {
        var el = chFind(sels);
        if (el) return resolve(el);
        if (Date.now() >= deadline) return resolve(null);
        setTimeout(tick, 250);
      })();
    });
  }

  /** Anchors and buttons only, matched on the ACCESSIBLE NAME. See SIGNIN_TEXTS. */
  function chSignInControl() {
    var els = Array.prototype.slice.call(document.querySelectorAll('a, button'));
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].innerText || els[i].textContent || '').trim().toLowerCase();
      if (!t) continue;
      for (var j = 0; j < CH_SIGNIN_TEXTS.length; j++) {
        if (t.indexOf(CH_SIGNIN_TEXTS[j]) !== -1) return els[i];
      }
    }
    return null;
  }

  /** React tracks its own value; a bare .value assignment is not seen by the form. */
  function chSetValue(el, v) {
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** ENTER, NOT THE BUTTON — Okta disables Next mid-transaction. See the header. */
  function chSubmit(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    }));
    try { if (el.form && el.form.requestSubmit) el.form.requestSubmit(); } catch (e) {}
  }

  /** The idx cookie comes from this box. Without it there is no Okta session to renew. */
  function chKeepSignedIn() {
    try {
      var boxes = Array.prototype.slice.call(
        document.querySelectorAll('input[type="checkbox"]'));
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (b.offsetParent === null || b.checked) continue;
        var n = (b.name || '') + ' ' + (b.id || '');
        if (/remember|keep/i.test(n) || boxes.length === 1) { b.click(); return true; }
      }
    } catch (e) {}
    return false;
  }

  function chOktaError() {
    for (var i = 0; i < CH_ERR_SELS.length; i++) {
      try {
        var el = document.querySelector(CH_ERR_SELS[i]);
        var t = el && (el.innerText || el.textContent || '').trim();
        if (t) return t.slice(0, 160);
      } catch (e) {}
    }
    return null;
  }

  window.__chRcLogin = function (email, password) {
    var done = function (ok, stage, reason) {
      // THE CREDENTIALS LEAVE MEMORY HERE, and the result never carries them.
      email = null; password = null;
      // AND THE VERDICT IS ANNOUNCED, which it was not until 2026-08-16.
      //
      // Every terminal path returned this object and nothing else. executeScript discards
      // the return value, so "could not find RC's sign-in control", "the password field never
      // appeared", "Okta rejected the password" and "signed in" were the SAME SILENCE — the
      // exact family this whole report channel exists to end, reappearing inside the one
      // function it was built for. A real test run reported injected, session, idle and
      // stopped: the sign-in had run, failed, and said nothing, which is indistinguishable
      // from its never having been invoked.
      //
      // The progress stages (email, password, submitted) were reported all along, so the
      // omission was specifically the ANSWER.
      //
      // NO BACKTICKS ANYWHERE IN THIS FUNCTION'S COMMENTS. It lives inside a template
      // literal, so one ends the string and the parse error surfaces somewhere unrelated.
      chSay('login-result', { ok: !!ok, stage: stage, reason: reason ? String(reason).slice(0, 160) : null });
      return { ok: ok, stage: stage, reason: reason || null };
    };
    return (async function () {
      try {
        // ALREADY SIGNED IN is a success, and asking first is what stops us typing a
        // credential we did not need. The token capture is the authority; a form's absence
        // is not, because RC's SPA re-authenticates AFTER the page settles.
        if (window.__camphawkRcToken) return done(true, 'signed-in', 'already signed in');

        var pw = chFind(CH_PW_SELS);
        if (!pw) {
          var link = chSignInControl();
          if (link) { link.click(); chSay('signin-open', {}); }
          // NOT FINDING IT IS A FACT, AND IT WAS SILENT. On the park page RC renders its own
          // sign-in control in the header; if the match misses, everything downstream waits
          // 15s for a form that will never come and the user watches a calendar. Report the
          // MISS and how many candidates were on the page, so "RC reworded it" and "the page
          // had not rendered yet" can be told apart — 0 candidates means the DOM was empty.
          //
          // Never the candidates' text: RC's header carries the signed-in user's own name.
          else chSay('signin-missing', { candidates: document.querySelectorAll('a, button').length });
        }

        // A challenge can appear before the form. The human is here; let them clear it.
        if (chCaptchaVisible()) {
          chSay('captcha', { visible: true });
          var cleared = await chWait(CH_EMAIL_SELS.concat(CH_PW_SELS), 300000);
          if (!cleared) return done(false, 'captcha', 'the challenge was not cleared');
        }

        pw = chFind(CH_PW_SELS);
        var user = pw ? null : await chWait(CH_EMAIL_SELS, 15000);
        if (user) {
          chSetValue(user, email);
          // READ IT BACK. A field that silently holds something else is otherwise invisible,
          // and that is a documented rc-probe finding, not a hypothetical.
          if (user.value !== email) return done(false, 'email', 'the email field would not take the address');
          chKeepSignedIn();
          chSay('email', {});
          chSubmit(user);
          pw = await chWait(CH_PW_SELS, 20000);
        }
        if (!pw) {
          if (window.__camphawkRcToken) return done(true, 'signed-in', 'signed in without a password step');
          return done(false, 'password', chOktaError() || 'the password field never appeared');
        }

        chSetValue(pw, password);
        chKeepSignedIn();
        chSay('password', {});
        chSubmit(pw);
        chSay('submitted', {});

        // A challenge can also appear AFTER the password. Same rule: a human is here.
        for (var i = 0; i < 120; i++) {
          if (window.__camphawkRcToken) return done(true, 'signed-in', null);
          var err = chOktaError();
          if (err) return done(false, 'failed', err);
          if (chCaptchaVisible()) chSay('captcha', { visible: true, after: 'password' });
          await new Promise(function (r) { setTimeout(r, 1000); });
        }
        return done(false, 'failed', 'signed in but no session appeared');
      } catch (e) {
        return done(false, 'failed', String((e && e.message) || e).slice(0, 160));
      }
    })();
  };`;
}

/**
 * The one-off call, with the credentials JSON-encoded.
 *
 * `JSON.stringify` and not string concatenation: a password containing a quote or a
 * backslash would otherwise break the script, and a password containing `');` would change
 * what it does. This is the only place a credential appears in any source we generate, it is
 * generated per invocation, and it is never logged or persisted.
 *
 * ## THE CREDENTIALS ARE BOUND TO LOCALS BEFORE ANY CALL, AND THAT IS THE WHOLE POINT
 *
 * The first version was one line — `window.__chRcLogin("<email>", "<password>")` — and on
 * 2026-08-16 it wrote a real user's ReserveCalifornia password into the production database
 * in plaintext. Nothing mis-handled the secret; the ENGINE did. `__chRcLogin` was undefined
 * (the bundle that defines it was not being served yet), WebKit raised
 *
 *     TypeError: window.__chRcLogin is not a function.
 *     (In 'window.__chRcLogin("a@b.com", "hunter2")', 'window.__chRcLogin' is undefined)
 *
 * — a message that QUOTES THE SOURCE EXPRESSION — and the bundle's global `error` listener
 * dutifully reported it. `scrub()` knew JWT shapes and sailed straight past it, exactly as it
 * had sailed past an OAuth authorization code on 2026-08-09. Same lesson, second time:
 * **don't produce a value you then have to filter.**
 *
 * So the values never appear inside a call expression. An engine quoting the source can only
 * quote `window.__chRcLogin(e, p)` — identifiers, not secrets — whatever it decides to
 * include. That property does not depend on any denylist, on `scrub()`, or on which engine
 * is running, which is why it is the layer that matters. (`scrub()` also strips WebKit's
 * source quote now; that is the second layer, and it is the one that would have failed
 * silently if it were the only one.)
 *
 * ## It cannot throw at all
 *
 * The `typeof` guard turns the precise failure above into a NAMED report — `login-unavailable`,
 * meaning "the bundle that defines the sign-in was not served" — instead of a raw TypeError
 * that reaches the global handler. A stale cached bundle and a broken sign-in used to produce
 * the same evidence, and the first is a deploy that has not landed yet while the second is a
 * bug; a reader must be able to tell them apart at 08:00.
 */
export function loginInvocation(email: string, password: string): string {
  return `(function () {
  var e = ${JSON.stringify(email)}, p = ${JSON.stringify(password)};
  function say(stage, detail) {
    try { if (window.__camphawkRc) window.__camphawkRc.send(stage, detail || {}); } catch (x) {}
  }
  if (typeof window.__chRcLogin !== 'function') {
    // The served bundle did not define it. Almost always a cached copy from before the
    // deploy — say so, rather than letting a TypeError describe it.
    say('login-unavailable', { reason: 'the sign-in script was not in the bundle this webview loaded' });
    return;
  }
  try { window.__chRcLogin(e, p); }
  catch (x) { say('login-threw', {}); }
})();`;
}
