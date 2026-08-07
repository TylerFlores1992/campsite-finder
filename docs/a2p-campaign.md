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

## Where this actually gets entered

**Console:** **Trust Hub → Registrations → `A2P CAMPAIGNS` tab → click the campaign.**
That lands on "A2P Campaign Details", which shows the brand as Approved and has the
sections that map to the fields below: *Campaign description and content* holds the
**description**, *Sample messages* holds the **samples**, and *End user consent (message
flow)* holds the **message flow**.

> Twilio's docs give the path as "Messaging → Regulatory Compliance → Campaigns". That
> does NOT match this account's Console, and following it lands on **Regulatory
> Compliance**, a same-named tab in the same Registrations screen that is about buying
> phone numbers outside the US/Canada — nothing to do with A2P. Verified 2026-08-07 by
> ending up there. Use the A2P CAMPAIGNS tab.

Look for a blue **"Edit Campaign"** link. Twilio's docs say it appears on **failed**
campaign detail pages — ours is Approved, so it may well not be there. Campaign edits via
the API are a **Private Beta**, "only available to participants in this beta program",
with no self-serve enrollment. The edit modal, where available, covers description,
samples (up to five) and the opt-in description, but **not the use case**.

**If there is no Edit link — confirmed absent 2026-08-07 — it is a Twilio Support
ticket.** Draft below. Support is also the only documented way to learn whether a 30007
was Twilio's filter or the carrier's, so both questions go in one ticket, and the answer
to the second may make the first unnecessary.

**Filing it, on this account's plan.** Support Center says web support is included with
the **Developer** plan (~1 business day), but the *Support tickets* card offers only
"View ticket history" — there is **no create button**. Chat and phone are paid plans only.
So either:
1. `https://www.twilio.com/console/support/tickets/create` directly — the form may work
   even though the card does not link to it; or
2. **Ask Twilio Assistant**, which is how ticket creation is fronted on this plan, and
   **explicitly ask it to open a ticket / escalate to a human**. It is triage, not a
   replacement, and it will close the conversation if you only describe a symptom.

Lead with the ASK, not the error. Opening with the 30007s invites the generic "make your
samples match your traffic" article — the thing we already know — and never produces a
ticket. Open with "I need a ticket opened: I cannot edit an approved campaign's samples
and there is no Edit Campaign link."

### FILED: ticket #28871693 (2026-08-07 14:28 PT, P3, status New)

Submitted with the text below plus both custom-field answers ("Approved"; and that the
samples do follow the brand-name/variable guidelines — the problem is drift, not
compliance). Web support on the Developer plan quotes ~1 business day.

**When they reply, the decision is:** if the carrier filtered those SIDs, do the sample
edit. If TWILIO filtered them, the edit would not have fixed it — do not re-trigger
vetting on a campaign that is currently delivering.

### Support ticket draft

> **Subject:** Update message samples and description on approved A2P campaign
>
> Account: `My First Twilio Account`
> Brand: Camp Hawk — `BNb2dc221e086e621a5d4afdb77c387d7e`
> Messaging Service: Camp Hawk Alerts — `MG7bf4f78c06ea99f61efcbccd8fe47b5b`
>
> Two requests, and the second may answer the first.
>
> **1. Our registered message samples have drifted from live traffic.** They were written
> in July and our message copy has changed since: the sender string, the wording, and the
> set of reservation-site links we include. I would like to update the description,
> message flow and message samples on the approved campaign. I understand the four content
> booleans cannot change — `has_embedded_links` is already true and should stay true — and
> that an update re-triggers vetting. Please advise whether you can apply this edit, or
> whether my account can be enabled for the campaign-edit beta. The replacement text is
> ready to send.
>
> **2. We have been seeing error 30007 on alert messages.** Could you confirm whether
> those were filtered by Twilio or by the carrier? Message SIDs: `<paste 3+ SIDs>`. If the
> filtering is Twilio-side, the sample update above may not be the right fix and I would
> rather know before re-vetting a campaign that is currently delivering.
>
> `SM65b49396606386c2dd4bcb42b5175a1d` (2026-08-05 16:30 UTC)
> `SMfd84ee2df6442c3677bbd1dee1468b03` (2026-08-05 15:30 UTC)
> `SM96f9416e3874b52befb7c5297d7724db` (2026-08-05 14:30 UTC)
> `SMd7a8105387d4dd8f86f6920e8031bbcf` (2026-08-05 13:03 UTC)

All twelve recorded 30007s are from **2026-08-05**, before the `camphawk.app/b/<token>`
link was removed from SMS — none since. That is the strongest single piece of evidence we
have, and it is worth stating in the ticket if they ask. Re-pull any time:

```sql
SELECT provider_id, created_at, delivery_error FROM notifications
 WHERE channel = 'sms' AND provider_id IS NOT NULL AND delivery_error IS NOT NULL
 ORDER BY created_at DESC;
```

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
