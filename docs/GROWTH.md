# Growth — where the marketing side actually stands

*Opened 2026-08-25, numbers re-read 2026-09-03. This is the marketing lane's memory, kept
out of `CLAUDE.md` because that file is ~6,800 lines about the poller and the RC flow and
this is a different subject with a different reader.*

**Companion file: `docs/GROWTH-LISTINGS.md`** — the outreach packet (positioning, the two
ready-to-send emails with addresses, directory copy, and the rules for sending them).

---

## 1. The numbers, read 2026-09-03

| | 2026-08-25 | 2026-09-03 |
|---|---|---|
| `users` rows | 35 | **43** |
| — minus 5 seed/test rows (`test…`, `web…`, 2026-06-30) | 30 | **38** |
| — minus the 15 Play testers of Aug 8-9, none of whom ever made a watch | 15 | **23** |
| `is_beta` (entitled, unbilled) | 9 | **10** |
| Active watches | 13 | **15**, across 8 users |
| — ReserveCalifornia / Recreation.gov | 12 / 1 | **10 / 5** |
| Recurring cost | $79.69/mo | **$79.69/mo** (unchanged) |
| One-time sunk | ~$338 | **$337** |

**Subscriptions are the part that changed, and the change is NOT clean.**

    2026-08-25   active   base      grandfathered   x2
                 active   autocart                  x1
    2026-09-03   active   base      grandfathered   x1
                 trialing autocart                  x2
                 canceled base      grandfathered   x1
                 canceled autocart                  x1

- **Confirmed billing revenue is ONE base subscription: $2.50/mo** against $79.69/mo of
  cost. The two `trialing` autocart rows are not revenue yet; if both convert they are
  $20/mo, which still does not cover the bill.
