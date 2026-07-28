import SmsAlerts from '@/components/v2/SmsAlerts';
import Logo from '@/components/Logo';

export const metadata = { title: 'SMS Alert Opt-In — CampHawk' };

/**
 * Public, non-functional copy of the SMS opt-in form — published so
 * carrier/campaign reviewers can see the exact opt-in experience without an
 * account. The real form lives on the `/settings` page, under "How we reach you".
 *
 * **It renders the REAL component** (`v2/SmsAlerts`, with `demo` so it can't
 * load or save), so a reviewer is looking at the same markup a signed-in user
 * gets. This used to be a second component holding a hand-synced copy of the
 * A2P-approved script — they happened to stay identical, but nothing enforced
 * it, and copy drift had already bitten elsewhere in the app. One source now.
 */
export default function SmsOptInPage() {
  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <div className="mb-4"><Logo markSize={34} /></div>
      <h1 className="text-xl font-bold text-ch-ink mb-1">Text Alert Opt-In (optional)</h1>
      <p className="text-sm text-ch-muted mb-4">
        This is the optional SMS opt-in form shown to signed-in users in their account
        settings at camphawk.app/settings. It is{' '}<strong>not</strong>{' '}part of sign-up,
        subscription, or checkout — those flows never ask for a phone number or SMS consent.
        Text alerts are a separate, voluntary add-on: a user must deliberately type their number
        and tick the unchecked consent box here before any text is sent. Users can skip this
        entirely and continue using every CampHawk feature with email alerts only.
      </p>
      <div className="bg-white border border-ch-line rounded-2xl shadow-sm p-5">
        <SmsAlerts demo />
      </div>
      <p className="text-xs text-ch-muted mt-4">
        Prefer not to receive texts? Simply leave this form blank — no phone number is stored and
        you keep full access to search, watches, and email alerts.
      </p>
    </div>
  );
}
