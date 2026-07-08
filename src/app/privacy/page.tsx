import Logo from '@/components/Logo';

export const metadata = { title: 'Privacy Policy — CampHawk' };

export default function PrivacyPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-10 text-gray-800">
      <a href="/" className="inline-block mb-6"><Logo markSize={30} /></a>
      <h1 className="text-2xl font-bold mb-1">CampHawk Privacy Policy</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: July 7, 2026</p>

      <div className="space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="font-semibold text-base mb-2">What we collect</h2>
          <p>
            When you create a Camp Hawk account we collect your email address. If you choose to
            receive text alerts, we also collect the mobile phone number you provide. We store the
            campground watches, favorites, and search preferences you create in the app.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">How we use it</h2>
          <p>
            Your email and phone number are used solely to deliver the campsite availability
            alerts you request and to operate your account. We do not send marketing messages.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Text messaging</h2>
          <p>
            Text alerts are strictly opt-in: you receive them only if you enter your mobile
            number in your account settings. Message frequency varies with campsite availability —
            typically at most one message per campground watch. <strong>Message and data rates may
            apply.</strong> Reply <strong>STOP</strong> to any message to opt out, or remove your
            number in account settings at any time. Reply <strong>HELP</strong> for help.
          </p>
          <p className="mt-2">
            <strong>No mobile information will be shared with third parties or affiliates for
            marketing or promotional purposes.</strong> Mobile numbers and text-messaging
            originator opt-in data and consent are not shared with any third parties, except for
            our SMS delivery provider (Twilio) solely to send the messages you requested.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Sharing</h2>
          <p>
            We do not sell or share your personal information. Data is processed by the service
            providers that run Camp Hawk (hosting, database, email, SMS, payments) solely to
            provide the service.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Deleting your data</h2>
          <p>
            You can remove your phone number or delete watches at any time in the app. To delete
            your account and data entirely, email{' '}
            <a href="mailto:alerts@camphawk.app" className="text-green-700 underline">
              alerts@camphawk.app
            </a>.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Contact</h2>
          <p>
            Questions:{' '}
            <a href="mailto:alerts@camphawk.app" className="text-green-700 underline">
              alerts@camphawk.app
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}