- **DO NOT WRITE THIS UP AS CHURN. I cannot tell churn from a data correction, and neither
  can anyone reading the table.** Between the two readings master shipped
  **"A trial was recorded as active" (#251)** and **"Reconcile subscriptions against
  Stripe, and refuse to guess" (#253)**. So a row that read `active` on 08-25 and reads
  `canceled` now may be a real cancellation, or may be the reconcile correcting a status
  that was never true. Stripe's own dashboard is the only thing that settles it.
- **AND IT RETROSPECTIVELY WEAKENS A CLAIM I MADE ON 08-25.** I reported "3 paying, zero
  churn ever, so conversion is not the problem — everyone who reaches a watch pays." That
  rested on reading `subscriptions.status`, which #251 says was capable of reporting a
  trial as active. The optimistic half of that sentence is unsupported until somebody
  reconciles against Stripe. **The pessimistic half — that almost nobody arrives at all —
  is untouched**, because it rests on `users` and Search Console rather than on Stripe.

**Break-even, at today's cost:** ~32 subscribers at $2.50, or ~8 at $10.

---

## 2. Search Console — the baseline, and how to read it

Trailing 28 days to **2026-08-25** (not re-read since; the owner has the console):

    impressions 14.9K   clicks 46   CTR 0.3%   average position 49.9

**The position is the whole story and it is the number that was missing from my first
question.** At position ~50 an expected CTR is 0.2-0.5%, so 0.3% is exactly what the
snippet should earn — the pages were not being passed over, they were not being seen.

**The reading rule needs POSITION as its first term. It is three-way:**

| impressions | CTR | position | what it means |
|---|---|---|---|
| yes | poor | **> 20** | a RANKING problem. The snippet is irrelevant; nobody reaches it. **This is where we were.** |
| yes | poor | **< 10** | a SNIPPET problem. Now the title and description are the lever. |
| few | — | any | not matching the query at all: content or indexing. |

The same rule, with the evidence that produced it, is in the header of `src/lib/seo.ts`.

**There IS a beachhead, and it is the most useful thing in the dataset.** Eight pages sat
in the top 20 and four in the top 10:

    /campground/10362407  7.5   Sítʼ Yá Hítʼ Cabin, Juneau AK (Forest Service)
    /campground/rc-889    8.6   Clear Lake SP Cabins — Cabin Colony
    /campground/mn-1050   8.9   Afton State Park — Wall Tent
    /campground/oh-685   10.1   Grand Lake St. Marys
    /terms               11.9
    /campground/il-232   15.6   Illini SP — Pine Glen Youth Group
    /                    17.7   homepage
    /campground/mn-939   19.6   Itasca — Elk Lake Group Camp

Meanwhile **every query with real volume sat at 44-87** ("campgrounds with cabins" 71,
"camping in georgia" 67.9, "ohiopyle camping" 69.1). And **23 of the top 25 queries by
impressions contain "camping", "campground" or "campsite"** — every one a DISCOVERY query.

**THE AXIS IS OBSCURITY, NOT SOURCE.** An earlier draft of this said "state portals win,
recreation.gov loses". Alaska has 167 rec.gov cabins and one of them ranks 7.5, because
nobody has ever written about a Forest Service cabin outside Juneau. Minnesota publishes
one page for Afton State Park; we publish one for its wall tent. That is the entire edge,
and it is why the national-park hub is aimed at the weakest segment we have.

---

## 3. A bet was made and falsified inside a day — do not re-run it

**THE BET.** "`<name> availability` is a query recreation.gov owns; `<name> cancellations`
is one it has nothing to say about and is literally this product." Every campground title,
every state title and both h1s were retargeted onto "Cancellations".

**WHAT KILLED IT.** A Search Console query filter for `cancel` returns **NO DATA** across
1,000 rows and 28 days — and 23 of the top 25 queries carry a camping/campground token. The
retarget had removed the highest-frequency word in the real demand from 6,934 titles to
chase a phrasing with no measurable demand.

**REVERTED.** Titles, descriptions, state titles and the state h1 are all back. The guards
in `src/lib/seo-retarget.test.mts` are **inverted** — a test now fails if anyone reinstates
"Cancellations" — and they name the evidence and where to check before overriding.

**WHAT SURVIVED, because it earns its place independently:** the ~200-word
`CampgroundOpenings` section on every campground page. The highest-impression page on the
site, `/campground/tnsc-TN-71` (508 impressions at position 10.3), has **zero photos and a
zero-character description**; so does `ra-PA-880211`. Those pages are nearly empty and the
section is real content on them.

**`tnsc-TN-71` IS NOT AN OPPORTUNITY, AND IT LOOKS LIKE ONE.** 508 impressions at position
10.3 with **zero** clicks. All four of its queries are navigational — "clinch river valley
state park kyles ford" (486), "…state park" (8), "…state park tn" (2) — people looking for
the park itself, who click Tennessee's official page. We are the worst-looking result on
page one, with no photo and no description. **Unwinnable; do not spend a session on it.**

---

## 3a. PROBLEM-INTENT PAGES ARE NOT WHAT WAS FALSIFIED (2026-09-04)

The owner's ask: *"Target the problem, not the campground name. Nobody types 'Leo Carrillo SP
Canyon Campground'. They type 'how to get a campsite that's sold out', 'campsite cancellation
alert app', 'Yosemite campground fully booked what now'."*

**Section 3 above reads like a refusal of that and it is not one.** They are different pages
answering different queries, and only one of them has been tested:

| | what was tried | what the evidence was about |
|---|---|---|
| **Falsified 08-25** | the TITLES of 6,934 existing facility pages retargeted onto "Cancellations" | which queries *those pages* surface against — `<campground> cancellations` |
| **Untested** | a dedicated page for `campsite cancellation alert app` / `campground fully booked what now` | a different query class, on a page that did not exist |

`src/lib/seo.ts`'s own header labels reading #1 as *"weaker than 'nobody searches this'"*, and
reading #2 — 23 of the top 25 queries carry a camping token — is a statement about **who
currently arrives**, which is a function of what we currently rank for. Neither says a
problem-intent page cannot work, and **nothing in this repo has tested one.**

**SHIPPED: TWO PAGES, NOT "a few dozen".** `/sold-out-campsite` (the guide) and
`/campsite-cancellation-alerts` (the category page). Two that are worth reading can be judged;
forty near-identical ones are the doorway pattern, and this site has already learned once what
thin templating buys against a query class with no demonstrated demand. If these move, the next
ones write themselves.

**THE HONEST CEILING IS UNCHANGED AND IS SECTION 6's:** nothing external links to this domain,
so expect impressions at ~position 50 rather than clicks, for months. They are worth having
anyway — they are the pages a human would link to, they are where the statistic below lives,
and they convert whoever does land. **Do not read a flat line as a content problem and rewrite
them; the constraint is links.**

**A MEASURED STATISTIC NOBODY ELSE HAS** (`src/lib/openings-stat.ts`). Every competitor asserts
that cancellations happen; none says how often, because saying so needs somebody to have
watched sold-out campgrounds around the clock and counted. From `availability_observations`,
2026-07-22 → 2026-09-04: **1,100 openings across 125,118 hourly checks of 502 hard-to-book
campgrounds — 0.9%** — counting only TRANSITIONS (a stay that had been fully booked becoming
bookable), never a stay that was simply never sold out. It is the one thing on those pages that
cannot be copied from a blog post, and it is checkable — the query is in `lib/watch-outlook`'s
header.

**AND THE SAME QUERY KILLED THE FOLK WISDOM IT WAS RUN TO CONFIRM.** The ask that produced it
was to tell new watchers that cancellations are unlikely until about two weeks out. On the only
well-powered windows we have, a booked-out stay **6-8 weeks out opened on MORE checks than one
2-3 weeks out** (1.04-1.16% against 0.67%, 418 and 636 events over 502 campgrounds). The
real-watch population appears to show the cliff spectacularly — 26 openings in 2,666 checks
inside 14 days against 1 in 5,503 beyond it — until you check where the events came from: **32
of those 34 are ONE campground.** Do not put a lead-time cliff in copy; a guard in
`src/lib/watch-outlook.test.mts` fails if anyone does.

## 4. What shipped (all on master, `53f1476`)

- **The reverted metadata**, plus the inverted guards described above.
- **`CampgroundOpenings`** — server-rendered, below the availability grid (keyword prose
  above the useful widget is the doorway-page pattern).
- **72 new pages: 3 accommodation-type hubs + 69 per-state children.**
  `/camping/cabins` (34 states), `/camping/group-camping` (31), `/camping/yurts` (4: VA,
  UT, OR, CA). Live and verified 2026-09-03; sitemap is **7,066 URLs**, up from 6,987.
  Inventory today: cabin 1,186 · group 1,412 · yurt 50.
  - Chosen because they are the **only** theme with BOTH demonstrated demand (five cabin
    queries in the top 25) and demonstrated ability to rank (three page-one pages are
    cabins or wall tents).
  - **Tent and RV are deliberately excluded and a test pins that** — 4,304 and 3,486
    campgrounds, so the pages would near-duplicate the state pages, and the whole thesis
    is specificity.
  - **Site types were checked for the `showers` failure before building on them.** That
    facet looked equally good and turned out recreation.gov-only (197 rec.gov rows, zero
    elsewhere), which is why it was pulled from Explore on 2026-08-15. Cabin, group and
    yurt each appear across 8-11 of the 14 sources, and a real-DB test enforces the
    multi-source rule so the next facet cannot repeat it.
- **`/camping/hardest-to-book`** — 28 famous national-park campgrounds. **Flagged
  unvalidated on purpose:** its own editorial query is untested, and its 28 leaves are the
  segment we rank 70+ for. Keep it; do not build more like it.
- **`docs/GROWTH-LISTINGS.md`** — the outreach packet.

---

## 5. The competitive reality, which is harsher than the first read

- **Recreation.gov shipped its own free Availability Alerts in July 2024** — official,
  every reservable rec.gov location, 3 active alerts per user. So on rec.gov, "we will tell
  you when a site frees up" is a feature the booking system gives away, and pitching it
  there competes with the source of truth.
- **The free floor is lower than it looks.** Campflare: free, 10,000+ campgrounds.
  Outdoorithm: free tier, 44 reservation systems, apps on both stores, paid at
  $12.99-$19/mo. Also in the space: Campnab, Schnerp, Wandering Labs, Campsite Notifier,
  PermitSnag, Camping Alert, Outdoor Status.
- **So "cheaper than Campnab" is not a wedge and must not appear in any copy.**
- **Two things survive it, and they are what the positioning leads with:**
  1. **Auto-cart.** Nothing else holds the site for you. Measured detection-to-cart is
     ~12 seconds (verified against `autocart_jobs` on 2026-08-25: 38 successful carts, real
     latencies 9/10/10/10/11/12/13s). Recreation.gov will never build this — it would be
     carting against itself.
  2. **The 13 non-rec.gov systems**, ReserveCalifornia above all. Rec.gov's alerts do not
     cover them and no state portal offers its own.
- **The "our customers are all on RC" argument has WEAKENED and should be re-checked before
  being used.** It was 12 of 13 watches on 08-25; it is **10 of 15** now, with rec.gov up
  from 1 to 5.

---

## 6. Where this leaves the strategy

**The binding constraint is domain authority, and it is verified rather than assumed.**
Every search result for "CampHawk" is camphawk.app itself — no review, no directory entry,
no forum thread, nothing links here. Campflare has a Hipcamp press release and an
alternativeto.net listing. A two-month-old domain with zero external links ranks ~50 for
anything contested, and no amount of on-page work changes that.

**Therefore, in order:**

1. **Links and mentions.** The only lever that touches the constraint. Tier 1 of the packet
   is **two** genuine independent publishers (Happiest Outdoors, Here & There) — the
   "best cancellation app" SERP is owned almost entirely by the products themselves, which
   is a limit on the strategy rather than a to-do list to pad. Directory links are mostly
   **nofollow**; their value is referral traffic, not authority.
2. **The SEO work already shipped**, judged on **average position on `/campground/*`**, not
   on clicks, and not for 6-10 weeks.
3. **Paid ads: no.** Buying users at a loss into a $2.50 product with no measured LTV.

**AND THE HONEST TOP LINE: SEO CANNOT BE THE NEAR-TERM ACQUISITION CHANNEL.** The best
query class here has 15-25 impressions a month and four page-one rankings produce ~1.6
clicks a day. Executed perfectly this is maybe 10-40 clicks/day over months. It compounds
and it costs only agent time, which is why it is worth doing — but users this quarter come
from somewhere else.

---

## 7. Open — and what needs the owner rather than an agent

- **Were the two emails ever sent?** Unknown as of 2026-09-03. They are written, with
  addresses, in `GROWTH-LISTINGS.md`. **Verify `kyle@kylefrost.com` before sending** — it
  came from a search result, not a page that could be opened (both target domains are
  blocked by this environment's egress proxy). Replying to a Substack email is a warmer
  route anyway.
- **Reconcile the subscription table against Stripe** and settle whether §1's two
  `canceled` rows are real cancellations or #253 correcting bad state. Everything I said on
  08-25 about conversion depends on it.
- **A fresh Search Console reading.** The baseline is 2026-08-25 and the 72 pages have had
  9 days to be crawled. Look at **average position on `/campground/*`** and at whether any
  of the new `/camping/cabins/*` pages have impressions at all.
- **`PR #191` is open and unmerged** — 36 lines in `GROWTH-LISTINGS.md` saying the outreach
  need not wait for the apps. Harmless either way.
- **NOT STARTED, deliberately:** the directory submissions (they need accounts created as
  the owner), and any community posting (a new account dropping a paid-tool link is how
  CampHawk gets banned from the places its buyers are; that door opens once).

## 8. Things not to re-derive

- The cancellation retarget. Falsified; the guards will stop you; §3 has the evidence.
- `tnsc-TN-71`'s 508 impressions. Navigational, unwinnable.
- Whether `showers` or `pets_allowed` can carry a page. No — single-source and a default
  respectively; see CLAUDE.md's filters entry.
- Tent/RV hubs. Too broad; a test pins the exclusion.
