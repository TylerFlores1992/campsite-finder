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

/**
 * The longest accessible name still plausibly a sign-in CONTROL rather than a container.
 *
 * The match has to stay a SUBSTRING one — RC's control says "Log in / Sign up", so an
 * anchored `/^log ?in$/` finds nothing, which is the trap `SIGNIN_LINK_SELECTORS`' header
 * records. But a bare substring test over every anchor and button on the page will happily
 * match a wrapper whose text contains the whole header, and clicking that does nothing.
 *
 * 40 is generous next to the 16 characters RC actually uses, so a rewording survives, while
 * a nav region or a card never fits.
 */
export const SIGNIN_MAX_NAME_LEN = 40;

/**
 * How long to wait for RC to render its own header.
 *
 * **THE CONTROL IS NOT THERE WHEN WE ARE INJECTED.** We run at `loadstop`; RC's SPA boots
 * after that and paints its header on its own clock — the same fact `scrollToTop()` exists
 * for, which says in as many words that a single `scrollTo` at injection is "a race we lose
 * most of the time, and the failure is silent". `chSignInControl()` was called ONCE,
 * synchronously, so it lost the same race and the run went on to spend fifteen seconds
 * waiting for a credential form nothing had asked for.
 *
 * The owner watched exactly that on 2026-08-23: *"Takes me to RC. It scrolls to calendar.
 * Nothing happens. I hit login on that page and it then completed everything for me."*
 *
 * The bot has always polled — `clickSignInControl` passes a 10s `timeoutMs` into `findIn`,
 * which retries every 400ms. This is that, and 12s rather than 10s only because a webview on
 * a phone at 08:00 is the slowest place any of this runs. It costs NOTHING when the control
 * is already there: the poll tests before it waits.
 */
export const SIGNIN_WAIT_MS = 12_000;

/**
 * How long Okta gets to render the password step after the identifier is submitted.
 *
 * Unchanged at twenty seconds for the ORDINARY path — this is Okta rendering its own next
 * screen, and a longer default would just make a genuinely broken sign-in take longer to
 * report. What changed is that a challenge appearing inside this window now extends it
 * (`CHALLENGE_WAIT_MS`) instead of running the clock out.
 */
export const PASSWORD_WAIT_MS = 20_000;

/**
 * How long a HUMAN gets to solve a challenge before the run gives up.
 *
 * Five minutes, matching the arm that already guards the pre-email case — a person holding a
 * phone at 08:00 is exactly who this path can ask, which is the whole reason the in-app
 * sign-in survives where the bot's does not (the bot treats a CAPTCHA as a full stop because
 * nobody is there). Bounded rather than open-ended: an unsolved challenge must still end, or
 * the window never closes and the user is stranded — the 2026-08-12 bug by another door.
 */
