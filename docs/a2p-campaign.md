# A2P 10DLC campaign text — paste-ready

> ## THE CARRIER SAYS IT WAS A FILTERING BUG ON THEIR SIDE, AND IT IS FIXED (2026-08-14)
>
> Twilio (Christian M., ticket #28871693) relayed the Carrier Partner's finding. Quoting the
> two sentences that matter:
>
> > *"they were able to determine that the issue is indeed related to the URL included in the
> > messages (https://camphawk.app). The URL was mistakenly classified as potential spam due
> > to an error which affected the Carrier Partner's filtering mechanisms."*
> >
> > *"The Carrier Partner has applied the necessary corrections in order to remediate the
> > false positives."*
>
> **WHAT THIS CONFIRMS.** The domain was the cause. That was already the conclusion here — it
> was reached by dropping `Manage:` to get a 1-segment message that was still filtered, which
> separated domain from length — and it is now confirmed by the party doing the filtering.
> The confounded "2 segments get filtered" theory stays dead.
>
> **WHAT THIS OVERTURNS, and it is the more useful half.** This file and CLAUDE.md both carry
> an INFERRED mechanism: T-Mobile's Code of Conduct §4.8 "URL Redirects/Forwarding" and §3.3
> "Use One Recognizable Domain Name", with `/b/<token>` fitting §4.8 because it is a
> destination-hiding redirect. Both were explicitly labelled INFERENCE, and the carrier's
> answer is a **different mechanism entirely: a misclassification, i.e. a bug on their side.**
> Not a policy we tripped. Two consequences:
>   * **The shape of the URL was probably never the point.** The 08-05 evidence stands (that
>     traffic really was filtered), but "a short opaque path is a trigger" and "a redirect is
>     a trigger" are now unsupported as explanations of what happened to us. Do not keep
>     citing §4.8 as the reason; cite it, if at all, as a rule worth respecting anyway.
>   * **The registered samples were probably never the point either.** The whole "the samples
>     don't mention camphawk.app, so the carrier keys on that" story was inference too, and
>     the carrier did not say it.
>
> **WHAT IT DOES NOT DO.** It is an assurance about a correction we cannot verify from here,
> about a mechanism we cannot see, on infrastructure that can change without telling us. It
> is good evidence and it is not a guarantee. `sendSms` still throws on our own domain — see
> "The two that need `camphawk.app` registered FIRST" below — and lifting that guard is a
> product decision, not a documentation change.
>
> **The API campaign-edit permission is STILL not enabled** — Christian is waiting on Twilio's
> internal team. So the samples below still cannot be submitted, and that is now the only
> thing the ticket is still for.
>
> ### The second link test, 2026-08-14 02:48 UTC — 4 of 4 delivered
>
> Run against the real handset through the Messaging Service, one segment each, ~4s apart:
>
> | variant | link | our receipt | Twilio's API |
> |---|---|---|---|
> | `control-provider` | `recreation.gov/camping/campgrounds/232447` | delivered | `delivered` |
> | `camphawk-root` | `https://camphawk.app` | delivered | `delivered` |
> | `camphawk-page` | `camphawk.app/manage/EQO2oXcQ` | **no receipt** | `delivered` |
> | `camphawk-redirect` | `camphawk.app/b/9dc97c…` | delivered | `delivered` |
>
> **This has the same limitation as the 08-12 run and it must not be over-read.** The
> `/b/<token>` arm is the positive control — the exact shape filtered **13 for 13** on 08-05 —
> and it arrived. A control that passes means filtering is not being applied, so the run
> **cannot rank link shapes**. What it licenses is "nothing of ours was filtered on
> 2026-08-14", which is consistent with the carrier's correction and is not proof of it.
>
> **AND IT EXPOSED A HOLE IN THE REGRESSION DETECTOR.** `camphawk-page` is `delivered` at
> Twilio and has `delivery_status = NULL` here. Cause: `sms-link-test.mts` INSERTs the row
> **after** `twilioSend` returns, and `/api/webhooks/twilio` matches on `provider_id` — so any
> status callback that lands before that INSERT commits matches nothing and is dropped, for
> ever, because Twilio does not resend. **A lost receipt reads as "pending, no answer yet",
> which the admin panel treats as a broken callback URL — not as a delivery failure.** Two
> different faults, one output, in the instrument whose whole job is to catch this domain
> going bad again. Production has 104/104 receipts since 08-06 so the race has not bitten a
> real alert (`src/lib/notifications/index.ts` inserts from Vercel, next to the database,
> rather than from a remote script), but the same ordering is there. **The robust fix is a
> per-message `StatusCallback` URL carrying our own row id**, so matching never depends on a
> write that races the callback — and the signature check must sign that exact URL, which it
> already does by construction.

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

## Message samples — GENERATED 2026-08-12, paste-ready

**Generated by `npx tsx scripts/a2p-samples.mts --proposed`, not written by hand.** The
bodies come from the same pure `smsBody()` the dispatcher uses, so they cannot drift from
live traffic the way the 7/7/2026 set did — that drift is the entire reason 13 texts were
filtered on 08-05 while the campaign showed Approved throughout.

Re-run it after ANY change to `sms-body.ts` and diff against what is registered.
`--check` exits 1 if a body exceeds one segment.

### The seven we send today

```
CampHawk: Kirk Creek Site 019 open for Sep 4-6. Book: https://www.recreation.gov/camping/campgrounds/233116

CampHawk: Leo Carrillo SP — Canyon Campground (sites 1-24, 78-133) Site #L108 open for Sep 4. Book: https://www.reservecalifornia.com/park/665/539

CampHawk: Silver Lake Campground June Lake (CA) Site 018 STILL open for Oct 9-10. Book: https://www.recreation.gov/camping/campgrounds/232279

CampHawk: Leo Carrillo SP — Canyon Campground (sites 1-24, 78-133) Site #L108 was just cancelled, opens Aug 7, 8:00 AM PT. We'll text when it's bookable.

CampHawk: Leo Carrillo SP — Canyon Campground (sites 1-24, 78-133) Site #L108 opens Aug 7, 8:00 AM PT. Open your email or the app to have us hold it.

CampHawk: Silver Lake Campground June Lake (CA) Site 018 is in your cart — check out now, held ~15 min: https://www.recreation.gov/cart

CampHawk: Leo Carrillo SP — Canyon Campground (sites 1-24, 78-133) Site #L108 is HELD ~15 min. Open your email or the CampHawk app to claim it.
```

### The two that need `camphawk.app` registered FIRST

These are **not sent today** — `sendSms` throws on a camphawk.app link, and that guard
stays until these are registered and re-approved.

```
CampHawk: Leo Carrillo SP — Canyon Campground Site #L108 is HELD for you. Claim: https://camphawk.app/claim/fb538861-3c2f-4b1e-9a77-2e0d5c8a91b4?t=aB3xY9zQ

CampHawk: Leo Carrillo SP. Site #L108 opens Aug 7, 8:00 AM PT. Have us hold it: https://camphawk.app/claim/fb538861-3c2f-4b1e-9a77-2e0d5c8a91b4?t=aB3xY9zQ
```

### Three things to know before submitting these

- **THE MEASURED SHAPE AND THE PROPOSED SHAPE ARE NOT THE SAME.** The 2026-08-12 link
  test sent `camphawk.app/manage/<8-char-token>` and it delivered; these samples carry
  `camphawk.app/claim/<uuid>?t=<token>` — longer, with a UUID path and a query string.
  Both are real pages rather than redirects, so both satisfy the one DOCUMENTED rule
  (T-Mobile §4.8 is "URL Redirects/Forwarding"), but nothing has been measured about the
  claim shape. Do not cite the link test as evidence for it.
- **AND THAT RUN PROVED LESS THAN IT LOOKS.** All four arms delivered, including the
  `/b/<token>` positive control that was filtered 13-for-13 on 08-05. A control that
  passes means filtering was simply not being applied that day, so the run cannot rank
  shapes at all. It licenses "our domain was not filtered on 2026-08-12" and nothing
  broader.
- **155 and 154 characters, against a 160 budget** — and that is already *after*
  `fitOneSegment` trims the campground name. Five characters of margin. If the claim URL
  ever grows (a longer token, an extra param) these become two segments, and a
  2-segment alert is the shape that was being filtered. Re-run `--check` after any change.

### The rule that made this necessary

Every link domain in live SMS must appear in the registered samples. Today that is:

```
www.recreation.gov
www.reservecalifornia.com
```

A domain we send but never registered is the one that gets filtered — **and the campaign
looks healthy the entire time**, which is exactly how 08-05 happened.

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
