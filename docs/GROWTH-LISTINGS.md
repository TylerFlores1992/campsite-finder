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

**The differentiator is auto-cart, not price.** The floor is free — Campflare covers
10,000+ campgrounds at $0 — so "cheaper than Campnab" is not a wedge and should not
appear anywhere. What no competitor does is *hold the site for you*: measured
detection-to-cart is ~12 seconds, against Campsite Tonight's documented "up to every
minute".

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
| Happiest Outdoors | "The Best Camping Cancellation Apps: Campnab vs. Schnerp" | US-only tool they don't cover; auto-cart is a category none of their picks have |
| Outdoorithm | "Free Campsite Cancellation Alerts — CampNab & CampFlare Alternative" | They rank for the comparison query; we're a missing entry |
| Here & There (Substack) | "How to find campsite cancellations, for free" | Newsletter, replies to email, small enough to answer |
| Hipcamp Journal | partnered with Campflare in 2023 | Long shot — they have an incumbent — but the auto-cart angle is genuinely new |

**Template — keep it short, lead with the thing they don't have, offer the demo:**

> Subject: a cancellation tool that carts the site for you — for your <post title> roundup
>
> Hi <name>,
>
> I read your <post title> piece — the <specific detail from it> point is the bit most
> of these comparisons miss.
>
> I built CampHawk (camphawk.app), and there's one thing in it none of the tools you
> covered do: when a site opens on Recreation.gov we don't just alert you, we add it
> to your cart automatically. Measured detection-to-cart is about 12 seconds, so it's
> held while you're still reaching for your phone. Everything else — 15-second
> rechecks, SMS/email/push, flexible date windows across 8,000+ campgrounds on
> Recreation.gov and 13 state systems — is table stakes by comparison.
>
> Live search is free and needs no account if you want to poke at it:
> camphawk.app/search. Happy to set you up with a free account for as long as you want
> one, and happy to answer anything — including what it doesn't do well.
>
> Either way, thanks for the roundup. It's the most useful one out there.
>
> <name>

**Rules:** one email, no follow-up before two weeks and never more than one; offer a
free account unprompted; never ask for a link directly — ask to be considered. If they
say no, that is the end of it.

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
