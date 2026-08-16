/**
 * What the claim screen is allowed to say, and on what evidence.
 *
 * ## Why the words live in a module of their own
 *
 * One sentence on this screen has been governed by a written rule since 2026-08-09 and by a
 * test since 2026-08-12: **the claim copy must not promise a cart.** The reasoning is not
 * about tone. A user who believes the site is handled STOPS WATCHING — and the ~2.5s window
 * between the bot letting go and somebody re-taking the site is then spent by nobody. A
 * manual flow that a user follows beats an automatic one that does not run.
 *
 * That rule was enforced by a regular expression over `ClaimFlow.tsx`'s JSX. It caught the
 * mistake it was written for, and it could only ever answer "is the phrase anywhere in the
 * file?" — which is the wrong question now that the answer depends on the runtime. The
 * promise is honest on a client that can actually inject the precart and dishonest on one
 * that cannot, and both branches live in the same file.
 *
 * So the copy is a function of the capability, the capability is its argument, and the test
 * calls it rather than reading it. `worker/rc-handoff.test.mts` exercises both branches.
 *
 * ## What earned the promise
 *
 * The two RC cart POSTs were unproven for four days and are now measured: two synthetic
 * holds on 2026-08-13 (12:31 and 12:47 PT) both reported `✓ Added to cart` through the
 * client report channel, and the first was confirmed by eye on ReserveCalifornia's own cart
 * page — the right unit, the right dates. That is what makes `canInject === true` copy
 * allowed to describe a cart.
 *
 * **It is measured on iOS only.** Android has sign-in, session persistence and token
 * capture; it has never run `load` + `submit`. The promise is therefore still a claim about
 * a capability rather than about a platform, which is the honest shape either way: if the
 * Android POSTs turn out to fail, the report channel says so on the first real hold, and
 * this is the one place the wording has to change.
 */

export interface HandoffCopy {
  /** Heading over the sign-in step, before anything is released. */
  prepareTitle: string;
  prepareBody: string;
  prepareCta: string;
  /** Shown while the RC window is open and no token has been seen yet. */
  waitingTitle: string;
  waitingBody: string;
  /** A live RC session was confirmed (or asserted). */
  readyTitle: string;
  releaseCta: string;
  /** Mid-release, while the bot lets go. */
  releasingBody: string;
  /**
   * Step one, arrived at from the OTHER side — a user who reopened a hand-off that had
   * already released, and so has never signed in inside this webview. Rendered instead of
   * `afterBody`, so it must not promise a cart: at this point we have not tried one, and the
   * whole reason this text exists is that we cannot yet.
   */
  afterSignInBody: string;
  /** After the release — the only place a cart may be described. */
  afterBody: string;
  afterCta: string;
}

/**
 * @param canInject Does THIS client have an injectable in-app webview? Probed at runtime
 *   in `lib/native/rc-handoff`, never assumed from the user agent or the platform.
 */
export function handoffCopy(canInject: boolean): HandoffCopy {
  if (!canInject) {
    // THE PLAIN-BROWSER PATH — a phone browser, a desktop, an older app binary. Nothing
    // here can cart, so nothing here says we will. A desktop user with the CampHawk
    // extension installed WILL be carted for automatically, and we still do not promise it:
    // we cannot detect the extension from this page, so the promise would be a guess, and a
    // pleasant surprise is a much better failure than a broken one.
    return {
      prepareTitle: 'Open ReserveCalifornia and sign in',
      prepareBody:
        'Do this first, in another tab. Find your site and get as far as you can without booking — it will look taken, because we are the ones holding it.',
      prepareCta: 'Open ReserveCalifornia in another tab',
      waitingTitle: 'Sign in over there, then come back',
      waitingBody: 'Nothing has been released yet. We keep holding it until you say go.',
      readyTitle: 'Ready when you are',
      releaseCta: "It's mine — hand it over",
      releasingBody:
        'Switch to your ReserveCalifornia tab and book it — we will also send you there if you stay here.',
      // UNREACHABLE ON THIS BRANCH, and kept honest anyway. `rcHandoffStep` returns 'finish'
      // whenever there is no injectable webview, because the hand-off then opens the system
      // browser where the user's own session already lives — there is nothing for us to
      // establish. The field stays because a copy branch that returns a partial object is how
      // the wrong one gets rendered later.
      afterSignInBody:
        'Sign in to ReserveCalifornia first, then book it — it is open to anyone until you do.',
      afterBody: 'Book it on ReserveCalifornia now — it is open to anyone until you do.',
      afterCta: 'Book it on ReserveCalifornia',
    };
  }

  // THE INJECTED PATH. `canInject` is true only when a Cordova InAppBrowser with
  // `executeScript` answered the runtime probe, which is the same capability that carries
  // the precart. Proven end to end on 2026-08-13 — see the header.
  return {
    // WE DO THE SIGNING IN NOW. The old copy — "We open ReserveCalifornia right here. Sign
    // in, then come back" — described a trip the user no longer takes: they type the
    // credentials here and the app fills RC's own form inside the webview. Saying "sign in,
    // then come back" over a form that does it for them is the same class of error as
    // telling an app user to "switch to your ReserveCalifornia tab".
    //
    // It still promises nothing about a cart. That sentence is `afterBody`'s alone and is
    // reachable only after a release, which is what two real holds earned it.
    prepareTitle: 'Sign in and we will hand it over',
    prepareBody:
      'Enter your ReserveCalifornia login and we will sign you in here, then pass the site straight to you. Your password goes to ReserveCalifornia, never to us.',
    prepareCta: 'Sign in to ReserveCalifornia',
    waitingTitle: 'Waiting for you to sign in',
    waitingBody:
      'Sign in in that window, then close it. Nothing has been released yet — your site is still ours.',
    readyTitle: "Signed in. It's yours whenever you're ready",
    releaseCta: "It's mine — hand it over",
    releasingBody: "Stay on this screen — we'll open ReserveCalifornia the moment it's yours.",
    // THE REVISIT. The site is already free, so there is no exposure window left to protect
    // and no urgency to manufacture — the honest thing is to say why we are asking for a
    // sign-in before sending them on. Deliberately promises nothing about a cart: the precart
    // has not run, and it is precisely the missing session that stops it running.
    afterSignInBody:
      "It's free for anyone now, so grab it. We can't see a ReserveCalifornia sign-in in this app — sign in first and we'll take you straight to the site.",
    // THE SENTENCE THE GUARD EXISTS FOR, and the one two real holds earned. Reachable only
    // with an injectable webview, and only after the release — so it reports what the
    // precart is doing rather than predicting what we might manage. Owner note 6 in
    // substance: say plainly that it is carted, and name the control that reaches checkout.
    afterBody:
      "We're putting it in your cart. When ReserveCalifornia opens, tap the cart icon at the top to check out.",
    afterCta: 'Finish on ReserveCalifornia',
  };
}
