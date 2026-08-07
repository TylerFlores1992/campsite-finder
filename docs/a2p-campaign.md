# A2P 10DLC campaign text — paste-ready

Brand **Camp Hawk** (`BNb2dc221e086e621a5d4afdb77c387d7e`), campaign on messaging service
**Camp Hawk Alerts** (`MG7bf4f78c06ea99f61efcbccd8fe47b5b`), tier `SOLE_PROPRIETOR`.

**Why this file exists.** The registered samples were written 7/7/2026 and never touched
while the code moved on. By 2026-08-05 they described an app we had stopped being: a
different sender string, an emoji we no longer send, a "Reply STOP" line we dropped, and
two of the eighteen link hosts we actually use. Every alert was being filtered (30007, ten
for ten) while the campaign sat Approved and healthy. Keeping the text in the repo means a
diff is possible; nothing else about the registration is visible from here.

**The samples are NOT in this file** — they are generated from the code that sends them:

```
npx tsx scripts/a2p-samples.mts            # what we send today
npx tsx scripts/a2p-samples.mts --proposed # + the camphawk.app shapes, if we register them
```

One source of truth each: samples come from the dispatcher, prose lives here.

---

## Before you paste

- The **four booleans are frozen** after TCR approval — `has_embedded_links`,
  `has_embedded_phone`, `direct_lending`, `age_gated`. Resend them **unchanged**.
  `has_embedded_links` is already `true`, which is why nothing frozen blocks this edit.
- An update **re-triggers vetting** on a campaign that is currently Approved and
  delivering. That is the real risk here, not the fee.
- Since **2026-06-30**, `PrivacyPolicyUrl` and `TermsAndConditionsUrl` are required.
  Use `https://camphawk.app/privacy` and `https://camphawk.app/terms` — both public, both
  verified 200.
- The in-place edit path (Console "Edit Campaign" / the update `POST`) is **Private
  Beta**. Confirm the account has it before planning around it.

---

## Description

> CampHawk (camphawk.app) is a campsite cancellation alert service. A user creates an
> account, picks the specific campgrounds and dates they want, and CampHawk watches those
> campgrounds on their official reservation systems. When a site the user is watching
> becomes available — almost always because somebody cancelled — CampHawk texts that user
> so they can book it before it is taken.
>
> Every message is triggered by a watch the recipient set up themselves, names the
> campground and the dates they chose, and links to the official reservation page for that
> campground so they can finish the booking. Which site that is depends on the campground:
> recreation.gov for federal campgrounds, or the relevant state park reservation system —
> for example reservecalifornia.com, reserveohio.com, reservevaparks.com,
> midnrreservations.com, reserve.tnstateparks.com. CampHawk is not affiliated with any of
> these agencies, does not take payment for reservations, and only ever links to their
> official booking pages.
>
> Messages are transactional and one-to-one. There is no marketing, no promotional
> content, and no third-party content of any kind. Nothing is ever sent to a number that
> its owner has not entered and confirmed inside their own CampHawk account. Typical
> volume is at most one text per watch when an opening is found. Phone numbers are never
> bought, rented, sold, or shared.

## Message flow (how consent is obtained)

> Consent is collected on camphawk.app inside the user's own signed-in account, in one of
> two places that show the identical form: the account settings page at
> camphawk.app/settings, or an optional welcome step shown once after an account is
> created, which has a Skip button.
>
> The exact opt-in experience is published for review, with no account needed, at
> https://camphawk.app/sms-opt-in
>
> Opting in takes two deliberate actions: the user types their own mobile number into an
> empty field, and ticks a checkbox that is UNCHECKED by default. The submit button stays
> disabled until both are done. The checkbox reads: "Yes, I'd like to receive automated
> text messages from CampHawk when campgrounds I'm watching have availability. Consent is
> not a condition of purchase."
>
> Immediately below it, before anything is submitted, the form states: "Message frequency
> varies with campsite availability (typically at most one per watch). Message and data
> rates may apply. Reply HELP for help or STOP to cancel any time." — alongside links to
> the Terms of Service (https://camphawk.app/terms) and Privacy Policy
> (https://camphawk.app/privacy).
>
> Text alerts are optional and separate from everything else. They are never part of
> sign-up, subscription, or checkout, and are never required to create an account,
> subscribe, or use any feature; a user who skips this keeps full access and receives
> email alerts only. A user can delete their number at any time in settings, or reply STOP
> to any message. STOP and HELP are handled by the messaging service's Advanced Opt-Out.

---

## Notes worth keeping with the text

**Why the message bodies carry no "Reply STOP to opt out."** The messaging service's
Advanced Opt-Out handles STOP/HELP, and the alerts have to fit one GSM-7 segment — a
two-segment alert is the shape that came back Undelivered. The consent language above is
where the disclosure lives, which is what the rules ask for. The registered samples still
carry the line; that is drift to fix, in the samples.

**Eighteen link hosts, five sample slots.** Samples describe message SHAPES, not
destinations, and the campaign has no domain allow-list to populate — Twilio's API exposes
only `HasEmbeddedLinks` and `MessageSamples`. So the breadth is stated in the description
above, and the five samples cover the shapes. Do not try to enumerate hosts in samples.

**We have no evidence that an unregistered PROVIDER domain gets filtered.** The only
domain ever observed filtered was our own `camphawk.app/b/<token>` — which was also a
redirect, and also absent from the samples, so the two explanations were never separated.
If unregistered domains alone were the mechanism, every Ohio and Michigan alert would fail
too, and we have no data either way (almost all live watches are rec.gov and RC). Treat
the host list as a documentation fix, not an emergency.

**Do not route alert links through camphawk.app to consolidate the domains.** That is
exactly what `/b/<token>` did, and T-Mobile's Code of Conduct §4.8 is "URL
Redirects/Forwarding". Measured, same handset, same segment count: recreation.gov link →
Delivered; no link → Delivered; `camphawk.app/b/<token>` → Undelivered 30007, ten for ten.
