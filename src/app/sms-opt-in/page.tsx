import SmsOptIn from '@/components/SmsOptIn';
import Logo from '@/components/Logo';

export const metadata = { title: 'SMS Alert Opt-In — CampHawk' };

/**
 * Public, non-functional copy of the SMS opt-in form that lives inside the
 * signed-in Watches panel — published so carrier/campaign reviewers can see
 * the exact opt-in experience without an account.
 */
export default function SmsOptInDemoPage() {
  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <div className="mb-4"><Logo markSize={34} /></div>
      <h1 className="text-xl font-bold text-gray-800 mb-1">Text Alert Opt-In (optional)</h1>
      <p className="text-sm text-gray-500 mb-4">
        This is the optional SMS opt-in form shown to signed-in users inside their account
        settings (Watches panel) at camphawk.app. It is <strong>not</strong> part of sign-up,
        subscription, or checkout — those flows never ask for a phone number or SMS consent.
        Text alerts are a separate, voluntary add-on: a user must deliberately type their number
        and tick the unchecked consent box here before any text is sent. Users can skip this
        entirely and continue using every CampHawk feature with email alerts only.
      </p>
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5">
        <SmsOptIn demo />
      </div>
      <p className="text-xs text-gray-400 mt-4">
        Prefer not to receive texts? Simply leave this form blank — no phone number is stored and
        you keep full access to search, watches, and email alerts.
      </p>
    </div>
  );
}
