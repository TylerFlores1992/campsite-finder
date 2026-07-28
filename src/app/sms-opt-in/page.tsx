import SmsOptIn from '@/components/SmsOptIn';
import Logo from '@/components/Logo';

export const metadata = { title: 'SMS Alert Opt-In — CampHawk' };

/**
 * Public, non-functional copy of the SMS opt-in form — published so
 * carrier/campaign reviewers can see the exact opt-in experience without an
 * account. The real form lives on the `/settings` page, under "How we reach you".
 *
 * > **THIS PAGE MUST KEEP MATCHING THE REAL FORM.** It renders `SmsOptIn`,
 * > while the signed-in surface is now `v2/SmsAlerts` — two components, one
 * > A2P-approved script. Their consent copy is currently identical word for
 * > word (checked 2026-07-27: the checkbox label, the message-frequency line,
 * > "message and data rates may apply", HELP/STOP, and the Terms/Privacy
 * > links). **If you edit the consent language in either file, edit both**, or
 * > this page starts showing carriers something users never see. Nothing
 * > type-checks that.
 */
export default function SmsOptInDemoPage() {
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
        <SmsOptIn demo />
      </div>
      <p className="text-xs text-ch-muted mt-4">
        Prefer not to receive texts? Simply leave this form blank — no phone number is stored and
        you keep full access to search, watches, and email alerts.
      </p>
    </div>
  );
}
