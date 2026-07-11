import Logo from '@/components/Logo';

export const metadata = { title: 'Terms of Service — Camp Hawk' };

export default function TermsPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-10 text-gray-800">
      <a href="/" className="inline-block mb-6"><Logo markSize={30} /></a>
      <h1 className="text-2xl font-bold mb-1">Camp Hawk Terms of Service</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: July 7, 2026</p>

      <div className="space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="font-semibold text-base mb-2">The service</h2>
          <p>
            Camp Hawk (camphawk.app) helps you find campsite availability across US public lands
            and California State Parks, and alerts you by email and (optionally) text message when
            a campground you watch becomes available. Camp Hawk is not affiliated with
            Recreation.gov, ReserveCalifornia, the National Park Service, or California State
            Parks. All bookings happen on the official reservation sites.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">No guarantees</h2>
          <p>
            Availability data comes from third-party reservation systems and can change at any
            moment. Alerts are best-effort: a site may already be taken by the time you act, and
            we cannot guarantee delivery timing of any notification. Camp Hawk is provided
            &quot;as is&quot; without warranties of any kind.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Text alerts</h2>
          <p>
            Text alerts are <strong>optional and separate from these Terms</strong> — agreeing to
            this Terms of Service does <strong>not</strong> opt you into text messages, and SMS
            consent is never required to create an account, subscribe, or use any Camp Hawk feature.
            You opt in only by deliberately entering your number and checking the consent box in
            your account settings. Message frequency varies with campsite availability. Message and
            data rates may apply. Reply STOP to opt out or HELP for help. See our{' '}
            <a href="/privacy" className="text-green-700 underline">Privacy Policy</a> for how
            your number is handled.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Subscriptions</h2>
          <p>
            Some features require a paid subscription, billed through Stripe. You can cancel any
            time via the &quot;Manage subscription&quot; option; access continues through the end
            of the paid period.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Acceptable use</h2>
          <p>
            Don&apos;t abuse the service, attempt to disrupt it, or use it to violate the terms of
            the underlying reservation systems.
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
