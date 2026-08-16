# Side-lane notes — `claude/side-lane-setup-f7bpe2` (2026-08-15)

For the main lane to fold into `CLAUDE.md` / `docs/CONTEXT.md`. Inference is labelled as
inference. Everything else was measured, and says how.

---

## 1. A watch's `site_type` IS NOT READ BY THE POLLER — selecting RV does nothing

Owner asked whether choosing the RV site type auto-mutes sites that don't match. It does
not, and the reason is bigger than the question: **our poller never looks at the column.**

Evidence:

- `grep -rn "site_type\|siteType" worker/` → **zero hits**.
- `loadWatches` (`worker/poller.ts:585-595`) does not even SELECT `site_type`.
- The column is written by `/api/watches` POST and read by exactly one consumer:
  Campflare, as `campsite_kinds` (`route.ts:241`), and only for **non-flex rec.gov**
  watches when `CAMPFLARE_API_KEY` is set.
- `CAMPFLARE_API_KEY` is **absent** from this session's env (`printenv | grep -c CAMPFLARE`
  → 0).

So a watch created with RV selected alerts on tent sites too. Muting is a separate
mechanism (`muted_site_ids`, an explicit exclusion list), and nothing writes to it
automatically.

*Inference:* the missing Campflare key here is good evidence it is unset in production
(this session carries the live keys per CLAUDE.md), but Vercel's env is authoritative and
I could not read it. Either way it does not change the finding for our own poller.

**Not fixed — `worker/` is the main lane's.** Worth deciding whether `site_type` should
filter detection or be dropped from the create form; today it is a control that silently
does nothing.

## 2. Amenity coverage, measured — and there is no RV water hookup at all

Live catalog, 2026-08-15, `unnest(campgrounds.amenities)` grouped with source:

| amenity | campgrounds | sources |
|---|---|---|
| `drinking water` | 2,153 | ridb only |
| `electric hookup` | 1,526 | 8 sources |
| `sewer hookup` | **79** | ridb only |
| `water hookup` | **0 — value does not exist** | — |

FINAL STATE after the owner's call on 2026-08-15: the chip keeps its **"Hookups"**
label and stays in the flat Must-have row (it was briefly moved under the RV site type
and relabelled "Electric"; that was reverted). **Drinking water was removed entirely** —
field, URL param and amenity mapping — because its amenity is rec.gov-only, so ticking it
narrowed by SOURCE while appearing to narrow by amenity. Must-have is now
Pets OK / Hookups / Showers.

Consequences, and why no water or sewer chip exists:

- There is **no RV water hookup in the data**. `drinking water` is a campground-level
  "there is potable water here" — a different claim.
- Sewer is 1% of the catalog from one source, and amenities are AND-ed
  (`p_amenities <@ c.amenities`), so Electric+Sewer could never exceed 79 while silently
  excluding every state portal.
- All of these are **campground-level**, not site-level: "Electric" means the campground
  has some electric sites, not that the site you are alerted about has one.

`hasElectric()` in `sources/ridb/transform.ts` does compute this per CAMPSITE, so a
site-level filter is possible in principle — it just isn't what the search RPC exposes.

## 3. "ReserveCaliforniacarts" IS REAL — and the cause is SWC, not the source

**I reported this as "not in master". That was WRONG**, and the owner's screenshot of the
live New watch screen is what disproved it. Correction and cause below; the mistake is
left visible because the reasoning that produced it is the interesting part.

The source has ALWAYS had the space, in every one of the 52 commits visible here:

```jsx
{providerLabel(campgroundSource, campgroundId ?? undefined)} carts are tied to a browser
session and wouldn&apos;t follow you to your phone. You&apos;ll still get the alert.
```

`cat -A` confirms a real 0x20. And yet **both the deployed bundle and my own local build**
emit `providerLabel($,N??void 0),"carts are tied…"` — no leading space.

### The rule, measured through real `next build` runs

**An HTML entity anywhere in a JSX text node makes SWC drop that node's LEADING
whitespace.** Labelled cases, compiled and read out of `.next/static/chunks`:

| source | emitted |
|---|---|
| `{X()} q6none…` + literal apostrophe on line 2 | `"ZED"," q6none…"` ✅ |
| `{X()} q1lead has wouldn&apos;t on this line` | `"ZED","q1lead…"` ❌ |
| `{X()} q3amp…` + `&amp;` on line 2 | `"ZED","q3amp…"` ❌ |
| `{X()} q4real…` + `&#39;` on line 2 | `"ZED","q4real…"` ❌ |
| `{X()} q5rsquo…` + `&rsquo;` on line 2 | `"ZED","q5rsquo…"` ❌ |

