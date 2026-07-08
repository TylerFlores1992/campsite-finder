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
      <h1 className="text-xl font-bold text-gray-800 mb-1">Text Alert Opt-In</h1>
      <p className="text-sm text-gray-500 mb-6">
        This is the SMS opt-in form shown to signed-in users inside their account settings
        (Watches panel) at camphawk.app. Users must enter their number and actively check the
        consent box before text alerts are enabled.
      </p>
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5">
        <SmsOptIn demo />
      </div>
    </div>
  );
}
