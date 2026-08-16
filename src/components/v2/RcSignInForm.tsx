"use client";
import { useState } from "react";
import Button from "@/components/ui/Button";

/**
 * The ReserveCalifornia sign-in, collected in the app instead of typed on RC's own page.
 *
 * ## Where these go, and where they do not
 *
 * Straight into the app's own webview, against RC's real form, through the same
 * `executeScript` channel that already carries the precart. **They never reach a CampHawk
 * server, our database, or any log.** That is not a policy choice we could revisit lightly —
 * it falls out of the architecture. The cart is bound to the SESSION that made it, not the
 * account (measured 2026-08-06: a second session on the same account read that cart as 0
 * entries), so the session has to be the user's. A server-side login would produce a cart in
 * our Chromium that their phone could never see.
 *
 * ## Why there is no "save my password" box yet
 *
 * There is nowhere safe to put it. The app has no Keychain/Keystore plugin — `package.json`
 * carries no secure-storage dependency — and the alternatives on hand are `localStorage` and
 * Capacitor Preferences, neither of which is encrypted at rest. Offering to "save" into
 * either would be a promise the storage does not keep, on a credential that guards a real
 * account with an address and card details on file.
 *
 * Adding one is a native plugin, a rebuild and a new review — the same wall the InAppBrowser
 * hit — so it is a deliberate later decision rather than an oversight. Until then the user
 * types it, which is the honest version of the trade. The device's own password manager
 * already autofills this form, so the cost is smaller than it looks: `autoComplete` is set
 * to the values iOS and Android look for.
 *
 * ## The confirmation box
 *
 * Not ceremony. A wrong password submitted to Okta risks a lockout, and RC's Okta has
 * already shown it will serve a CAPTCHA to an address it dislikes — the bot carries a
 * two-strike rule and deletes stored credentials on a rejection for exactly this reason.
 * One deliberate tick before we submit on someone's behalf is cheap next to that.
 */
export interface RcSignInFormProps {
  /** Hand the credentials over. Resolves when the sign-in attempt has finished. */
  onSubmit: (email: string, password: string) => void | Promise<void>;
  /** True while the webview is open and the injected sign-in is running. */
  busy?: boolean;
  /** RC's own words for what went wrong, when it did. Never our paraphrase. */
  error?: string | null;
  /** What the injected script last reported — 'captcha' is the one the user must act on. */
  stage?: string | null;
}

export default function RcSignInForm({ onSubmit, busy, error, stage }: RcSignInFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  /**
   * Show the password.
   *
   * The confirmation box asks the user to promise the credentials are right, and a
   * masked field gives them nothing to check it against — so the promise was one they
   * could not actually keep. That matters more here than on an ordinary login: a wrong
   * password submitted to Okta risks a lockout, and we only get one attempt before the
   * site goes back on the open market.
   *
   * Defaults to hidden, and the toggle is the user's own act — this screen is opened at
   * 08:00 in whatever room they happen to be in.
   */
  const [reveal, setReveal] = useState(false);

  const ready = email.trim().length > 0 && password.length > 0 && confirmed && !busy;

  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void onSubmit(email.trim(), password);
      }}
    >
      <p className="text-ch-body text-ch-muted">
        We sign you in to ReserveCalifornia inside this app, then hand the site over. Your
        password goes straight to ReserveCalifornia — it is never sent to CampHawk.
      </p>

      <label className="mt-4 block">
        <span className="text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
          ReserveCalifornia email
        </span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          // The values iOS and Android look for, so the device password manager offers to
          // fill this. It is the closest thing to "save my password" we can honestly ship
          // without a Keychain plugin — and it is better, because the OS holds the secret.
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={busy}
          className="mt-1 w-full rounded-ch border border-ch-line bg-ch-surface px-3 py-2 text-ch-body"
        />
      </label>

      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-3">
          <label
            htmlFor="rc-password"
            className="text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted"
          >
            ReserveCalifornia password
          </label>
          {/* A real button, not a tap target on the field — screen readers get the state, and
              `aria-pressed` says which way it is rather than leaving them to infer it from a
              label that flips. */}
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-pressed={reveal}
            aria-controls="rc-password"
            className="text-ch-fine text-ch-muted underline"
          >
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
        <input
          id="rc-password"
          type={reveal ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          // A revealed password must not be autocorrected or capitalised on the way in —
          // iOS does both to a text input by default, which would silently change it.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={busy}
          className="mt-1 w-full rounded-ch border border-ch-line bg-ch-surface px-3 py-2 text-ch-body"
        />
      </div>

      <label className="mt-4 flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={busy}
          className="mt-0.5 size-4 shrink-0"
        />
        <span className="text-ch-fine text-ch-muted">
          I have checked these are right. A wrong password can lock the ReserveCalifornia
          account, and we only get one go at this before the site is back on the open market.
        </span>
      </label>

      {/* THE ONE STAGE THE USER MUST ACT ON. Everything else is progress; a challenge is a
          job. The bot treats a CAPTCHA as a full stop because nobody is there at 07:30 —
          here somebody is holding the phone, which is the whole reason this path can ask. */}
      {stage === "captcha" && (
        <p role="status" className="mt-3 text-ch-body text-ch-alert">
          ReserveCalifornia is asking you to prove you are human. Solve it in the window that
          just opened — we are still holding your site, and we will carry on the moment you
          are through.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-ch-body text-ch-alert">
          {error}
        </p>
      )}

      <Button type="submit" fullWidth disabled={!ready} className="mt-4">
        {busy ? "Signing you in…" : "Sign in and hand it over"}
      </Button>
    </form>
  );
}
