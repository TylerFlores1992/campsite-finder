"use client";

import { useState } from "react";
import { cx } from "@/components/ui/cx";

/**
 * What auto-cart can and can't do with a Recreation.gov account.
 *
 * REWRITTEN FROM THE MOCKUP, WHICH WAS FACTUALLY WRONG. Its copy read "we hold
 * an encrypted session token, not your password" — true for the default, and
 * FALSE for anyone who enabled the saved-login option, where the bot stores real
 * credentials (DPAPI-encrypted, on the operator's machine) so it can re-login
 * when the session dies.
 *
 * Rather than soften that into something vague enough to cover both, the panel
 * splits. The green block describes the default session and stays true for
 * everyone. The ochre block appears only for the opt-in that actually stores a
 * password — ochre because it's the "you asked for this" colour, and this is the
 * one place in the product where the user takes on real risk.
 *
 * The risk line at the bottom will cost some opt-ins. It stays. This is the most
 * screenshot-able screen in the product for a sceptical user, and the honest
 * version is the one that survives being screenshotted.
 */
export interface TrustPanelProps {
  /** Whether the account has saved-login enabled; reveals the second block. */
  savedLogin?: boolean;
  className?: string;
}

export default function TrustPanel({ savedLogin = false, className }: TrustPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cx(className)}>
      <div className="rounded-ch-input border border-ch-line bg-ch-card p-3.5">
        <h3 className="text-ch-body font-bold">What we can and can&apos;t do</h3>
        <ul className="mt-1.5">
          {[
            <>
              We stay signed in to your account in a browser on a private machine we run — not on
              our web servers. That&apos;s a <strong className="font-extrabold text-ch-ink">session</strong>, not your password.
            </>,
            <>
              The only thing we do with it is{" "}
              <strong className="font-extrabold text-ch-ink">add a site to your cart</strong>. Nothing is ever bought.
            </>,
            <>We can&apos;t check out, cancel, or change a reservation you already have.</>,
            <>
              Disconnecting signs out and deletes the session right away. Your watches keep running
              — just without auto-cart.
            </>,
          ].map((line, i) => (
            <li key={i} className="flex items-start gap-2 py-1 text-ch-meta leading-normal text-ch-ink-2">
              <span aria-hidden="true" className="mt-px shrink-0 text-[11px] font-extrabold text-ch-green">
                ✓
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 border-t border-ch-line pt-1.5 text-ch-fine leading-normal text-ch-muted">
          Sessions expire every few weeks. We&apos;ll tell you when yours needs renewing, and
          auto-cart pauses until it does.
        </p>
      </div>

      {savedLogin && (
        <div className="mt-2.5 rounded-ch-input border border-[#E7C98C] bg-ch-ochre-soft p-3.5">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex w-full cursor-pointer items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
          >
            <span className="flex-1">
              <span className="block text-ch-body font-bold text-ch-ochre-ink">
                You have &ldquo;Keep me signed in&rdquo; on
              </span>
              <span className="mt-0.5 block text-ch-fine text-[#A07B33]">
                That stores more than a session — tap to see exactly what.
              </span>
            </span>
            <span aria-hidden="true" className="text-[11px] text-ch-ochre-ink">
              {open ? "▲" : "▼"}
            </span>
          </button>

          {open && (
            <ul className="mt-2 border-t border-[#E7C98C] pt-2">
              {[
                <>
                  We store your Recreation.gov{" "}
                  <strong className="font-extrabold">password</strong>, encrypted, on that same
                  private machine. It never reaches CampHawk&apos;s servers or database.
                </>,
                <>
                  We use it for exactly one thing: signing you back in when the session expires, so
                  auto-cart doesn&apos;t quietly stop working.
                </>,
                <>
                  After two failed sign-ins we delete it and ask you to reconnect, so a changed
                  password can&apos;t lock your account.
                </>,
                <>Turning it off deletes the stored password immediately.</>,
              ].map((line, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 py-1 text-ch-meta leading-normal text-ch-ink-2"
                >
                  <span aria-hidden="true" className="mt-px shrink-0 text-[11px] font-extrabold text-ch-ochre-ink">
                    !
                  </span>
                  <span>{line}</span>
                </li>
              ))}
              <li className="mt-1.5 border-t border-[#E7C98C] pt-1.5 text-ch-fine leading-normal text-ch-ochre-ink">
                A saved password is more than a session — it&apos;s a reusable key to your
                Recreation.gov account. If you&apos;d rather not, turn this off and we&apos;ll ask
                you to reconnect every few weeks instead.
              </li>
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
