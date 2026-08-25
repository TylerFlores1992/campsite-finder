# Getting CampHawk mentioned — the submission packet

*Written 2026-08-25, off the first real Search Console data.*

Everything here needs a human with an account. Nothing in this file can be done by an
agent: every target requires signing up as you, and the highest-value ones require a
person the recipient can reply to. What this file removes is the writing, the research
and the ordering — each entry should be a paste and a send.

## Read this before spending any time on it

**The constraint is authority, and it is measured.** Trailing 28 days to 2026-08-25:
14.9K impressions, 46 clicks, average position **49.9**. Eight pages sit in the top 20
and four in the top 10 — all of them ultra-specific listings (a wall tent, a cabin
colony, a youth group site) — while **every query with real volume sits at 44-87.**
A search for "CampHawk" returns nothing but camphawk.app: no review, no directory
entry, no forum thread. Nothing on the internet links here.

**I previously called directory listings "real links" and that was too strong.**
Product Hunt's outbound product links are nofollow, and several others in this list
are likely the same — verify per site rather than assuming. Their honest value is
**referral traffic and discoverability**, not ranking authority. Someone searching
"Campnab alternative" and finding you is a genuinely good outcome; it is not the thing
that moves you off position 50.

**Which is why the order below is not the order I first gave.** Tier 1 is editorial
outreach, because those are real dofollow links from topically relevant pages that
already rank for the queries we want — and they are the only items here that address
the actual constraint. The directories are Tier 2: cheap, fast, worth doing, and not
a fix.

---

## The positioning everything below is built from

**The differentiator is auto-cart AND non-rec.gov coverage — never price.**

The floor is free, and it is lower than it looks. Campflare covers 10,000+ campgrounds
at $0; Outdoorithm has a free tier across 44 reservation systems; and — the one that
matters most — **Recreation.gov itself launched free Availability Alerts in July 2024**,
official, on every reservable rec.gov location, capped at 3 active alerts. So on
recreation.gov, "we will tell you when a site frees up" is now a feature the booking
system gives away, and pitching it there competes with the source of truth.

Two things survive that, and the copy should lead with them:

1. **Auto-cart.** Nothing else holds the site for you. Measured detection-to-cart is
   ~12 seconds. Recreation.gov will never build this — it would be carting against
   itself.
2. **The 13 non-rec.gov systems**, ReserveCalifornia above all. Rec.gov's alerts do not
   cover them, and no state portal offers its own. This is not a hypothetical edge:
   **12 of 13 live watches are ReserveCalifornia.** The paying customers are already
   there.

Do not claim a cancellation-detection speed for competitors we have not measured.
"~12 seconds, measured" is ours and is true; anything comparative should quote only
what the other party publishes about themselves.

Do not claim a cancellation-detection speed for competitors we have not measured.
"~12 seconds, measured" is ours and is true; anything comparative should quote only
what the other party publishes about themselves.

**One-liners, in ascending length:**

- `Get alerted the second a campsite is cancelled — and we'll hold it for you.` (74)
- `We watch booked campgrounds every 15 seconds and cart the opening for you.` (73)
- `Campsite cancellation alerts in seconds, with auto-cart on Recreation.gov.` (73)

**Short description (~250 chars):**

> CampHawk watches booked campgrounds across Recreation.gov and 13 state park systems
> and alerts you within seconds of a cancellation — by text, email and push. On
> Recreation.gov it can put the site straight in your cart, so it's held while you get
> to your phone. Live search is free.

**Long description (~600 chars):**

> The campsite you wanted is already booked. CampHawk waits for it.
>
> We recheck watched campgrounds every 15 seconds, around the clock, across 8,000+
> campgrounds on Recreation.gov, ReserveCalifornia and 12 other state park systems.
> The moment someone cancels, you get a text, an email and a push notification with a
> direct link to the exact site — and on Recreation.gov we can add it to your cart
> automatically, so it's held for about 15 minutes while you get to your phone.
>
> Fixed dates or flexible ("any 3 nights in September"), which catches far more
> cancellations than one locked weekend. Searching live availability is free and needs
> no account. Watching is $2.50/month.

**Facts that are safe to state** (all verified in-repo, 2026-08-25):
- **"8,000+ campgrounds", 14 reservation sources** — see `/sources`, which lists every
  one. Use `campgroundsRounded()`'s wording, not a raw count: `COVERAGE` in
  `src/lib/coverage.ts` rounds DOWN on purpose ("never overstate"), the raw table
  holds hidden rows, and a marketing figure that disagrees with the site's own copy is
  the kind of small inaccuracy a reviewer or a journalist checks first
