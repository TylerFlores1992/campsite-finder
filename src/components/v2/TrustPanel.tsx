"use client";

import { useState } from "react";
import { cx } from "@/components/ui/cx";

/**
 * What auto-cart can and can't do with a Recreation.gov account.
 *
 * SAVED LOGIN IS NOT OPTIONAL, so this no longer pretends it might be. The
 * /connect form disables its submit button unless "Save my login" is checked
 * and labels it "(required)" — every auto-cart user has credentials stored.
 * An earlier version of this panel only revealed that behind a `savedLogin`
 * prop, and NewWatch never passed it, so the one block that admitted we store a
 * password never rendered while the block above it told everyone "that's a
 * session, not your password". That was a false privacy claim shown to every
 * user who turned auto-cart on. The disclosure is now unconditional.
 *
 * SESSIONS DO NOT "EXPIRE EVERY FEW WEEKS" EITHER. autocart_verified_at is a
 * 45-minute freshness window (AUTOCART_SESSION_STALE_MS) stamped by a bot
 * keepalive that runs about every 30 minutes. When it goes stale it means the
 * machine holding the session hasn't checked in — not that a login aged out —
 * and because the password is stored, the bot signs back in by itself. The copy
 * now describes that, because telling someone their sign-in expired sends them
 * to redo a thing that is already fixing itself.
 *
 * The risk lines will cost some opt-ins. They stay. This is the most
 * screenshot-able screen in the product for a sceptical user, and the honest
 * version is the one that survives being screenshotted.
 */
export interface TrustPanelProps {
  className?: string;
}

/* The `savedLogin` prop is gone. It gated the password disclosure, and saved
   login is required for auto-cart — there is no state in which the disclosure
   shouldn't show, so a prop that could hide it was a footgun. */
export default function TrustPanel({ className }: TrustPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cx(className)}>
      <div className="rounded-ch-input border border-ch-line bg-ch-card p-3.5">
        <h3 className="text-ch-body font-bold">What we can and can&apos;t do</h3>
        <ul className="mt-1.5">
          {[
            <>
              We stay signed in to your account in a browser on a private machine we run — never on
              our web servers, and never in our cloud database.
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
          Recreation.gov sessions drop from time to time. Because your login is saved, the machine
          signs back in on its own — you don&apos;t have to do anything. Auto-cart pauses for those
          few minutes, and your watches keep alerting you normally throughout.
        </p>
      </div>

      {/* Unconditional: auto-cart cannot be enabled without saving the login,
          so there is no version of this screen where it doesn't apply. */}
      <div className="mt-2.5 rounded-ch-input border border-[#E7C98C] bg-ch-ochre-soft p-3.5">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex w-full cursor-pointer items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
          >
            <span className="flex-1">
              <span className="block text-ch-body font-bold text-ch-ochre-ink">
                Auto-cart saves your Recreation.gov login
              </span>
              <span className="mt-0.5 block text-ch-fine text-[#A07B33]">
                It has to, so it can sign back in for you — tap to see exactly what that means.
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
                  We use it for exactly one thing: signing you back in when the session drops, so
                  auto-cart doesn&apos;t quietly stop working.
                </>,
                <>
                  After two failed sign-ins we delete it and ask you to reconnect, so a changed
                  password can&apos;t lock your account.
                </>,
                <>
                  Turning auto-cart off, or disconnecting, deletes the stored password immediately.
                </>,
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
              {/* The old version of this line offered "turn this off and we'll
                  ask you to reconnect every few weeks instead" — an option that
                  does not exist. /connect requires the saved login. The real
                  choice is auto-cart or no auto-cart, so that's what it says. */}
              <li className="mt-1.5 border-t border-[#E7C98C] pt-1.5 text-ch-fine leading-normal text-ch-ochre-ink">
                A saved password is more than a session — it&apos;s a reusable key to your
                Recreation.gov account. Auto-cart can&apos;t work without it. If you&apos;d rather
                not, leave auto-cart off: your watches still find the opening and still alert you in
                seconds, you just add the site to the cart yourself.
              </li>
            </ul>
          )}
      </div>
    </div>
  );
}