So: any entity, **named or numeric**, **anywhere in the node** — including on a *later
line* than the space being lost. A literal apostrophe is safe. It is **asymmetric**:
`q2trail text with wouldn&apos;t entity {X()}` kept its TRAILING space, so only the
leading edge is affected.

### Why the checker said clean

It was ported from **Babel's** `cleanJSXElementLiteralChild`, and Next compiles with
**SWC**. Babel preserves the first line's leading space; SWC does not when an entity is
present. **Agreeing with the wrong reference implementation is worse than having no
checker, because it produces a confident green** — which is exactly what it did, over a
bug visible on the live site.

Two further things the first version got wrong, both now fixed:

- Its "there must be a NEWLINE between the two children" condition. That is right for the
  ordinary case and **wrong for this one**: here the author's space is on the *same line*
  and the entity two lines down removes it. The newline requirement is now waived when
  the entity rule demonstrably ate a typed space.
- It only knew the trigger from a spec. Every rule in it is now checked against real
  build output.

### Four real bugs, all now fixed

| | rendered |
|---|---|
| `NewWatch.tsx:456` | `ReserveCaliforniacarts are tied…` |
| `NewWatch.tsx:409` | `3nights doesn't fit in a 5-night window` |
| `HoldConfirm.tsx:40` | `Carpinteria SB— we'll grab it at…` |
| `AdminTabs.tsx:1061` | `…is refusedof a release.` |

Fixed by moving the space into a literal (`{' '}`). **Verified in the compiled artifact**,
not just by the checker: the chunk now reads
`providerLabel($,N??void 0)," ","carts are tied…"`.

### It caught a regression I introduced while fixing it

Adding an explanatory comment *between* `runner</b>,` and `which asks` split one text node
into two and dropped THAT space. The checker flagged it immediately. The comment now sits
outside the `<p>`.

### Consequence worth acting on

This codebase uses `&apos;`, `&rsquo;`, `&ldquo;`, `&mdash;` and `&amp;` heavily —
`react/no-unescaped-entities` pushes people towards them. **Every one of those text nodes
is a place this can happen**, so `npm run jsx-spacing` is worth having in `npm run verify`.
Not added here: that recipe is shared with the main lane's CI.

## 4. FIVE SCREENSHOT PRESETS RENDERED NOTHING AND REPORTED SUCCESS — FIXED 2026-08-15

`npx tsx scripts/screenshot-component.mts admin-health` logs
`page error: Cannot read properties of undefined (reading 'level')`.

**Verified pre-existing** by `git stash`-ing all side-lane work and re-running against the
committed baseline — identical error. Not caused by this branch.

It matters because CLAUDE.md points at that preset as the check for the colour-blind
status marks ("renders the tab with a warn and a fail in view").

**It was worse than "throws part-way".** The throw is `overallStatus(data)` reading
`data.shardCov.level` at `AdminTabs.tsx:206`, and that call is the FIRST thing the
component does — so React unmounted the whole tree. **The saved PNG is a plain cream
rectangle with nothing on it**, confirmed by reading the image back, not by inferring from
the log. So the named verification for the one accessibility property the owner cannot
check by eye was producing an empty file, and exiting 0 while it did.

**Three fields were missing from the fixture**, all required by `AdminData`: `shardCov`,
`capacity`, and the four `r_*` fields on `smsDelivery` (the 7-day window `smsLevel` is
actually judged on — the 30-day figures next to them are history).

### The instrument, not the fixture, is the finding

`page.on('pageerror')` only `console.error`d. The script then saved the PNG and
**exited 0**. So every preset in the repo could throw and still read as a pass.

**Measured, by sweeping all 47 presets** (`exit` code and page-error count per preset):

| | count | behaviour |
|---|---|---|
| Rendered clean | 35 | exit 0, no page error |
| **Threw at render, exit 0** | **5** | `admin-health`, `ch-admin`, `ch-admin-broken`, `ch-costs`, `ch-costs-edit` |
| Failed at build, exit 1 | 7 | see below — these were already honest |

The five silent ones were two families: `.level` (missing `shardCov`/`capacity` — three
presets feeding `AdminTabs`) and `.sms` (missing `lifetimeUsage` — two feeding
`CostsPanel`). **Re-swept after the fix: all 40 live presets exit 0.** The harness now
throws on any page error, verified the way this repo requires — the exact bug restored and
watched to `exit=1`, then the fix restored and watched to `exit=0`.