- 15-second recheck interval
- Alerts by SMS, email and push
- Auto-cart on Recreation.gov; RC hold hand-off is **beta** — say so if it comes up
- $2.50/mo or $20/yr alerts-only; $10/mo or $50/yr with auto-cart
- 7-day free trial
- Free live search, no account

**Do NOT claim:** any national ranking of "hardest to book"; a cancellation *rate*;
that we book or pay for anything (we never do — checkout is always the user's, on the
provider's site); or that RC auto-hold is generally available.

---

## Tier 1 — editorial outreach (the only items that address the constraint)

These publishers have already written "best campsite cancellation app" roundups. They
rank for the queries we want, their links are editorial and typically dofollow, and
**every one of them currently lists competitors and omits CampHawk.** Being added is
worth more than every directory below combined.

| Target | Existing piece | Angle |
|---|---|---|
| Happiest Outdoors | "The Best Camping Cancellation Apps: Campnab vs. Schnerp" | Independent, ranks for the comparison query, covers no tool that carts for you |
| Here & There (Substack) | "How to find campsite cancellations, for free" | Small, replies to email, and the "for free" framing is one auto-cart genuinely answers |

**THERE ARE ONLY TWO, AND THE REASON IS ITSELF THE FINDING.** An earlier draft of this
file listed four and named Outdoorithm and Hipcamp. Both are wrong targets:
**Outdoorithm is a direct competitor** ($12.99-$19/mo, free tier, 44 reservation
systems, apps on both stores) and its "CampNab & CampFlare Alternative" page is its own
marketing; **Hipcamp partnered with Campflare in 2023**, so it has an incumbent.
Outdoor Status and Campsite Notifier are likewise products, not publishers.

**The "best cancellation app" SERP is owned almost entirely by the products
themselves, not by independent reviewers.** That is why this tier is two emails and not
twenty, and it should be read as a limit on the strategy rather than a to-do list to
pad. Do not email a competitor asking to be added to their comparison page.

### The two emails, ready to send

**Send them separately, from your own address, as plain text.** No BCC, no signature
block, no logo. These read as one person writing to another because that is what they
have to be.

---

#### 1. Kyle Frost — Here & There — `kyle@kylefrost.com`

**Send this one first: it is the better fit by some distance.** His newsletter covers
"tech and business insights" in the outdoor industry and he runs a studio doing outdoor
recreation data work, so the engineering is the story he actually wants — and the
rec.gov shift below is genuine news to a category writer, not a pitch.

**VERIFY THE ADDRESS BEFORE SENDING.** `kyle@kylefrost.com` came from a search result,
not from a page read directly (hereandthere.club is blocked from the agent's network).
Check the about page at hereandthere.club/about, or just reply to any newsletter email —
Substack replies go straight to the author's inbox and are a warmer route anyway.

> **Subject:** Recreation.gov started shipping its own cancellation alerts — what it did to the category
>
> Hi Kyle,
>
> I read your "How to find campsite cancellations, for free" piece. I build a tool in
> this space and wanted to pass on something you may not have from the outside.
>
> Recreation.gov quietly launched its own Availability Alerts in July 2024 — free,
> official, capped at three. That reset the category: "we'll tell you when a site opens"
> is now a feature the booking system gives away. What it does not do, and structurally
> will not, is act for you. When a site frees up we put it in your cart automatically —
> measured detection-to-cart is about 12 seconds — so it is held while you are still
> reaching for your phone.
>
> The engineering has been the interesting half. Rec.gov rate-limits per egress IP, so
> capacity is bought with machines rather than concurrency; we recheck every 15 seconds
> across 8,000+ campgrounds on rec.gov and 13 state systems; and ReserveCalifornia needs
> a headful browser because it fingerprints headless Chromium.
>
> It's camphawk.app — live search is free and needs no account. Happy to give you a full
> account indefinitely if you want to poke at it, and happier still to hear what it does
> badly.
>
> No ask. Your piece is the most honest thing written about this category and I thought
> the rec.gov shift was worth sending your way.
>
> Tyler

---

#### 2. Taryn Eyton — Happiest Outdoors — `taryn@happiestoutdoors.ca`

Address is publicly listed on her media kit (happiestoutdoors.ca/media-kit), so it is
the right route.

**A MODERATE FIT, AND THE EMAIL SAYS SO IN ITS SECOND LINE.** She is based in Squamish,
BC and her audience skews Canadian; her post splits tools by which work in Canada, and
CampHawk is US-only. Leading with that caveat is not modesty — it is what stops her
spending five minutes discovering it herself and filing the sender as someone who did
not read the post. She is a serious outdoors author (two books, Leave No Trace Master
Educator), so the register is respectful and short.

> **Subject:** A US-only cancellation tool for your roundup — one thing none of the others do
>
> Hi Taryn,
>
> Your camping cancellation apps piece is the comparison I send people to. Fair warning
> before you read on: what I have built is US-only, so it belongs to the American half of
> that post and not the Canadian one.
>
> CampHawk (camphawk.app) does what Campflare and Campsite Notifier do — watches booked
> campgrounds, texts you the moment one is cancelled — and adds one thing none of them
> do: on Recreation.gov it puts the site into your cart automatically. Measured, that is
> about 12 seconds from the site opening to it being held, which is the difference
> between hearing about a cancellation and actually getting it.
>
> It also covers 13 state park systems beyond rec.gov — ReserveCalifornia, Ohio,
> Minnesota, Virginia and others — which matters more now that Recreation.gov ships its
> own free alerts and the state portals still do not.
>
> Live search is free and needs no account if you want to try it: camphawk.app/search.
> I will set you up with a full account for as long as you want one, and I would rather
> hear what is wrong with it than not.
>
> Either way, thank you for the roundup. It is the only one that says which tools work
> where.
>
> Tyler

---

**Rules for both:** one email each, no follow-up before two weeks and never more than
one; offer the free account unprompted; **never ask for a link** — ask to be considered,
or in Kyle's case ask for nothing at all. If they say no, or say nothing, that is the
end of it. A second chase costs more than the link is worth.

**Expect nothing.** Cold outreach to independent writers converts at maybe 10-20%. Two
emails is realistically one link or none. One editorial link is still worth more than
the whole of Tier 2.

---

## Tier 2 — directories (cheap, fast, referral value, mostly nofollow)

Do these in one sitting. **Verify each form's character limits on the page** — the
counts below are what the copy is written to, not a claim about what each site
enforces.

### AlternativeTo — highest value in this tier
Campnab and Campflare both have pages here and users genuinely browse "alternatives to
X". Add CampHawk, then list it as an alternative to Campnab, Campflare and Schnerp.
- Tagline: `Campsite cancellation alerts that cart the site for you`
- Use the ~250-char short description
- Tags: `camping`, `outdoors`, `notifications`, `travel`, `monitoring`
- Platforms: Web, iOS, Android *(Android is closed-testing — say Web + iOS if the
  Play listing is not public when you submit)*
- License: Commercial, Freemium (free search, paid watching)

### Product Hunt
Outbound links are **nofollow** — do this for the launch-day traffic, not for SEO. It
rewards a maker who is present and answering comments all day, so **only launch on a
day you can sit with it.** Do not launch the week of an App Store decision.
- Tagline (60 char limit): `Campsite cancellation alerts — and we cart it for you` (52)
- First comment: the long description above, plus the honest limitation — RC auto-hold
  is beta, auto-cart is Recreation.gov only. Saying what it can't do reads as
  confidence and pre-empts the top comment.

### SaaSHub, Slant, and the "Campnab alternative" comparison pages
Low effort, same copy. Slant works as a question format — answer
"What are the best campsite cancellation alert services?" with an honest entry that
names competitors fairly.

### Show HN
Only worth it with a technical story, and you have a genuinely good one: a
15-second poller sharded across machines because rate limits are per egress IP, and a
browser automation that carts a site in ~12 seconds. Title it as the engineering
problem, not the product. HN punishes marketing and rewards a build log.

---

## Tier 3 — communities (a person, not a campaign)

r/CampingandHiking, r/GreatOutdoors, the park-specific subs (r/Yosemite, r/ZionNP)
and the park Facebook groups all have self-promo rules, and **a new account dropping a
paid-tool link is how CampHawk gets banned from exactly the places its buyers are.**
That door opens once.

The only version of this that works: participate as someone who knows a lot about
campsite booking, answer the "how do I get a sold-out site" questions properly and for
free — including recommending the free tools when they genuinely fit — and mention
your own thing only when it is the direct answer and you disclose that you built it.

**Expect this to take months and to produce a handful of users.** Its real value is
that a good answer that gets upvoted becomes a permanent, ranking, linked page — which
is the only item in Tier 3 that touches the authority constraint.

---

## What to measure

**Not clicks, and not for six weeks.** Directory and outreach wins show up as referral
sessions in Vercel Analytics almost immediately, and as **average position on
`/campground/*`** in Search Console much later. Position is the number that says
whether authority moved; clicks are downstream of it. The same reading rule is written
into the header of `src/lib/seo.ts` and the reasoning is there.
