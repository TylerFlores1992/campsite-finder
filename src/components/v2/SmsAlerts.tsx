"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, MessageSquare } from "lucide-react";
import Button from "@/components/ui/Button";

/**
 * Text alerts — phone number + consent.
 *
 * THE DISCLOSURE COPY IS CARRIER COMPLIANCE, NOT MARKETING. A2P 10DLC registration is
 * approved against specific language: that consent is optional and not a
 * condition of purchase, the message-frequency statement, "message and data
 * rates may apply", HELP/STOP, and links to Terms and Privacy. Tightening any
 * of it to fit the new visual rhythm would put the campaign at risk, so the
 * strings are untouched and only the styling changed.
 *
 * Same /api/user/phone endpoint as the old form. POST with a number saves it,
 * POST with an empty string clears it — no data-layer change here at all.
 *
 * **`demo` renders THIS component on the public `/sms-opt-in` page**, which is the
 * page carriers and campaign reviewers look at without an account. It used to be a
 * separate `components/SmsOptIn.tsx` holding a second, hand-synced copy of the same
 * approved script — two files, one A2P registration, and nothing type-checking that
 * they agreed. They did agree, but only by luck: the same class of drift had already
 * bitten the auto-cart copy. That file is deleted and this is now the single source,
 * so what a reviewer sees is literally what a user sees.
 *
 * In demo mode the component is inert — no load, no save — because the page is public
 * and there is no session to read a number from. Everything else renders identically.
 */
export default function SmsAlerts({ demo = false }: { demo?: boolean } = {}) {
  const [phone, setPhone] = useState("");
  const [savedPhone, setSavedPhone] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  // `!demo` matters: the effect that clears this runs only on the client, so with
  // `true` the server-rendered HTML of the public /sms-opt-in page would be a grey
  // skeleton and the form would appear only after hydration. That page exists to be
  // READ by carrier reviewers — some of whom fetch it rather than browse it — so the
  // consent script has to be in the markup, not painted in a moment later.
  const [loading, setLoading] = useState(!demo);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Public page: no session, so /api/user/phone would 404 through Clerk. Skip
    // straight to the loaded, empty state a new user sees.
    if (demo) return; // nothing to load; `loading` already starts false
    let cancelled = false;
    fetch("/api/user/phone")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { phone?: string | null } | null) => {
        if (cancelled || !j) return;
        if (j.phone) {
          setSavedPhone(j.phone);
          setPhone(j.phone);
          // A saved number means consent was given when it was saved.
          setConsented(true);
        }
      })
      .catch(() => {
        /* the form still works; it just starts empty */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demo]);

  async function save() {
    if (demo) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/user/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? "Couldn't save that number");
      setSavedPhone(j.phone ?? null);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that number");
    } finally {
      setSaving(false);
    }
  }

  async function turnOff() {
    if (demo) return;
    setSaving(true);
    setError(null);
    try {
      await fetch("/api/user/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "" }),
      });
      setSavedPhone(null);
      setPhone("");
      setConsented(false);
    } catch {
      setError("Couldn't turn text alerts off");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="h-24 animate-pulse rounded-ch-input bg-ch-shell motion-reduce:animate-none" />
    );
  }

  const dirty = phone.trim() !== (savedPhone ?? "");

  return (
    <div>
      {savedPhone && !dirty ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-ch-input border border-[#BFDDC9] bg-ch-green-soft px-3.5 py-3">
          <span className="flex min-w-0 items-center gap-2 text-ch-body font-bold text-ch-green-deep">
            <MessageSquare aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{`Text alerts on · ${savedPhone}`}</span>
          </span>
          <Button variant="quiet" size="sm" disabled={saving} onClick={() => void turnOff()}>
            {saving ? "Turning off…" : "Turn off"}
          </Button>
        </div>
      ) : null}

      <div className={savedPhone && !dirty ? "mt-3" : ""}>
        {/* --- Compliance copy: do not reword. See the note at the top. --- */}
        <p className="rounded-ch-input border border-[#BFDDC9] bg-ch-green-soft px-3 py-2.5 text-ch-fine leading-normal text-ch-green-deep">
          <strong className="font-extrabold">Text alerts are optional.</strong> CampHawk works fully
          with email alerts alone — you never need to give a phone number to create an account,
          subscribe, or use any feature. Adding your number and checking the box below is entirely
          voluntary, and you can skip it.
        </p>

        <label
          htmlFor="ch-phone"
          className="mt-3 mb-1.5 block text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase"
        >
          {savedPhone ? "Change your number" : "Mobile number"}
        </label>
        <input
          id="ch-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(555) 123-4567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="w-full rounded-ch-input border border-ch-line bg-ch-card px-3.5 py-2.5 text-ch-body text-ch-ink placeholder:text-ch-faint focus-visible:border-ch-green focus-visible:outline-none"
        />

        <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-ch-fine leading-normal text-ch-ink-2">
          <input
            type="checkbox"
            checked={consented}
            onChange={(e) => setConsented(e.target.checked)}
            className="mt-0.5 accent-[#1E7A4C]"
          />
          <span>
            Yes, I&apos;d like to receive automated text messages from CampHawk when campgrounds
            I&apos;m watching have availability. Consent is not a condition of purchase.
          </span>
        </label>

        <p className="mt-2 text-ch-fine leading-normal text-ch-muted">
          <strong className="font-bold">Message frequency</strong> varies with campsite availability
          (typically at most one per watch).{" "}
          <strong className="font-bold">Message and data rates may apply.</strong> Reply{" "}
          <strong className="font-bold">HELP</strong> for help or{" "}
          <strong className="font-bold">STOP</strong> to cancel any time.{" "}
          <a href="/terms" target="_blank" className="underline underline-offset-2">
            Terms of Service
          </a>
          {" · "}
          <a href="/privacy" target="_blank" className="underline underline-offset-2">
            Privacy Policy
          </a>
        </p>

        <div className="mt-3">
          <Button
            fullWidth
            disabled={saving || !consented || !phone.trim() || (!dirty && !!savedPhone)}
            onClick={() => void save()}
          >
            {saving ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : justSaved ? (
              <>
                <Check aria-hidden="true" className="size-4" /> Saved
              </>
            ) : savedPhone ? (
              "Update number"
            ) : (
              "Turn on text alerts"
            )}
          </Button>
        </div>

        {error && (
          <p role="alert" className="mt-2 text-ch-fine text-ch-alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