The repaired shots were also read back rather than trusted: `admin-health` renders all
three status shapes (round tick / triangle / round cross) each with its word, which is the
property the preset exists to show; `ch-admin-broken` renders "6 things need attention"
naming the stale poller, the failing canary, the empty sync and the three added here. A
green exit on a fixture one has just invented is weak evidence on its own.

Console errors are deliberately NOT collected — React logs recoverable warnings through
`console.error`, and failing on those would make the harness cry wolf, which is the
failure being fixed rather than a second copy of it.

### Why no build could ever have caught this

**A preset's `entry` is a template STRING**, compiled by esbuild at run time. A prop-type
change to `AdminTabs` cannot break a preset at typecheck or at `next build` — the fixture
just drifts, and only a browser finds out. `npm run typecheck` passes with all five
broken. That is the structural reason this survived: the guard has to be the run itself,
which is why the exit code had to change.

Same string-ness bites the author: **an entry cannot contain a backtick or a bare `${`**,
even inside a `//` comment, because either ends the literal. Hit while writing the fix —
a comment quoting a field name in backticks closed the entry and the parse error surfaced
on an unrelated later line. Documented on the `Preset` interface now.

### 7 presets point at components deleted in the front-end swap

`search-bar`, `favorites-panel`, `manage-watch`, `ch-home`, `v2-available`, `v2-mobile`,
`avail-usedirect` fail at esbuild with `Could not resolve` for `@/components/SearchBar`,
`FavoritesPanel`, `ManageWatch`, `@/app/v2/page`, `v2/AvailableNow`,
`AvailabilityCalendar`. CLAUDE.md records those deletions ("the old pages and 14 orphaned
components are deleted; `/v2` no longer exists") — the presets were never updated with
them.

**Left alone deliberately.** They already fail loudly with a message that names the
missing module, so they are not lying, and every one has a live successor already covered
by another preset (`Explore` for `AvailableNow`, `v2/ManageWatch` for `ManageWatch`).
Deleting seven presets is a separate judgement call and would have muddied a change whose
point is "make the instrument honest". **Recommend removing them**; not done here.

*Inference, flagged as such:* nothing runs these presets in CI, so the 7 dead ones cost
only a person's time when they try one. I did not add a CI sweep — 47 Chromium launches is
too heavy, and `verify` is the main lane's recipe.

## 5. THE TEST SUITE RACES ITSELF IN CI — MEASURED, and it needs no second lane

**This started as a prediction about two lanes colliding and turned out to be worse: a
single PR collides with itself.** Evidence, from the Actions API on 2026-08-15:

| run | event | head_sha | conclusion |
|---|---|---|---|
| 31865582126 | `pull_request` | `07fa9211` | **failure** |
| 31865560005 | `push` | `07fa9211` | **success** |

**Same commit, same code, 31 seconds apart, opposite results.** Neither is mine — that is
the main lane's branch (`claude/camphawk-sms-test-update-s3cash`).

Why the concurrency group does not stop it: `concurrency: verify-${{ github.ref }}`, and
a `push` run has `github.ref = refs/heads/<branch>` while the `pull_request` run has
`refs/pull/<n>/merge`. **Different groups, so they never cancel each other** — they run
side by side against the one production database. (The group does work for its intended
case; run 31865526920 shows a `cancelled` push run.)

The collision mechanism is a **fixed fixture id plus a prefix DELETE**. `ridb-photos.test.mts`:

```
const ID = 'ridb-test-photos-fixture';
const cleanup = () => mutate(`DELETE FROM campgrounds WHERE id LIKE 'ridb-test-photos-%'`);
```

Two runs share that exact row, and either one's `cleanup()` deletes the other's fixture
mid-test. `--test-concurrency=1` cannot help: it serializes files *within* a run.

Reproduced locally on this branch while the main lane's CI was running: full suite gave
**1 failure**, then **2 failures** (different tests), while `ridb-photos.test.mts` **run
alone passes 3/3**. Both failures were in that suite:

```
not ok 440 - an EMPTY array still overwrites — a real "no media" answer is not the same as no answer
not ok 441 - a NEW row inserts its photos normally
```

**This is not confined to the two suites the side-lane brief names** (`sync-claim`,
`shard-lease`). Any suite with a fixed fixture id has the property, and `ridb-photos` is
one.

Worth fixing, because a gate that fails ~half the time on unchanged code is one people
learn to ignore — the reason `lint` is deliberately kept out of `verify` in the first
place. Cheapest fixes, in order: make fixture ids unique per run (a run id or random
suffix, so `cleanup()` cannot reach another run's rows), or widen the concurrency group
to the commit rather than the ref so push and PR runs of one SHA serialize.

**Left alone — `.github/workflows/` and the worker test fixtures are the main lane's.**

## 5b. CI also runs the production-DB suite on every `claude/**` push

`.github/workflows/verify.yml` triggers on `master` **and `'claude/**'`**, and
`npm run verify` is typecheck → `npm test` → build with the real Supabase secrets.

Its `concurrency` group is `verify-${{ github.ref }}` — keyed on the **ref**, so it
cancels a superseded run *of the same branch* and does nothing across branches. The
workflow's own comment records why `--test-concurrency=1` was needed: parallel runs of an
unchanged tree gave "329 pass, then 6 fail, then 3 fail, always in the suites asserting a
row did NOT change while a sibling file was changing it." That serialization is *within* a
run. Two runs — one per lane — are the case it does not cover.

So the thing to serialize between lanes is **branch pushes**, not only merges. Also note a
single PR costs two full prod-DB runs if `npm run verify` is also run locally.

Two lanes pushing at once is therefore a *second* way into the same collision, on top of
the self-race in 5. A single PR also costs two full production-DB runs if `npm run verify`
is run locally as well.

## 6. Account shape, measured 2026-08-15

- 26 real accounts (`id LIKE 'user\_%'`), plus **5 hand-inserted test rows**.
- **Only 2 have a `subscriptions` row at all** (both `active`, `tier='base'`,
  `grandfathered=true`). **8 carry `is_beta`.**
- So most access is granted by the beta flag, and any admin UI keyed on Stripe alone
  renders the owner's own account — 6 watches, 530 alerts — as "no plan".
- The admin account was at **exactly 6 of 6 live watches**, i.e. the cap was binding when
  the exemption was asked for.
- Alert receipts for the admin account: sms 194 sent / 104 delivered / 13 dropped, which
  matches the 08-05 filtering episode plus "104/104 since 08-06" already in CLAUDE.md.

## 7. There is no analytics table

Full table list checked. Nothing records page views or sessions. The nearest activity
signal is `users.updated_at`, which `syncUser` bumps on every authenticated page load —
which is exactly what makes it useless as "last settings change" and usable as **last
seen**. The new admin UI labels it that way, in both the list footnote and the detail row,
because CLAUDE.md records it being read the other way round once already.

## 8. This container's clone is SHALLOW

`git rev-parse --is-shallow-repository` → true, 52 commits.

- `git diff origin/master...HEAD` (three-dot) dies with **`fatal: no merge base`**. Use
  two-dot.
- `git fetch origin master` reports `+ a58fe0c...0ab8bc5 (forced update)`. That is the
  shallow ref catching up, **not** a force-push to master.

Same family as the shallow-clone trap CLAUDE.md already records for
`autocart.bot_version`.

## 9. Doc drift: CLAUDE.md's route list is missing two routes

CLAUDE.md's front-end section lists `/`, `/search`, `/watches`, `/new`, `/settings`,
`/campground/<id>`, `/manage/<token>`. `docs/CONTEXT.md`'s route table also has
**`/pricing`** and **`/welcome`**, both of which exist and are in `isPublicRoute`.
CONTEXT.md is the correct one.

---

## What shipped on this branch

| | |
|---|---|
| `825faca` | Beta list scrolls at 10 + search. Fixed a latent empty state that would have read "No all testers." |
| `eff3c13` | `npm run jsx-spacing` — the checker above. Nothing to fix; app is clean. |
| `7474c8d` | Desktop header 52→70px, mark 28→38px. Phone header untouched and verified so. |
| `4dfe490` | RV → Hookups → Electric (**superseded by `43a9fea`**). |
| `b8aecdc` | Admin exempt from the 6-watch cap. `WATCH_LIMIT` unchanged. |
| `e4a3207` | Admin Users box + `/admin/users/<id>`. |
| `43a9fea` | Hookups label kept in Must-have; **Drinking water removed**. |
| `2ac913e` | **The SWC entity spacing fix** — four user-visible strings. |

**Capacity note on `b8aecdc`:** `lib/limits.ts` describes `WATCH_LIMIT` as the only
user-facing number bounding how many rec.gov campground-months one account can force onto
a shard. The constant is untouched and only the admin is exempt, but enough admin watches
will push `poller.capacity` in `/api/health/status` to warn and then fail, and past the
ceiling everything just gets slower. That gauge is the one to read after adding several.

---

## Handover — open items after 2026-08-15

> **SUPERSEDED — every item below is now closed. See "Handover — 2026-08-16" at the END of
> this file for current state.** Kept because the reasoning for each is still worth reading,
> and because a handover deleted once resolved leaves no record that it was ever open.

Everything above is merged (PR #45) and live. What is NOT done:

1. **`site_type` is inert in the poller** (finding 1). This is the "new watch filters"
   issue and it is the main lane's to decide. A user picks RV and gets alerted for tent
   sites; the control looks like it works.
2. **`verify.yml` races itself** (finding 5). A `push` run and a `pull_request` run of the
   same commit have different `github.ref`, so the concurrency group never cancels either
   and both hit the production DB. Fixture ids are fixed strings with prefix `DELETE`s.
3. ~~**`admin-health` screenshot preset throws**~~ **DONE 2026-08-15** — see finding 4.
   Five presets were rendering blank and exiting 0; the fixtures are repaired and the
   harness now fails on a page error. **Still open from that work:** the 7 presets
   pointing at components deleted in the front-end swap. They fail loudly, so they are
   not dangerous, but they can never run and should probably be deleted.
4. **PR #56 (park watches) is open and needs review** — see section 11, including four
   things it does not verify.
5. **`npm run jsx-spacing` is not in `npm run verify`.** Given that the SWC entity trap
   (finding 3) silently broke four user-visible strings and this codebase escapes entities
   everywhere, it is worth adding — one line, and the recipe is the main lane's.
5. **`verify.yml` racing itself is FIXED** — the concurrency group is now
   `verify-${{ github.head_ref || github.ref_name }}`, so a branch's push run and its PR
   run share a group and cancel. Finding 5 below describes the race as live; read it as
   history. **What it does not fix** is the underlying fragility it documents: fixed
   fixture ids with prefix `DELETE`s against ONE production database, so two branches
   pushing at once still collide. That is why `docs/LANES.md` serializes `npm test`
   between lanes rather than treating it as ceremony.


---

# Second session, 2026-08-15 — campground names, park watches

## 10. Campground names and divisions (PR #53, MERGED)

Measured on the live catalog:

| | |
|---|---|
| rec.gov names that are ALL CAPS | **2,719** — a third of the catalog |
| rows that are divisions of a park | **1,584**, across **321** parks |
| parks by division count | 87 have 2 · 75 have 3 · 50 have 4 · 86 have 5-9 · 20 have 10-19 · **3 have 20+** |
| biggest | Ohio's Grand Lake St. Marys, **70** divisions |
| multi-division parks that are rec.gov | **ZERO** — all ReserveCalifornia and state portals |

**THE TRAP IN "TOO MUCH INFO".** `rc-539` and `rc-542` are BOTH
"Leo Carrillo SP — Canyon Campground"; only "(sites 1-24, 78-133)" vs
"(sites 25-77, 134-139)" separates them. Blanket-stripping trailing parentheses makes
**374 campgrounds ambiguous** across 167 collision groups. The fix has to be structural —
park once, division beneath, ranges intact — not a regex that deletes suffixes.

`tidyCase` title-cases a name ONLY when it contains no lowercase at all. A mixed-case
name was cased by a human and re-casing it would rewrite every ReserveCalifornia row.

**PRE-EXISTING BUG FIXED:** `/api/suggest` never filtered `hidden`, so the picker offered
**425 non-campgrounds** — 183 shelters, 127 day-use areas, visitor centres, a golf
course. `/api/search` already excluded them.

**Users were already working around the division problem by hand:** Carpinteria SB
watched as FOUR separate watches, Pfeiffer Big Sur as three — one park eating most of a
6-watch allowance. That is what motivated option B below.

## 11. Park watches — option B (PR #56, OPEN, with the main lane)

One watch covers several divisions and counts ONCE against `WATCH_LIMIT`.
**Migration 070 is APPLIED TO PROD** (side lane claimed block 070+; `watches.id` is TEXT,
not UUID — Postgres refused the FK until that was fixed).

**THE SAFETY PROPERTY:** `watch_campgrounds` is EMPTY for every pre-existing watch and
`loadWatches` falls back to `w.campground_id`, so all 20 live watches keep a
byte-identical path. Verified against prod: 20 pairs → 22 with one watch expanded to
three → 20 again after cleanup, table back to zero rows.

**TWO PLACES COLLAPSED PER-WATCH STATE, both silent:**

1. `claimNotification` keyed on `campsiteId ?? '*'`, and **that sentinel is per-watch**.
   ReserveAmerica / GoingToCamp / TN-SC send no site id, so every division of a park
   watch would land on `(watch_id, '*')` and the first to open would silence the rest for
   an hour — migration 026's bug one level up.
2. `rc_hold_notified_for` is ONE column on the watch, so two divisions releasing in the
   same hour share it. Its **clear** needed scoping too, or a division with nothing held
   wipes the claim a sibling just made.

Both namespaced by campground **only when the watch is multi** — unconditional
namespacing would change every stored key and re-alert every open site once on deploy.
The flag is computed in the `loadWatches` SQL beside the expansion, not passed by each
call site.

Campsite ids were **measured unique within a park**: 10,757 sampled across
ReserveCalifornia, Ohio and Minnesota multi-division parks, **zero collisions**. So the
namespacing is belt-and-braces on the id path and load-bearing on the sentinel path.

`MAX_DIVISIONS_PER_WATCH = 10` replaces the bound the cap used to give. Covers 298 of the
321 parks whole. **This is UseDirect load, not rec.gov** — `poller.capacity` was never
threatened, though it counts expanded campgrounds now.

### What is NOT verified about PR #56

- **No multi-campground watch has ever run through a real poller cycle.** The join table
  is empty in prod, so the new path is dormant and untested end to end.
- **`expire-watches`, `watch-openings`, the manage page and the notification payload were
  NOT audited** for per-watch assumptions. Two claims were found and fixed; nobody looked
  at the rest.
- ~~**The watches list does NOT show a park watch's parts.**~~ **CLOSED in PR #63** — see
  section 13. Struck rather than deleted because CLAUDE.md still carries the same claim;
  see the flag at the end of section 13.
- ~~**PR #56 will now conflict with master.**~~ Resolved on the rebase and merged.

## 12. The SWC entity trap, restated because it will recur

An HTML entity (`&apos;` `&rsquo;` `&mdash;` `&amp;`, named or numeric) **anywhere** in a
JSX text node makes SWC drop that node's LEADING whitespace — even when the entity is on
a later line than the space being lost. A literal apostrophe is safe; the trailing space
survives. This is NOT Babel's behaviour, which is why a Babel-ported checker reported the
codebase clean while production rendered "ReserveCaliforniacarts".

`npm run jsx-spacing` catches it. **Verify UI copy fixes in the COMPILED artifact**
(`grep .next/static/chunks`), not by trusting a checker.

Related, and it bit twice in one session: **do not put backticks inside SQL comments** in
`worker/poller.ts` or `src/lib/capacity.ts` — those queries are template literals and a
backtick terminates the string.


---

# Third batch, 2026-08-15 (PR #63, merged)

## 13. A park watch now LOOKS like one — the display half is closed

`GET /api/watches` had returned `divisions` since migration 070 and **nothing rendered
it**, so a watch covering four campgrounds was indistinguishable from one covering a
quarter of that: it showed its REPRESENTATIVE division's name.

| surface | what it does now |
|---|---|
| `WatchCard` | Titled after the park, parts named beneath. Capped at 4 names then "+N more" — the ceiling is 10 and naming all runs to ~7 lines on a card built to be scanned. The count is always exact, so the truncation cannot mislead about coverage. |
| `/manage/<token>` | Same title rule, parts listed **in full** (this page is read, not scanned), and it **says what muting actually reaches**. |

**The manage caveat is the part worth keeping.** Site ids are per-campground and
`/manage` can only enumerate the representative division's inventory, so the mute list
there does not touch the siblings. It now says so:

> Muting below covers San Miguel (sites 401-460) only — the other parts keep alerting.

Leaving that unsaid would make a working control look broken on the sites it cannot see —
the failure mode where a feature's write half works and its read half is absent.

`divisions` is **absent** below two rather than length-1, so its presence is the test.
`/api/manage` uses the identical contract, deliberately, so the two screens cannot
disagree about what a park watch is.

> **FLAG FOR THE MAIN LANE:** `CLAUDE.md` line ~1045 still reads "The watches list does
> not show a park watch's parts" under KNOWN GAPS. That is **no longer true** for either
> surface. A stale known-gap sends someone to fix something already fixed.

## 14. Picker and filter fixes from the owner's screenshots

- **Favourites reverted to the long name.** A search hit collapses to the park; the same
  campground saved as a FAVOURITE could not, because a favourite is one division and
  naming it after the park would name a different thing. It gets the two-line shape
  instead — park bold, division beneath.
- **`dropRedundantState`** removes a trailing `(WY)` **only when the place label beside it
  repeats the same state**. The catalog holds BOTH "Silver Lake Campground" and "Silver
  Lake Campground (WY)"; stripping unconditionally renders two different campgrounds
  identically — the collision this module already refuses to create by stripping site
  ranges.
- **RV removed from Site type, Hookups in its slot.** RV overlapped the two controls that
  answer it from better data. Explore no longer accepts `?type=rv`, or a bookmark would
  keep narrowing through a control that is gone.
- **Beta banner scoped to ReserveCalifornia only.** rec.gov auto-cart has been carting
  live sites for weeks and is not in testing; the RC hold-and-hand-off is. Labelling the
  whole paid feature Beta would warn about something that mostly works.

## 15. Another dead screenshot preset, same family as the five

`manage-watch` imported `@/components/ManageWatch` — **deleted in the front-end swap** —
so it could only ever have failed to resolve. Repaired to `@/components/v2/ManageWatch`.

Two other fixtures still set `siteType: 'rv'` (one also set `pets`, removed the same day),
which would render a state the panel can no longer produce. **A fixture is code that
nothing typechecks**, so it rots silently; these are worth a sweep when a shared prop
changes.

## 16. Backticks bit a THIRD time, in a new place

Recorded because the first two were written off as a template-literal quirk and it is
broader than that. Twice in SQL comments inside template literals (`worker/poller.ts`,
`src/lib/capacity.ts`), and once in a `git commit -m "..."` string, where the shell
executed `` `divisions` `` and silently ate the word out of the commit message. Caught by
reading the message back before pushing.

**Use `-F-` with a quoted heredoc for commit messages**, and keep backticks out of SQL
comments in these files.

## 17. `markClaimed` had no caller, so every completed hand-off is still on screen

Reported by the owner as the hand-off banner hogging the Watches tab. It is not a layout
problem — nothing in the product had ever retired a hold.

`/api/rc-holds/mine` keeps `carted`, `claiming` and `released` **regardless of age**, on
purpose (that is the 2026-08-13 leak, where two carted holds sat unclaimed until a sweep
expired them). A `released` row is finished — the bot let go, the site is on RC for
whoever gets there first — and the only thing that would drop it is `status = 'claimed'`.
`markClaimed` exists, `PATCH /api/rc-holds/claim` exposes it, and its own comment says it
is what distinguishes an abandoned hand-off from a completed one. **`grep -rn markClaimed
src/` returns the definition, the route, and one test.** No caller. `ClaimFlow` POSTs to
start the claim and never PATCHes when it finishes.

So the remove control is the first caller, and `claimed` is exactly the state for it.

**The other four statuses get no button, and the omission is the design.**

| status | why not |
|---|---|
| `carted` / `claiming` | The bot is holding a real campsite in a real cart. Hiding the row does not release it — it takes the site off the market for every other camper and removes the only thing on screen still pointing at it. That is the 08-13 leak with a button on it. |
| `offered` / `requested` | There is no decline path server-side. A remove could only hide the row while the bot went on to cart the site at 08:00 anyway. **A control that appears to cancel and does not is worse than no control.** |

Giving those two a real "no thanks" means a server-side decline that also frees the
capacity seat an `offered` row occupies (`offered` counts toward `RC_HOLD_CAPACITY`) —
hold-lifecycle work, main lane, not panel work.

Removal is **deliberately not optimistic**: the row is dropped only after the write comes
back ok, so a failed remove leaves a hold that still exists exactly where it was. The
token is read back out of `claimUrl` — the same hold id + manage token that authorises
RELEASING the site, so never a weaker check than the more consequential act on the same row.

## 18. The six dead screenshot presets are gone, and two docs referenced them

Deleted: `search-bar`, `favorites-panel`, `ch-home`, `v2-available`, `v2-mobile`,
`avail-usedirect`. All six imported components removed in the front-end swap
(`@/components/SearchBar`, `@/components/FavoritesPanel`, `@/app/v2/page`,
`@/components/v2/AvailableNow`, `@/components/AvailabilityCalendar`) — verified missing on
disk before deleting, not assumed from the previous session's list.

**Every remaining preset was then checked mechanically** — all 35 `@/…` specifiers across
the file resolve. Worth re-running after any component move:

```
python3 -c "import re,os;s=open('scripts/screenshot-component.mts').read();print([m for m in sorted(set(re.findall(r\"from '(@/[^']+)'\", s))) if not any(os.path.exists(m.replace('@/','src/')+e) for e in ('.tsx','.ts','/index.tsx','/index.ts'))])"
```

**No guard test was added, on purpose.** It would live in `worker/`, and a new
`worker/*.test.mts` matches `worker-deploy.yml`'s path filter — it restarts both poller
machines. The failure mode here is already loud (a resolve error at render time, not a
silent wrong picture), so a poller restart is the wrong price for it.

`docs/SETUP.md`'s example invocation used `ch-home`; swapped for `ch-admin` so the
documented command still runs. That is mechanical fallout from the deletion, not a
rewrite of anyone's evidence.

### FLAGGED, NOT FIXED: `docs/CONTEXT.md` ~1465 is stale in a way I should not half-repair

That block reads *"The availability calendar is `src/components/AvailabilityCalendar.tsx`
… see the `avail-usedirect` preset"*. **Both names are dead** — the file was replaced by
`src/components/v2/AvailabilityGrid.tsx` and the preset is now deleted. Fixing only the
preset reference would leave a paragraph that names a file which does not exist while
LOOKING freshly verified, which is worse than leaving it visibly stale. Main lane's file
and main lane's call.

## 19. One cross-lane edit, made at the owner's explicit instruction

`CLAUDE.md`'s KNOWN GAPS entry (~1044) still said the watches list does not show a park
watch's parts. PR #63 closed that on both `WatchCard` and `/manage/<token>`. Struck rather
than deleted, with the correction beside it.

**The other half of that entry is still true and was kept**: `/manage/<token>` can only
enumerate the REPRESENTATIVE division's inventory, so a sibling division's site cannot be
muted from there. What changed is that the screen now says so instead of leaving the reader
to infer it from a list quietly covering one park in three. Correcting the display half and
silently dropping the inventory half would have read as "gap closed".

`CLAUDE.md` is the main lane's file under `docs/LANES.md`. This edit is one paragraph, made
because the owner asked for it directly, and is called out in the PR so the main lane sees
it rather than meeting it in a conflict.

---

# Handover — 2026-08-16

**Branch state: nothing outstanding.** `claude/side-holds-dismiss` merged as PR #70 and is
deleted; the side lane holds no open branch, no open PR, and no uncommitted work. The three
open PRs on the repo (#51, #66, #69) are all the MAIN lane's — RC renewal and Feature E
docs. Do not touch them.

## The 2026-08-15 handover is fully closed

All five of its items, verified mechanically rather than read off `CLAUDE.md`:

| item | state |
|---|---|
| `site_type` inert in the poller | **Closed by the main lane.** The picker is gone from New watch; `NewWatch.tsx:318` now carries the comment recording why. The panel stays on Explore, where search really does resolve it. |
| `verify.yml` races itself | **Closed.** `concurrency.group` is `verify-${{ github.head_ref \|\| github.ref_name }}`, so a branch's push run and its PR run share a group and cancel. |
| dead screenshot presets | **Closed this session** — see §18. Six deleted, all 35 remaining specifiers checked. |
| PR #56 park watches | **Merged**, migration 070. |
| `jsx-spacing` not in `verify` | **Closed.** `npm run verify` is `typecheck && jsx-spacing && test && build`. |

## What a fresh side-lane session should know

**Read `docs/LANES.md` first.** The parts that bite: never work on `master` (a hook
refuses it, and the override is an incident tool, not the merge path); merges go through a
PR; and `npm test` hits the **production DB**, so it is serialized between lanes — as are
`rc-test-hold.mts`, anything touching the mini-PC, and `sms-link-test.mts --send`.

**The side lane does not write `CLAUDE.md`, `docs/CONTEXT.md`, `docs/SETUP.md` or
`docs/NEXT-SESSION.md`.** Findings go in this file; the main lane folds them in. §19 is the
one exception in this file's history and it was made because the owner asked directly.

**Migrations: the side lane's block is 070+, and 070 is taken.** Default to creating none.

## Two things left for someone else, both named in-file

1. **`docs/CONTEXT.md` ~1465 is stale** and I deliberately did not half-repair it — it names
   `src/components/AvailabilityCalendar.tsx` (deleted; now `v2/AvailabilityGrid.tsx`) and the
   `avail-usedirect` preset (deleted in §18). Main lane's file. Reasoning in §18.
2. **A real "no thanks" for `offered`/`requested` holds.** §17 explains why the remove
   control deliberately stops at `released`: there is no server-side decline, so a button on
   those two would hide the row while the bot carted the site anyway. Doing it properly means
   a decline path that also frees the capacity seat an `offered` row occupies — `offered`
   counts toward `RC_HOLD_CAPACITY`, which is **2**. Hold-lifecycle work, main lane.

## Standing constraint, unchanged

**Do not advertise park watches.** `watch_campgrounds` is still 0 rows in prod and no park
watch has ever run a poller cycle. The display work in §13 makes an existing one legible; it
does not promote the feature, and neither should any copy written next.