export const CHALLENGE_WAIT_MS = 300_000;

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
 * Stages reported (names only, never values): `signin-open`, `signin-missing`, `captcha`,
 * `keep-signed-in`, `email`, `password`, `submitted`, `signed-in`, `failed`.
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
  var CH_SIGNIN_MAX_LEN = ${SIGNIN_MAX_NAME_LEN};
  var CH_SIGNIN_WAIT_MS = ${SIGNIN_WAIT_MS};
  var CH_PW_WAIT_MS = ${PASSWORD_WAIT_MS};
  var CH_CHALLENGE_WAIT_MS = ${CHALLENGE_WAIT_MS};
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

  /*
     ONE POLLING LOOP, TWO CALLERS. chWait is the selector-list form of it; the sign-in
     control needs the predicate form, because it is matched in JS rather than by a
     selector. A second hand-rolled loop is how the two would come to disagree about how
     long they wait.
  */
  function chWaitFor(get, ms) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + ms;
      (function tick() {
        var v = get();
        if (v) return resolve(v);
        if (Date.now() >= deadline) return resolve(null);
        setTimeout(tick, 250);
      })();
    });
  }

  function chWait(sels, ms) {
    return chWaitFor(function () { return chFind(sels); }, ms);
  }

  /*
     WAIT FOR THE PASSWORD FIELD, AND HAND CONTROL BACK AFTER A CHALLENGE (2026-09-02).

     Okta shows its challenge AFTER the identifier is submitted, which is a gap this script
     had no eyes in: chWait(CH_PW_SELS, 20000) was a flat twenty seconds with no challenge
     check, so a human solving a CAPTCHA ran the clock out and the run reported "the password
     field never appeared" -- a failure, over a sign-in that was proceeding normally. There
     are challenge arms either side of this (before the email, after the password) and none
     in the middle. Measured on hold 9bcad26a: email submitted, then that exact line.

     A CHALLENGE EXTENDS THE DEADLINE ONCE, TO A FIXED POINT. Refreshing it on every tick
     while the frame is visible is an unbounded wait wearing a timeout's clothes -- the
     window would never close if the challenge were never solved. Stamped from when the
     challenge was FIRST seen, so solving it leaves the full allowance for Okta to render the
     next step.

     AND IT IS ANNOUNCED, BOTH WAYS. captcha is the one stage the claim screen renders a
     message for, so the user is told what to do; captcha-cleared is what says the script
     took over again, which is the fact that was missing when this failed -- "it resumed" and
     "the user finished it by hand" were the same silence.
  */
  async function chWaitPassword() {
    var deadline = Date.now() + CH_PW_WAIT_MS;
    var seenAt = null;
    for (;;) {
      var el = chFind(CH_PW_SELS);
      if (el) {
        if (seenAt !== null) chSay('captcha-cleared', { after: 'email', waitedMs: Date.now() - seenAt });
        return el;
      }
      // Okta can skip the password step entirely for a remembered device. The caller's own
      // signed-in check handles it; returning here stops us waiting out a challenge deadline
      // for a field that is never coming because the sign-in is already done.
      if (chSignedIn()) return null;
      if (chCaptchaVisible() && seenAt === null) {
        seenAt = Date.now();
        deadline = seenAt + CH_CHALLENGE_WAIT_MS;
        chSay('captcha', { visible: true, after: 'email' });
      }
      if (Date.now() >= deadline) return null;
      await new Promise(function (r) { setTimeout(r, 250); });
    }
  }

  /*
     IS THIS CONTROL ON THE PAGE, OR MERELY IN THE DOM?

     RC ships a responsive header, so the same words exist more than once: one copy for a
     wide viewport and one inside a menu, and whichever is wrong for this screen is
     display:none. The old matcher checked neither, took the first in DOCUMENT ORDER, and
     clicked it -- and clicking a hidden element does nothing at all while reporting
     signin-open, so the run announced that it had opened the sign-in and then waited
     fifteen seconds for a form nobody had asked for. Reproduced against the served bundle
     before this was written, not reasoned about.

     A RECT, NOT offsetParent. chFind uses offsetParent because that is enough for a form
     field, but offsetParent is null for a position:fixed element too -- and a sticky or
     fixed header is exactly where a sign-in control lives, so that test would have thrown
     away the very element we are looking for. A box with real width and height is the
     honest question. An element scrolled off the top still has one, which matters: the
     owner's report is precisely that the control is rendered and off screen.
  */
  function chVisible(el) {
    try {
      if (typeof el.getBoundingClientRect === 'function') {
        var r = el.getBoundingClientRect();
        return !!(r && r.width > 0 && r.height > 0);
      }
    } catch (e) {}
    return el.offsetParent !== null;
  }

  /**
   * Anchors and buttons only, matched on the ACCESSIBLE NAME. See SIGNIN_TEXTS.
   *
   * THE SHORTEST VISIBLE MATCH WINS, which is what makes a substring test safe. The test has
   * to stay a substring one -- RC says "Log in / Sign up" -- and over a whole page that also
   * matches any ancestor carrying those words. Ranking by name length picks the control
   * rather than the region that contains it, and CH_SIGNIN_MAX_LEN throws out anything too
   * long to be a control at all.
   */
  function chSignInControl() {
    var els = Array.prototype.slice.call(document.querySelectorAll('a, button'));
    var best = null, bestLen = Infinity;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!chVisible(el)) continue;
      var t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      if (!t || t.length > CH_SIGNIN_MAX_LEN || t.length >= bestLen) continue;
      for (var j = 0; j < CH_SIGNIN_TEXTS.length; j++) {
        if (t.indexOf(CH_SIGNIN_TEXTS[j]) !== -1) { best = el; bestLen = t.length; break; }
      }
    }
    return best;
  }

  /*
     DO WE ALREADY HAVE A SESSION?

     Read from the reporter, which is the only thing in this bundle that watches the token
     broadcast. This used to read window.__camphawkRcToken -- a global belonging to the
     BOT's Playwright capture that nothing in a webview has ever set, so every one of these
     checks was permanently false. See the reporter for what that cost.
  */
  function chSignedIn() {
    try {
      var R = window.__camphawkRc;
      return !!(R && typeof R.signedIn === 'function' && R.signedIn());
    } catch (e) { return false; }
  }

  /**
   * React tracks its own value; a bare .value assignment is not seen by the form.
   *
   * THE TRACKER RESET IS THE HALF THAT WAS MISSING, and it cost a real claim on
   * 2026-08-20. React keeps a _valueTracker per input and SUPPRESSES the change event
   * when the value it is handed equals the one it already tracks. iOS keychain autofill
   * populates Okta's email field before we run, so the tracker already held the address;
   * we then wrote the identical string, React saw no change, its state stayed empty, and
   * the widget rejected the form as blank. The DOM read-back passed the whole time, which
   * is why this was invisible from our side: user.value was exactly right.
   *
   * The user saw it from the other end, and their description is the diagnosis --
   * "it said can't leave blank even though it was filled in already as if we entered it".
   * Filled in the DOM, empty in the model.
   *
   * Setting the tracker to a value that cannot be the real one forces the comparison to
   * fail, so the change event fires whatever autofill did first.
   *
   * FOCUS AND BLUR ARE NOT DECORATION. Okta validates required fields on blur; a value
   * that arrives without one is never checked, so the first thing that reads the model is
   * the submit, and by then the failure is a form-level error with no field attached.
   *
   * NO BACKTICKS ANYWHERE IN THIS FUNCTION'S COMMENTS -- see chRcLogin's done() for why.
   */
  function chSetValue(el, v) {
    try { el.focus(); } catch (e) {}
    // Reset React's tracked value FIRST. Guarded because it is an internal: if a future
    // React drops it, the native-setter path below still works exactly as it did before.
    try {
      if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
        el._valueTracker.setValue('__ch_never_a_real_value__');
      }
    } catch (e) {}
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    try { el.dispatchEvent(new FocusEvent('blur', { bubbles: false })); } catch (e) {}
  }

  /**
   * Let the framework flush before the value is read by anything.
   *
   * React batches state updates out of an event handler, so a submit fired in the SAME
   * synchronous block can be handled while the model still holds the old value. That
   * produces the identical symptom as the tracker bug -- a correct DOM and a form-level
   * "we found some errors" -- and the 08-20 trace cannot tell the two apart, so both are
   * fixed. One frame is not enough on a busy webview; 50ms is imperceptible next to the
   * 15-20s waits either side of it.
   */
  function chSettle() {
    return new Promise(function (r) { setTimeout(r, 50); });
  }

  /** ENTER, NOT THE BUTTON — Okta disables Next mid-transaction. See the header. */
  function chSubmit(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    }));
    try { if (el.form && el.form.requestSubmit) el.form.requestSubmit(); } catch (e) {}
  }

  /**
   * The idx cookie comes from this box. Without it there is no Okta session to renew.
   *
   * IT REPORTS NOW, AND THAT IS THE POINT (2026-09-01). It used to return a boolean nobody
   * read, so "we ticked it" and "there was no box on this page to tick" were the same
   * silence — the shape this file keeps paying for. Two hand-offs minutes apart, one that
   * worked and one that did not, produced byte-identical traces because the one field that
   * differed was never reported.
   *
   * WHY IT CAN LEGITIMATELY FIND NOTHING: Okta renders "Keep me signed in" on the
   * IDENTIFIER step, and the caller skips that step entirely whenever a password field is
   * already on the page (the pw = chFind(CH_PW_SELS) line above). So a run where Okta remembers
   * the account goes straight to the password and there is no box in the DOM at all. That
   * is not a failure of this function and must not read as one — hence the boxes count, so a miss
   * over zero candidates and a miss over five are different findings.
   *
   * COUNTS AND A BOOLEAN, NEVER LABEL TEXT. Okta's checkbox labels are safe today, but the
   * standing rule here is not to collect a field you would then have to filter, and the
   * sibling signin-missing already refuses to report candidate text because RC's header
   * carries the signed-in user's own name.
   */
  function chKeepSignedIn(where) {
    var boxes = [];
    var ticked = false;
    var matched = false;
    try {
      boxes = Array.prototype.slice.call(
        document.querySelectorAll('input[type="checkbox"]'));
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (b.offsetParent === null || b.checked) continue;
        var n = (b.name || '') + ' ' + (b.id || '');
        if (/remember|keep/i.test(n) || boxes.length === 1) {
          matched = true;
          b.click();
          ticked = true;
          break;
        }
      }
    } catch (e) {}
    chSay('keep-signed-in', { at: where, ticked: ticked, boxes: boxes.length, matched: matched });
    return ticked;
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
        // NEVER TOUCH THE CALLBACK PAGE (2026-09-01, #250). On /login/callback RC's SDK is
        // exchanging the OAuth code and RC's SPA is completing step two of its sign-in
        // (GetSSOLoggedInUser -> customerId). This script is re-run on every navigation, and
        // on that page it found no form, no session yet, and RC's "Log in" control -- and
        // CLICKED IT, navigating away mid-exchange. Measured on both platforms: a second
        // callback, and on Android a session that had persisted ssoCustomerName from the
        // first exchange and no RC token, which is the state RC's own interceptor answers
        // with customerLogOut and its home page. The user saw "Before booking, please sign
        // in" over a locked campsite. Nothing on this page is ours to do; the outcome is
        // reported by rc-session when customerId lands.
        var chPath = '', chAtOkta = false;
        try { chPath = String((typeof location !== 'undefined' && location && location.pathname) || '').toLowerCase(); } catch (e) { chPath = ''; }
        // Okta's sign-in lives on its own subdomain of RC. Same host the close decision keys
        // on (rc-token-liveness.isMidSignIn), and read the same defensive way -- location can
        // be absent in a sandbox, and a throw here lands in the outer catch and reads as a
        // failed sign-in.
        try { chAtOkta = String((typeof location !== 'undefined' && location && location.hostname) || '').toLowerCase() === 'signin.reservecalifornia.com'; } catch (e) { chAtOkta = false; }
        if (chPath.indexOf('/login/callback') === 0) {
          chSay('callback-in-flight', {});
          return done(true, 'callback-in-flight', 'RC is completing its own sign-in on the callback page');
        }
        // ALREADY SIGNED IN is a success, and asking first is what stops us typing a
        // credential we did not need. The token capture is the authority; a form's absence
        // is not, because RC's SPA re-authenticates AFTER the page settles.
        if (chSignedIn()) return done(true, 'signed-in', 'already signed in');

        var pw = chFind(CH_PW_SELS);
        if (!pw) {
          // WAIT FOR RC TO RENDER ITS HEADER. See SIGNIN_WAIT_MS: we are injected at
          // loadstop and the control does not exist yet, so asking once loses a race we
          // cannot see ourselves lose. The poll tests before it waits, so a control that is
          // already there is pressed immediately.
          //
          // AND THE SAME WAIT ANSWERS "AM I SIGNED IN?", because that is the other thing
          // that can be true and is equally not knowable yet: the token arrives with RC's
          // first authenticated call, which is also after loadstop. Asking once, up top,
          // meant a signed-in user went hunting for a control RC does not render for them.
          // Whichever becomes true first ends the wait.
          //
          // WAIT FOR THE RIGHT THING, WHICH IS NOT THE SAME THING ON BOTH HOSTS
          // (2026-09-02). RC's sign-in control exists on RC's OWN pages. On Okta's host we
          // are already past it -- the form is what we are waiting for -- and hunting the
          // control there could only ever run out the clock. It did: every sign-in spent the
          // FULL 12s on Okta's identifier page before typing anything, reported
          // signin-missing with 6 candidates (Okta's sparse page, not RC's header), and then
          // found the email field instantly. The owner watched it and read it as failing,
          // which is the dangerous part -- a user who thinks it has hung starts pressing
          // things, and this is the one screen where that costs a campsite.
          //
          // Whichever becomes true first ends the wait, so the control path is unchanged and
          // still costs nothing when RC has already painted its header.
          var chWaitStart = Date.now();
          var found = await chWaitFor(function () {
            if (chSignedIn()) return 'signed-in';
            // THE FORM ONLY COUNTS ON OKTA'S HOST. RC's own pages carry a hidden login modal
            // with its own email and password inputs -- a DIFFERENT flow (RC's customerLogin,
            // not the Okta SSO this whole path depends on). chFind requires offsetParent, so
            // a hidden modal cannot match today; accepting the form on RC's host anyway would
            // make that one CSS change away from silently typing the credential into the
            // wrong form.
            if (chAtOkta) return (chFind(CH_EMAIL_SELS) || chFind(CH_PW_SELS)) ? 'form' : null;
            return chSignInControl();
          }, CH_SIGNIN_WAIT_MS);
          // HOW LONG IT ACTUALLY TOOK, on every branch. The pause was invisible in the trace
          // -- signin-missing said the hunt failed and never said it had spent twelve seconds
          // failing. A number here is what makes the next one a reading rather than a feeling.
          var chWaited = Date.now() - chWaitStart;
          if (found === 'signed-in') return done(true, 'signed-in', 'already signed in');
          if (found === 'form') chSay('signin-form', { waitedMs: chWaited });
          else if (found) { found.click(); chSay('signin-open', { waitedMs: chWaited }); }
          // NOT FINDING IT IS A FACT, AND IT WAS SILENT. On the park page RC renders its own
          // sign-in control in the header; if the match misses, everything downstream waits
          // 15s for a form that will never come and the user watches a calendar. Report the
          // MISS and how many candidates were on the page, so "RC reworded it" and "the page
          // had not rendered yet" can be told apart — 0 candidates means the DOM was empty.
          //
          // Never the candidates' text: RC's header carries the signed-in user's own name.
          else chSay('signin-missing', { candidates: document.querySelectorAll('a, button').length, waitedMs: chWaited, atOkta: chAtOkta });
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
          chKeepSignedIn('email');
          chSay('email', {});
          await chSettle();
          chSubmit(user);
          pw = await chWaitPassword();
        }
        if (!pw) {
          if (chSignedIn()) return done(true, 'signed-in', 'signed in without a password step');
          return done(false, 'password', chOktaError() || 'the password field never appeared');
        }

        chSetValue(pw, password);
        // NO READ-BACK HERE, DELIBERATELY. The email step reads its field back because a
        // wrong address is recoverable and worth naming; comparing pw.value to the password
        // would put the secret in a comparison this file exists to keep it out of, and a
        // thrown TypeError inside that expression is precisely how a password reached the
        // database on 2026-08-16.
        chKeepSignedIn('password');
        chSay('password', {});
        await chSettle();
        chSubmit(pw);
        chSay('submitted', {});

        // A challenge can also appear AFTER the password. Same rule: a human is here.
        for (var i = 0; i < 120; i++) {
          if (chSignedIn()) return done(true, 'signed-in', null);
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
