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

---

## 20. THE FIXTURE SWEEP DELETES A CONCURRENT RUN'S LIVE ROWS (2026-08-16)

CI failed on a **docs-only** commit. Not a flake to re-run past — the mechanism is exact,
and it is a defect in `worker/rc-holds.test.mts`'s own safety fix.

```
not ok 377 - a carted hold records how to RELEASE it, not just that we hold it
  error: "Cannot read properties of undefined (reading 'status')"
  worker/rc-holds.test.mts:164:20
```

Line 164 is `assert.equal(row.status, 'carted')`. `row` is undefined, so the `SELECT … WHERE
id = $1` returned **zero rows** — a row `markCarted` had written two statements earlier had
been deleted mid-test. `req!` did not throw, so `requestHold` succeeded; nothing in the test
deletes.

**`before()` is what deletes it:**

```sql
DELETE FROM rc_hold_requests WHERE unit_id LIKE '\_\_t%'
```

Its own comment states the assumption: *"Matched on the sentinel, never on the watch id: the
leaked rows belong to a PREVIOUS run's watch, which this process has never seen."* **That
holds only if no other run is live.** Every run's fixtures carry the same sentinel prefix, so
a starting run cannot distinguish an aborted run's litter from a running one's working set —
and it deletes both.

**Confirmed from the run timings, not inferred:**

| run | window |
|---|---|
| `claude/side-lane-setup-f7bpe2` (mine) | 05:01:51 → 05:04:25, **failing assert at 05:03:48** |
| `claude/rc-claim-flow` (main lane) | **05:02:39 → 05:05:05** |

The other lane's run started 69 seconds into mine and swept the table underneath it.

**My own two runs were ruled out first.** The push run was cancelled during `npm ci` with the
`Verify` step **skipped** — it never executed a test. The `verify-${{ github.head_ref ||
github.ref_name }}` concurrency group did exactly its job; this is a *cross-branch* collision,
which that group cannot address by construction.

### Why this is worse than the collision it replaced

Before the sweep (added 2026-08-15), two concurrent runs collided *passively* — shared fixture
ids, unpredictable interference. The sweep makes one run **actively wipe** the other's live
rows on startup. The fix for an aborted run made the concurrent-run case sharper, which is the
same shape as CLAUDE.md's *"a fix that makes a failing path succeed can promote junk that was
only ever filtered by its failure"*.

It is also **silent in the dangerous direction**: the run that gets swept fails with a null
dereference three statements away from the cause, while the run doing the sweeping passes
clean and logs `swept N hold fixture(s) left by an earlier run` — a line that reads as
self-healing working, at the exact moment it is destroying a live run.

### What it does NOT mean

`docs/LANES.md` already serializes `npm test` between lanes. **This is that rule being broken
by CI, not by a session** — neither lane ran `npm test` by hand; two `claude/**` pushes landed
90 seconds apart and CI ran both. So "announce before running the suite" cannot fix it, because
nobody ran the suite.

### It happened AGAIN 20 minutes later, and the second one is the better example

Re-running the failed job passed, which alone would have licensed "flake". It is not — the
next commit failed the same way with a **different victim**:

```
not ok 228 - a requested hold whose release passed long ago is failed, not left silent
  the whole point: this must not sit at `requested` forever
  0 !== 1
  worker/expire-holds.test.mts:83:10
```

Zero rows expired because the rows were gone. Timings again:

| run | window |
|---|---|
| mine (PR) | 05:21:38 → 05:23:45, **failing assert at 05:22:46** |
| **`master` push** | **05:21:36 → 05:24:18** |

**The overlapping run was `master`** — the main lane merging `claude/rc-claim-flow` two
seconds before my run started. That is the sharper case for two reasons: nobody thinks to
serialize against a *merge*, and `expire-holds.test.mts` is a different suite from the one
holding the sweep, so the blast radius is every suite using the sentinel, not just its owner.

**Two occurrences, two different victim tests, two different colliding branches, inside 25
minutes.** Both times the failure is a null/zero where a row should be, several statements
from the delete that caused it.

### The fix belongs to the main lane (`worker/`)

Options, in the order I'd rank them:

1. **Namespace the sentinel per run** — `__t<runId>_9006` — so a sweep can only ever match
   another run's ids by an explicit "older than N minutes" rule. Keeps non-numeric, keeps
   recognisable in `rc-holds-readout.mts`.
2. **Age the sweep**: only delete sentinel rows whose `updated_at` is older than a few minutes.
   Cheaper, and it preserves the self-heal — but it is a clock guess, and a slow run could
   still cross it.

Whatever is chosen, **the mutation to verify against is the one that makes the sweep
unconditional again** — and a real-DB test for it has to simulate two overlapping runs, which
is the hard part and the reason to keep the guard mechanical rather than a comment.

---

## 21. THE DEMO PASSWORD WAS NEVER WRONG — `CLAUDE.md`'s cause 1 is false (2026-08-16)

`CLAUDE.md` §"iOS 1.0 WAS REJECTED" gives two causes for the Guideline 2.1 rejection and
states the first as measured fact:

> **The password in the Sign-In Information field is WRONG.** … §5's "VERIFIED DONE
> 2026-08-08" checked that the field was POPULATED, never that its contents WORK.

**It is not wrong, and the owner says it has never been wrong.** Verified two ways:

- The **Sign-In Information field** in App Store Connect, read off a screenshot, holds the
  same value the owner's 2026-08-13 reply to Apple quotes.
- That value verifies against Clerk: `POST /v1/users/<id>/verify_password` → **200
  `{"verified": true}`**.

**No credential is recorded here, deliberately** — `docs/APP-STORE.md` §2 keeps `<fill in>`
for that reason. The failing string is the 11-character variant already quoted in
`CLAUDE.md` §2a; it differs from the real one in two characters. Referring to it by location
rather than re-quoting it keeps the count of copies in git at one.

### How I reproduced a bug that did not exist

I read cause 1 in `CLAUDE.md`, tested the string it names, got `422 incorrect_password`, and
reported it to the owner as *"that's the password in your Sign-In Information field, checked
against Clerk this minute"* — recommending a password reset before resubmitting.

**The 422 was real. The attribution was not.** I had verified that *a string in a doc* fails;
I had not looked at the field, and I described the result as though I had. The owner's
screenshot is what corrected it.

This is the house failure shape aimed at a doc instead of an instrument: **a fact inherited
from `CLAUDE.md` and re-reported as freshly measured.** Same family as `status = 'sent'`
meaning only "Twilio returned 2xx" — the check that felt conclusive measured the cheaper
half. `CLAUDE.md` is ~1,200 lines of hard-won evidence and is right about almost everything,
which is exactly what makes an inherited claim feel like a verified one. **Say which artifact
you actually read.**

### What is still open

**Where the failing variant came from is NOT established, and there are two possibilities
with different owners.** Either Apple's 2026-08-13 06:33 message genuinely quoted it that way
— meaning the reviewer was working from a mistyped string, which is Apple's side — or a
previous session mis-transcribed it into `CLAUDE.md`, which is ours. Apple's original message
settles it and only the owner can read it. **Do not write a cause into any doc until someone
has.**

### The rejection's real cause was cause 2 alone

Clerk **Device Trust** emails a one-time code on any password sign-in from an unrecognised
device — every App Review device, every time. The demo account is `password_enabled: true`,
`two_factor_enabled: false`, so it is squarely in scope. The owner turned it off and
confirmed a clean sign-in from a private window on a device that had never touched the
account, which is a stronger check than anything available from here: `/v1/instance` does not
expose the setting and the settings endpoints return 405, so **Device Trust is dashboard-only
and cannot be verified by an agent.**

### Account state, checked the same day

```
status: active · tier: base · grandfathered: true · is_beta: false · active_watches: 2
```

So the reply's claim that a reviewer sees a populated paid app is accurate.

**iOS 1.0 was resubmitted to App Review on 2026-08-16.**

### For the main lane

`CLAUDE.md` still carries cause 1 as fact. It should be struck and corrected — a wrong,
confident, measured-sounding claim there is worse than an absent one, because the next reader
will reproduce the 422 and treat it as confirmation. Not edited from this lane; `CLAUDE.md`
is the main lane's file.

---

# Handover — 2026-08-17 (supersedes the 08-16 handover above)

> **SUPERSEDED — see "Handover — 2026-08-18" at the END of this file.** Its item 2 (the
> `a04171a2` test hold) is resolved and the answer is **it failed**: see §22. Its item 1
> (App Review) is unchanged and still waiting.

## Two things are LIVE and waiting on the outside world

### 1. iOS 1.0 was RESUBMITTED to App Review on 2026-08-17

Answering Apple's 2026-08-16 **Guideline 2.1 — Information Needed** letter (a different,
much cheaper rejection than the 08-14 sign-in one). Sent: a **2:56 screen recording**
attached in Resolution Center, the **Notes field replaced** with a 3,997-character block,
and a reply carrying a timestamp index plus items 2–7. **Build `1.0 (5)` untouched.**

Everything about what was sent, and the three findings from producing it, is in
`docs/APP-STORE.md` §2b. The one to read first: **iOS does not record privacy permission
alerts** — a screen recording captures only the app's window dimming behind them, so the
two prompts had to be filmed with a second camera.

**Nothing to do but wait.** When Apple replies, record the outcome in §2b.

### 2. An RC test hold is queued for 2026-08-17 08:00:53 PT

```
hold    a04171a2-49de-4d3a-8108-8f4b7dcbdcc7
site    Carpinteria SB — San Miguel (sites 401-460) · unit 4728 · #M401
stay    arrive 2026-12-01, 1 night
claim   https://camphawk.app/claim/a04171a2-49de-4d3a-8108-8f4b7dcbdcc7?t=EQO2oXcQ
```

**Queued at the owner's explicit request.** `docs/LANES.md` marks `rc-test-hold.mts` as
SERIAL and says to announce first; `ListAgents` reported no reachable sibling, so the
owner's instruction is the authorisation and this is the record of it.

- **The unit came from `--find`, not from a person** — it asks RC's own grid what is
  genuinely bookable, because "never invent a unit id" has locking a stranger's campsite
  as its failure mode. San Miguel was chosen for having **44 bookable sites** that night,
  the most on offer, so the test takes nothing scarce.
- **It is a REAL site and it locks at 08:00** until claimed, released, or RC drops the cart
  (~15 min). Abandoning it means `--delete a04171a2-…` **and** clearing the cart by hand.
- **Open the claim link IN THE APP.** From a browser `canInject` is false and the injected
  precart — the thing being tested — never runs.
- **The answer is in `client_reports`:** a `load` stage, a `submit` stage, and
  **`✓ Added to cart`**. `token captured` as the last line is NOT a successful cart.
- **The 02:00–05:00 update window is shut** while this sits `requested`. Costs nothing
  tonight — the mini-PC is already on `d09f225`, same as web.

**Health going in (2026-08-16 23:38 PT):** runner OK (polling), `bot_version` OK,
`rc_session` **dead but not stale** — the keep-warm reported 82s earlier, so the repair is
SCHEDULED (`maybeAutoLogin` at 07:30), which is the right side of the 2026-08-10 failure.
`rc_login` warns that no rehearsal has passed since 08-16. **This is the first real morning
with PR #80's 07:33-false-alarm fix live on the box.**

### THE TEST HOLD BLOCKS THE UPDATE THAT WOULD DELIVER THE CODE IT TESTS

Within minutes of queueing it, the main lane merged **#98** — which rewrites
`scripts/auto-cart-bot/rc-hold-runner.mjs`. `autocart.bot_version` went to **FAIL**:

```
mini-PC is on d09f225; web is on 44a66b2 — and it is MISSING bot-side changes,
with 1 hold(s) queued.
```

That is the one configuration the check exists to catch, and **the test hold is what
produced it**: `nextHoldRelease` counts a `requested` row, so the 02:00–05:00 PT quiet
window is shut and the guard's 6h release check refuses as well. The hold prevents the
update that would deliver the runner code the morning is about to exercise.

**Decided: keep the hold and let it run on `d09f225`.** #98's own commit message is what
settles it —

> THE LEAD IS WAITED ONCE PER RELEASE. It used to be waited per hold, inside the loop —
> where every wait after the first was already zero, so the sequencing was pure
> serialisation gating nothing.

So the change is about carting a release **group** concurrently, and with **one** hold the
old and new paths are functionally identical. The other half of #98 (the BETA labelling) is
web-side and already live on Vercel. Nothing in the single-hold path is stale.

**The FAIL is therefore expected and self-clearing** — once the hold reaches a terminal
status the window opens and the box updates. Do not read it as the halves having drifted by
accident; it is a cost this test knowingly took. **If a future test needs the NEW runner,
the order has to invert:** let the box update first, then queue the hold.

## Still open, all main lane's

1. **Issue #76** — `rc-holds.test.mts`'s fixture sweep deletes a *concurrent* run's live
   rows. Two confirmed occurrences 25 minutes apart, different victim tests. Options ranked
   in the issue; §20 has the traces.
2. **PR #78** (`claude/rc-login-fix`) — two real fixes stranded by the in-app sign-in
   revert. **Must not be merged onto the reverted claim screen**; re-land the feature first.
3. **`docs/CONTEXT.md` ~1465** — names `src/components/AvailabilityCalendar.tsx` (deleted;
   now `v2/AvailabilityGrid.tsx`) and the `avail-usedirect` preset (deleted in §18).
   Deliberately not half-repaired — see §18.
4. **A real decline path for `offered`/`requested` holds** — §17. Needs to free the
   capacity seat an `offered` row occupies, since `offered` counts toward
   `RC_HOLD_CAPACITY` and that is 2.

## Side lane state

No branch, no uncommitted work beyond this PR. Park watches remain unadvertised —
`watch_campgrounds` is still 0 rows.

---

## 22. THE 08-17 TEST HOLD FAILED, AND THE RUNNER'S LOG CANNOT SAY WHY

`a04171a2` (unit 4728, released 2026-08-17 08:00:53 PT) ended `failed`, never carted:

```
error              no cart at release time — the hold runner did not pick it up
last_attempt_note  NULL
requested_at       2026-08-17 06:38:54 UTC
updated_at         2026-08-17 16:19:04 UTC   ← expireStaleHolds, ~1h after the grace
```

**`last_attempt_note` NULL is the whole hard evidence.** A skipped pass stamps it *without*
moving status, so a runner that tried and gave up leaves a note. Nothing did.

### What was going on, and what it does NOT explain

`bot_update_requests` shows a request from `claude-session`, since **withdrawn** with the
reason `"on-demand path failing silently"`. While it was pending the runner logged, every
15 seconds:

```
→ update requested, but another process has the claim (or we could not ask) — standing down
```

**I was about to file that as the cause. It is not.** `control-channel.mjs:81` wraps the
claim in `void (async () => {…})()` — fire-and-forget — so it never blocks the poll loop and
carting proceeds regardless. Read the code rather than the log line. (It *is* a churn bug:
the refusal path sets `updateStartedAt = 0`, so it re-asks on the very next poll instead of
backing off, which is where the 15-second spam comes from.)

### THE RUNNER'S LOG IS FROZEN, AND THAT IS THE REAL FINDING

`tail-log rc-holds` returns a file whose last line is **22:48:52 PT on 2026-08-16** — about
eighteen hours stale. Three things prove the file is dead rather than the process:

1. **`list-processes` shows the runner alive** — `node.exe rc-hold-runner.mjs` pid 17332,
   under its supervisor, alongside all three other payloads.
2. **The box updated today** (`d09f225` → `dd27a98`), which stops and restarts everything.
   The runner writes a startup banner on every launch; there is no banner after 22:42:55.
3. **`control-channel.mjs:52` logs `? diagnostic <kind> (#<id>)` on pickup.** Two commands
   were answered minutes before the tail was taken. Neither appears.

Same family as the 2026-08-12 keep-warm freeze — Windows file locking, a log that stops
while the process reports to the server perfectly. **So there is NO log evidence covering
08:00, and the silence over the release window is the FILE's, not the runner's.** Reading it
as "the runner never saw the hold" would have been exactly wrong.

**Cause of the missed cart: NOT ESTABLISHED. Do not write one into any doc.**

### Tomorrow's test is queued

```
hold   cec06412-6226-4319-94d5-fe2867749063
site   Carpinteria SB — San Miguel · unit 4729 · #M402 · arrive 2026-12-01
when   2026-08-18 08:00:08 PT
claim  https://camphawk.app/claim/cec06412-6226-4319-94d5-fe2867749063?t=EQO2oXcQ
```

Conditions differ from the failed run in three ways that are worth stating, because if it
fails again none of them is the excuse: **no update request is pending**, the box is
**current** (`dd27a98`, "No bot-side code in the gap"), and the session is **live** with
Okta good to 2026-08-18 06:50 UTC. This one also runs on #98's runner, which the previous
test did not.

**Fix the log before trusting the next post-mortem** — a frozen log will make tomorrow just
as unreadable as today.

---

# Handover — 2026-08-18 (supersedes the 08-17 handover above)

## The one thing that is live and dated

**RC test hold `cec06412-6226-4319-94d5-fe2867749063` releases 2026-08-18 08:00:08 PT.**

```
site   Carpinteria SB — San Miguel (sites 401-460) · unit 4729 · #M402
stay   arrive 2026-12-01, 1 night
claim  https://camphawk.app/claim/cec06412-6226-4319-94d5-fe2867749063?t=EQO2oXcQ
```

**Check it first thing:**

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts
```

- The verdict is in `client_reports`: a `load` stage, a `submit` stage, and
  **`✓ Added to cart`**. **`token captured` as the last line is NOT a successful cart** —
  that has been misread as success before.
- **Open the claim link IN THE APP.** From a browser `canInject` is false and the injected
  precart, which is the thing under test, never runs.
- It is a **REAL site** and locks at 08:00 until claimed, released, or RC drops the cart
  (~15 min). Abandoning it means `--delete cec06412-…` **and** clearing the cart by hand.

**This is the second attempt. The first (`a04171a2`, 08-17) FAILED — read §22 before
drawing any conclusion from this one.**

## Read §22 before diagnosing anything

Two things in it will save a wasted hour:

1. **The runner's log is FROZEN** (last line 22:48:52 PT on 08-16) while the process is
   alive. `tail-log rc-holds` therefore returns a stale file, and its silence over a release
   window says nothing about what the runner did. Reading that silence as "the runner never
   saw the hold" is the mistake §22 records me making. **Fix the log before trusting any
   post-mortem** — main lane's code.
2. **The "update requested … standing down" spam is NOT a cart blocker.** The claim runs in
   a fire-and-forget IIFE (`control-channel.mjs:81`) and never blocks the poll loop. It is a
   churn bug, not starvation.

**The cause of 08-17's miss is NOT established, and no guess is recorded. Keep it that way
unless there is evidence.**

## Health at handover (2026-08-17 ~17:30 PT)

Everything green except the standing rehearsal warn:

```
OK    autocart.bot / rc_runner / rc_session / watchdog
OK    autocart.bot_version   mini-PC and web BOTH on b3c6a3a
WARN  autocart.rc_login      no rehearsal has PASSED since 2026-08-16
```

**The box is fully current this time**, which is the material difference from 08-17 — that
run went out on a box the queued hold had pinned to older code. The quiet window is shut
again tonight (a `requested` hold within 6h of 02:00–05:00 PT), but nothing is pending, so
it costs nothing.

## Still waiting on the outside world

**iOS 1.0 is with App Review**, resubmitted 2026-08-17 with the recording and the rewritten
Notes. Nothing to do but wait; record the outcome in `docs/APP-STORE.md` §2b.

## Still open, all main lane's

1. **The frozen runner log** — see §22. Nothing else on this list matters as much, because
   it is what makes every other RC question unanswerable.
2. **Issue #76** — `rc-holds.test.mts`'s fixture sweep deletes a *concurrent* run's live
   rows. Two confirmed occurrences, traces in §20.
3. **PR #78** (`claude/rc-login-fix`) — two real fixes stranded by the in-app sign-in
   revert. **Must not be merged onto the reverted claim screen**; re-land the feature first.
4. **`docs/CONTEXT.md` ~1465** — names a deleted component and a deleted preset.
   Deliberately not half-repaired; reasoning in §18.
5. **A real decline path for `offered`/`requested` holds** (§17) — needs to free the
   capacity seat an `offered` row occupies, since `offered` counts toward
   `RC_HOLD_CAPACITY` and that is 2.

## Side lane state

On `master`, clean, no open branch or PR. Park watches remain unadvertised —
`watch_campgrounds` is still 0 rows.

---

## 23. THE `bot_version` FAIL, 2026-08-22 night — benign, and the quiet window misses by 14 seconds

Read at 22:41 PT on 08-22, with a test hold queued for 07:59:46 PT on 08-23.

```
FAIL | mini-PC is on e2be117; web is on 6ddc12f — and it is MISSING
       bot-side changes, with 1 hold(s) queued.
```

The main lane has already written this up in `docs/NEXT-SESSION.md` (#161, corrected by
#164) and their account is right. Two things this pass adds that are not in it.

### The gap is exactly two commits, both diagnostics

`e2be117..809a46a` touching `scripts/auto-cart-bot/` or `mini-pc/`:

```
33efc4b  Sample the auto-login too (#163)     rc-keepwarm.mjs       +62
b8d8848  Sampler: module+offset (#160)        rc-native-sampler.mjs +189/-15
```

Nothing else. #163 does touch `maybeAutoLogin`, which IS release-critical — the main lane
corrected their own note for exactly that reason — but it adds no logic to the login, only
bounded (5s) CDP reads that return null rather than throwing. **And it cannot reach the box
before the test anyway**, which is the next section.

### ~~The box cannot update tonight~~ — IT UPDATED AT 23:12 PT, AND I HAD THE REFUTATION OPEN

`safeToUpdate` refuses when `0 ≤ hoursUntilRelease < 6`. Release is **07:59:46 PT**, so the
block starts at **01:59:46 PT**. The quiet window opens at **02:00:00 PT**. The whole window
is inside the block — by fourteen seconds.

**That freeze is accidental, not structural.** A release at 08:00:15 PT would have left the
02:00 scheduled run clear to update, six hours before the cart, which is exactly the margin
the constant was chosen for. So "the box is frozen because a hold is queued" happens to be
true tonight and is a coin flip on how `rc-test-hold.mts` picks the release second. Worth
knowing before quoting the freeze as a property of queued holds in general.

**THE ARITHMETIC IS RIGHT AND THE CONCLUSION WAS WRONG.** Forty minutes after writing this,
`rc_runner_heartbeat.bot_commit` read **`57e9d79`** and `git-status` — the authority, per the
2026-08-14 COALESCE note — confirmed **`HEAD 57e9d79 on master`**. The box updated at
**23:12:03 PT**, taking #160, #163 and #166 in one go.

**The refutation was in the file I had open.** `safeToUpdate` reads:

```js
if (!requested && (hour < windowStart || hour >= windowEnd)) { ...refuse... }
```

**A request LIFTS the quiet window.** The only gate a request cannot lift is the 6h release
check — and at 23:11 PT the release was **8.8 hours** away, comfortably past it. So the
legal window for a *requested* update ran from whenever the hold was queued until
**01:59:46 PT**, roughly three hours, and somebody used it. The fourteen-second arithmetic
describes the *unrequested* scheduled path only, and I generalised it to "the box cannot
update tonight" without checking the branch immediately above the one I had quoted.

**The main lane had the same premise and it is now stale.** #167 (`ecd1a08`, committed
23:14:45 PT) is titled *"a real hold lands at 07:59 and the box is missing every new
instrument"* — written **two minutes after** the box stopped missing them. Its reasoning
about what tomorrow can and cannot show still stands; only "the box is behind" does not.

**AND THE STALE-NOTE TRAP FIRED AGAIN, IN THE DANGEROUS DIRECTION.** The row now reads:

```
applied_at    2026-08-23T06:12:03Z
applied_sha   57e9d79            ← the update that LANDED
applied_note  "[update-guard] SKIP - outside the quiet window (23:00 PT ...)"
```

A later, unrequested scheduled run refused and `noteBotUpdateAttempt` overwrote the note
without touching `applied_at` or `applied_sha`. So the panel shows a **refusal beside the
sha that proves success**. The section below warns about this shape with a benign example;
this is the same trap pointing the other way, where the note would talk you out of an update
that already happened. **`git-status` is the only field that settles it.**

### There is NO pending update request, and no churn

`CLAUDE.md` warns that a standing request churns the box — `UPDATE_RETRY_MS` (15 min)
against a 20-minute claim TTL, each attempt bouncing every process. **It does not apply
here.** `bot_update_requests` reads:

```
requested_at  2026-08-22T17:15:07.459Z   requested_by "agent: merge #155 native memory sampler"
applied_at    2026-08-22T17:15:37.655Z   applied_sha  e2be117   claimed_at NULL
applied_note  "started - checking the guard"
```

`botUpdateState` derives `pending` as `requestedAt && (!appliedAt || appliedAt < requestedAt)`.
`applied_at` is **thirty seconds newer** than `requested_at`, so **`pending` is false** — the
request was closed the same minute it was made and has not been outstanding for twelve hours.

**The guard's own verdict string proves it independently, a hundred times over.** A request
LIFTS the quiet window (`if (!requested && hour outside window)`), and every scheduled run
from 17:11 PT to 22:41 PT logged `SKIP - outside the quiet window`. If the feed had been
answering `updateRequested: true`, that line could not have been printed. There is no
`[stop-all]` anywhere in the tail either: the guard refuses before anything is stopped, so
each 5-minute run is cheap.

**The stale `applied_note` is the trap.** `"started - checking the guard"` sitting beside
`applied_sha = e2be117`, twelve hours old, reads like an update that hung halfway. It is the
documented `appliedNote`/`appliedSha` mismatch — the note is from whichever run wrote it last
and does not describe the same event as the sha. Do not read it as an update in progress.

### Health nine hours out

- `rc_runner_heartbeat.beat_at` sampled five times: 05:41:26 → 05:41:42 → 05:41:57 →
  05:42:12 UTC. **15.4 seconds apart, so this is the hold runner**, not the updater's 301s
  (`beatIsFromRunner`, 2026-08-14). The runner is alive and polling the feed.
- `session_ok: true`, `token exp in 39m`, `okta=ALIVE (exp 2026-08-23T17:21:13)`, source
  `keepwarm`.
- Hold `51f3ad3d-8856-4bd0-8dd3-b64ad31d8b5f`, unit `45719`, `requested`,
  `last_attempt_note` NULL — nothing has tried yet, which is correct nine hours out.

### §22 has cleared — the runner log is writing again

`tail-log rc-holds` returns entries through ~04:01, most recently ~1h40m before the read.
So tomorrow's outcome will be diagnosable from the log, which it was not on 08-17.

Still true from §22: the diagnostics are answered `by bot`, so `? diagnostic` lines do not
appear in the runner's log. That is the control channel riding both feeds working as
designed, not a runner fault.

### State at 23:21 PT, after the update

Everything above was read at **22:41 PT** and the box moved at **23:12**. Re-read rather
than remembered — the same rule `CLAUDE.md` records as *"a health reading goes stale faster
than a conclusion drawn from it"*.

```
box            57e9d79 on master   (has #160, #163, #166)
master         ecd1a08             (docs-only ahead of the box)
bot_version    should now be GREEN — the gap was code, and the code landed
heartbeat      06:21:29Z, session_ok, token 58m, okta=ALIVE (exp 18:01:14Z / 11:01 PT)
hold           51f3ad3d · unit 45719 · South Carlsbad SB — Northern End (sites 35-102)
               requested · release 2026-08-23 07:59:46 PT · last_attempt_note NULL
```

~~**THE HOLD IS A REAL USER'S, NOT A TEST FIXTURE.** It carries a `user_id` and a real
campground, and #167 says so in its title. Nothing in this section is a synthetic run, and
nothing here should be treated as disposable.~~

**FALSE — IT WAS A TEST FIXTURE. CORRECTED IN §24.** `unit_name` reads `TEST · 45719`, the
`MARK` prefix written only by `scripts/rc-test-hold.mts`. **And the reasoning above is exactly
backwards**: that script COPIES `user_id` and `campground_id` from a real watch
(`rc-test-hold.mts:240`), so "it carries a user_id and a real campground" is true of every
test hold by construction and is evidence of nothing.

**Okta expires 11:01 PT, i.e. AFTER the 08:00 release** — so the T−3h warm-up correctly
stands down and the T−30 sign-in is the cheap cookie-answered kind. #167 sets expectations
low for exactly this reason: the 9.4 GB password variant needs `okta=GONE` at T−30 and will
not happen. What tomorrow can produce is a **sampled reading of a non-ramping Okta trip**,
which is the control that investigation has never had.

---

## Handover — 2026-08-22 late evening (~23:30 PT)

### The one thing that is live and dated

~~**A REAL user's RC hold releases at 07:59:46 PT on 2026-08-23**~~ — **a TEST FIXTURE; see
§24.** Unit `45719`, South Carlsbad SB — Northern End. Hold
`51f3ad3d-8856-4bd0-8dd3-b64ad31d8b5f`, `requested`, `last_attempt_note` NULL. It carted at
T+1.6s and released; the morning worked. What was wrong was only what it was evidence OF. Read `/rc-status` or
`scripts/rc-holds-readout.mts` before touching anything on the box; **the SERIAL rules in
`docs/LANES.md` bind hardest in the hours around a real release.**

Set expectations the way #167 does, so a quiet morning is not misread as a cure: Okta
expires **11:01 PT**, after the release, so the warm-up stands down and the T−30 sign-in is
the cheap cookie-answered kind. The 9.4 GB password variant cannot occur. What tomorrow can
produce is a **sampled reading of a non-ramping Okta trip** — a control the leak
investigation has never had.

### Read §23 before diagnosing the box

Two traps in it, both fired this session:

1. **`applied_note` and `applied_sha` do not describe the same event**, and the note can
   point either way. It currently reads `SKIP - outside the quiet window` beside
   `applied_sha 57e9d79`, which is the sha of an update that **succeeded**.
   **`git-status` through `bot_commands` is the only field that settles "did it land?"**
2. **A requested update LIFTS the quiet window.** Only the 6h release check is unliftable.
   I got this wrong with the guard source open, and so did #167.

### What this session did

- **Play Store production application submitted** (owner drove the console; I supplied
  every copyable answer and verified the vendor answer sheet's four claims — three were
  false). Not yet written into `docs/PLAY-STORE.md`; offered, not confirmed.
- **`SignOutConfirm` shipped** (#162) — Settings now confirms before signing out, which is
  what made the production application's Q8 answer true rather than aspirational. Its
  header records why it is not in the Clerk account menu: the `appearance` key to hide
  Clerk's built-in Sign out is not present anywhere in the installed `@clerk/*` packages,
  and a guessed key **fails open**.
- **iOS `1.0 (5)` resubmitted** with rewritten App Review notes, same binary — the 3.1.1
  round that finally tests whether link-out alone clears it. `docs/APP-STORE.md` §2d.
- **§23**, above, and its correction.

### Still open, all main lane's

- **PR #146** — worker-deploy path list. Merging restarts both poller machines, so it
  wants a moment away from a release. **Not tomorrow morning.**
- **Issue #76** — `worker/rc-holds.test.mts`'s `before()` sweep deletes a concurrently
  running suite's fixture rows. Two confirmed occurrences, different victims, one colliding
  with a master push. Ranked fixes are in the issue.
- **The live manage token `EQO2oXcQ`** — still unrotated. `GET /api/manage/EQO2oXcQ`
  returns 200 with the owner's real active watch. It is in this file's history and in
  `docs/a2p-campaign.md:52`, and **scrubbing the files is not enough because git history
  persists** — rotation is one DELETE from `action_tokens`. Owner's call; I have not acted.

### Side lane state

On `claude/side-lane-setup-f7bpe2`, **PR #165 open**, docs only. Nothing uncommitted.
Open-issue list not re-verified at handover — GitHub rate-limited on the last call.

---

## 24. THE 08-23 HOLD WAS A TEST FIXTURE, AND NEITHER 9 GB RAMP TRIPPED THE GUARD

*Side lane, 2026-08-23 afternoon. A read-only status pass that turned up two corrections and
one gap. All three are findings about main-lane files; none has been folded in, which is what
this section is for.*

### 24a. THE 2026-08-23 HOLD WAS SYNTHETIC — §23, #167 and CLAUDE.md all call it real

The morning worked and that part is not in question: unit `45719` carted at **T+1.6s**
(14:59:47.601Z against a 14:59:46Z release), reported `✓ Added to cart` on iOS 1.0 (21), and
`released` at 15:10:05Z. **What is wrong is what it is evidence OF.**

```
unit_name     "TEST · 45719"     <- MARK, written only by scripts/rc-test-hold.mts:57
arrival       2026-12-01         <- first of that script's three default far-future dates
user_id       user_3GCYFCr7...   <- same user as TEST · 4733 (08-21) and TEST · 4734 (08-20)
release_at    07:59:46 PT        <- the script's own release-second pattern
```

`grep` over the repo finds `TEST · ` in exactly two places: `rc-test-hold.mts:57` and
`worker/rc-holds-readout.test.mts`, whose fixtures use non-numeric unit ids. Nothing in the
poller can produce it. **The readout printed `TEST · 45719` in its `site` column the whole
time** — the fact was on screen and was read past.

- **THE ARGUMENT FOR "REAL" IS EXACTLY INVERTED, AND THAT IS THE REUSABLE PART.** §23 says
  *"it carries a `user_id` and a real campground"*. `rc-test-hold.mts:240` **copies both from
  a real watch by construction**, so every test hold has them. The property offered as
  evidence of being real is produced by the thing it was meant to rule out.
- **The discriminator is `unit_name`.** Real holds carry RC's own site label — the two
  genuinely real rows in the same table read `#W123` and `#W121`, on different user ids, and
  both expired unclaimed. A `TEST · ` prefix is unambiguous.
- **CLAUDE.md ALREADY DOCUMENTS UNIT 45719 AS A SYNTHETIC HOLD**, twice, from 2026-08-13:
  *"A synthetic hold from `rc-test-hold.mts` (South Carlsbad #35, unit 45719, arrival
  2026-12-01)"*. The same unit, the same script, the same arrival date, ten days earlier. The
  file contained its own refutation.
- **WHY IT MATTERS, and it is not bookkeeping.** For a day the SERIAL rules in
  `docs/LANES.md`, the update-window decisions and the "keep #146 away from a release" caution
  were all being applied on the belief that a **stranger was waiting on this campsite**. They
  happened to be the conservative calls, so nothing was lost — this is a correction, not an
  incident.
- **"FIXTURE" DOES NOT MEAN "HARMLESS", AND THE NEXT ONE PROVES IT.** `rc-test-hold.mts` is
  built to take a REAL numeric unit id — that is what exercises the whole chain — so a
  `TEST · ` hold **locks a real campsite** for as long as it is held. Unit `45719` was real;
  so is `43129`, queued 21:12Z for 2026-08-24 07:58:47 PT to manufacture a ramp for Track A
  (#176). What a fixture changes is that **nobody is waiting on the other end**, not that
  nothing is at stake. The distinction is the reason the script insists on a far-future
  midweek date.
- **STILL UNCORRECTED ON MASTER** as of `d8d035e`: `CLAUDE.md:2663` and
  `docs/NEXT-SESSION.md:126` both say *"hold `45719` carted at T+1.6s"* with no fixture
  marker, and #167's title and §23 above assert it outright. **Main lane's files** — filed as
  an issue so it is not re-derived.

### 24b. THE RAM GUARD DID NOT FIRE ON EITHER OF THE TWO BIGGEST RAMPS

Both ramps in the last 30 hours, from `chromium_memory_samples`:

| | window (PT) | peak `rc` | free RAM at peak | COMMIT | ramping pid |
|---|---|---|---|---|---|
| A | 08-22 23:12→23:23 | 8,983 MB | **3,191 MB** | 82% | 10364 |
| B | 08-23 07:31→07:41 | **9,180 MB** | **3,328 MB** | **88%** | 5296 |

The guard is `stalledMs > MEM_STALL_MS && freeMb < LOW_RAM_MB` — **an AND** —
with `LOW_RAM_MB = 2000` (`rc-keepwarm.mjs:470`) and `MEM_STALL_MS = 60_000` (`:480`).
**Free RAM never came within 1,190 MB of the floor on either.** `os.freemem()` was calibrated
against the PowerShell sampler to within 3.5% on 2026-08-18, so a 60% gap is not a reading
error. The stall half is unknown from here and does not matter: the AND already fails.

**SO SOMETHING ELSE ENDED THEM, AND THE SERIES SAYS IT WAS A BROWSER REPLACEMENT.** Not a tab
close and not an in-place drain — the **`gpu-process` pid changes across both events**
(6464 → 2824 on A, 2824 → 2348 on B), and that process is one per browser:

```
14:29:05  rc   303 MB  free 9,680  16%   pid 2824 gpu-process
14:31:06  rc 3,278 MB  free 5,960  76%   pid 5296 renderer      <- T-28.7, maybeAutoLogin
14:41:07  rc 9,180 MB  free 3,328  88%   pid 5296 renderer      <- renderer 8,245 / browser 768
14:41:58  rc   282 MB  free 9,658  16%   pid 2348 gpu-process   <- different browser
```

CLAUDE.md's #172 entry already says of ramp B that *"the browser had just been recycled"*, so
the recycle itself is known. What is not recorded anywhere is that **the containment arm was
not what did it**, and the consequence below.

**THE 08-19 PREMISE HAS MOVED, AND THAT IS THE QUESTION — not that the floor is wrong.** The
floor was set deliberately, with the arithmetic written down:

> *"2000 acts at about 73% — seventeen points of margin — while leaving room for a renewal
> whose worst observed peak is 5,688 MB against a ~9,000 MB idle, i.e. **a trough near
> 3,300 MB**."*

Observed troughs: **3,191 and 3,328 MB.** The prediction is essentially exact, and the guard is
behaving precisely as designed — it was set below the expected trough so a working renewal
could not be killed, which was the whole point of the 4000 → 2000 change.

What has moved is the peak. **5,688 MB was the worst case that reasoning was built on; it is
9,180 MB now, 61% higher, and COMMIT reached 88%** — against the same entry's *"the numbers
that matter are ~90% (Windows stops scheduling)"*. Two points. And the neighbouring claim
that *"the containment has now held THREE times ... never past 71% COMMIT"* is stale: nothing
held these, and 88% is seventeen points past that.

- **THIS IS A QUESTION FOR THE MAIN LANE, NOT A PATCH.** `keepwarm-recycle.test.mts` bounds the
  floor 1500–3000 with recorded reasoning, and lowering the trip point is exactly the change
  that killed a working repair on 08-19. The honest options differ in kind — leave it and rely
  on the recycle, or give the arm a second trigger that is not free-RAM — and neither is a
  drive-by.
- **WHAT WOULD SETTLE WHAT ENDED THEM:** a `♻ recycling` line in `logs\rc-keepwarm.log` at
  14:41:5x. The post-Okta recycle (`visitedOkta`) is the leading **candidate** for B; ramp A
  coincides with the box update at 23:12 PT, so a `stop-all` is the likelier cause there. Both
  are candidates. Reading the log needs a `tail-log` bot command, which this pass did not run.
- **#169 IS NOW ON THE BOX**, so ramp #23 gets a native-allocation reading. That answers *what
  allocates*; it does not answer *what stops it*, which is this section.

### 24c. The Play production application is written up — `docs/PLAY-STORE.md` §0c

The 08-22 handover recorded it as *"not yet written into `docs/PLAY-STORE.md`; offered, not
confirmed."* Now written, including the pointer on §0 whose *"≥14 days out"* heading and
*"(0 currently)"* tester count were both spent.

**One gap is recorded rather than papered over:** that session verified the paid tester
vendor's answer sheet and found **three of its four claims false**, and *which* claims was
never written down. It is not in any file or commit. If Play asks a follow-up, that analysis
has to be redone.

### 24d. What the main lane closed while this was being written

Four of the six items this pass proposed were done by the main lane between 20:37 and 20:59
UTC, i.e. under it. Recorded so the ordering is honest:

- **#171 merged** — both app fixes, plus a fourth defect found inside FIX 2
  (`window.__camphawkRcToken` is never set in a webview, so a sign-in that WORKED reported
  failure). CLAUDE.md 2026-08-23.
- **#146 merged**, and the worker verified healthy after the deploy rather than assumed.
- **#168 closed as superseded**, with the reasoning left on the PR.
- **The box updated to `6d4100b`** at 20:41 UTC, *"updated and verified"*, 23 seconds.

So of the six, **2, 4 and 5 were theirs**; 1, 3 and 6 are the ones above.

---

## Handover — 2026-08-23 evening (side lane)

*Supersedes the afternoon block written an hour earlier, which held nothing but state readings
that have since moved. Every figure below was read fresh at **14:39 PT**, not remembered.*

---

### START HERE: a hold releases tomorrow at 07:58:47 PT, and it is an INSTRUMENT

```
TEST · 43129   Morro Bay SP — Lower Section (rc-582)   arrival 2026-12-01
requested      release 2026-08-24 07:58:47 PT          queued 21:12:47Z by the main lane (#176)
```

**IT IS NOT A PRODUCT TEST. IT WAS QUEUED TO MANUFACTURE A RAMP.** Track A's native
allocation sampler has never had a real ramp to read. A queued hold opens the T−3h warm-up
window at **~04:58:47 PT** with Okta **gone**, which forces the expensive password sign-in —
the 12-minute, ~9.4 GB Okta trip. That trip is the *point*.

- **SO A 9 GB RAMP TOMORROW MORNING IS THE DESIRED OUTCOME, NOT AN INCIDENT.** Do not open the
  memory series at 08:00, see `peak_rc 9,180 / COMMIT 88%`, and write it up as the leak
  recurring. It is the experiment running. The leak is still unfixed and still the standing
  ask, but tomorrow's ramp is one somebody ordered.
- **EXPECTED, AND DELIBERATELY STATED AS A PREDICTION.** The big trip should land at **~04:59
  PT** (warm-up, Okta gone), and the T−30 sign-in at 07:28:47 should then be the cheap
  cookie-answered kind because the warm-up left an Okta session behind. **Check where it
  actually landed rather than assuming** — the 08-22 handover predicted a quiet morning on
  exactly this kind of reasoning and was falsified by a 9,180 MB ramp at T−30 (§24b).
- **Read the result out of Postgres, not the log:**
  `NODE_USE_ENV_PROXY=1 npx tsx scripts/native-alloc-readout.mts`.
  **"No readings yet" is a real answer** — it means the trip did not ramp, not that the
  sampler is broken. It reads 0 rows right now and that is correct: the box only took #169 at
  13:41 PT and there has been no ramp since 07:41 PT.
- **IT LOCKS A REAL CAMPSITE.** `rc-test-hold.mts` takes a real numeric unit id by design —
  that is what makes the warm-up see it (`nextHoldRelease` carries `REAL_UNIT`, so a sentinel
  is invisible). Far-future midweek, so nobody is competing for it, but it is a real site.
- **THE `docs/LANES.md` SERIAL RULES BIND UNTIL IT CLEARS.** Do not queue a second hold, do not
  run `npm test` locally, and keep anything that restarts the box away from it. The updater's
  6h release gate shuts at **01:58:47 PT**; a *requested* update lifts the quiet window but
  never that gate.

**The second thing tomorrow can produce, and it needs a human.** #171 shipped the hand-off
landing IN the cart and reading the cart back, and **neither has run against a real hold** —
only against the served bundle in a stub page. `scripts/rc-holds-readout.mts` prints
`cart read back` when it happens. That only fires if somebody opens the claim link **in the
app**; from a browser `canInject` is false and it tests nothing. Nobody in a session can do
this. Ask the owner; do not investigate its absence.

---

### State, read 14:39 PT

| | |
|---|---|
| Master | `d8c64bb` |
| Mini-PC | `6d4100b` — `autocart.bot_version` reads *"No bot-side code in the gap"*, i.e. current in the only sense that matters |
| Open PRs | **none** |
| Open holds | **one** — the instrument above |
| Health | `degraded`, **every failure non-paging** |

- **`autocart.rc_session` warn** — *"no token at all — signed out; okta session STILL ALIVE —
  the silent renew is failing, not the login"*. That is the known pathology (the seven-day
  stale token comes from the server, 08-22), **not a new fault**, and with Okta alive the
  repair is the cheap kind. `autocart.bot`, `rc_runner`, `watchdog`, worker, both shards, all
  five detectors and delivery are `ok`.
- **Login rehearsal PASSED 03:01 PT** (`load/shoppingcart → HTTP 200`). That is the standing
  evidence the bot can still sign itself in.
- **THE OKTA CAP IS FROZEN — corroborated a third and fourth time this session.**
  `okta_expires_at` read `2026-08-24T03:00:59Z` at **20:27:37Z** and again at **21:37:14Z**,
  seventy minutes apart, unmoved; #176 had already read it twice 33 minutes apart. So it is
  the **absolute cap**, not the rolling idle window our own probe refreshes. It expires
  **~20:01 PT tonight**, which is what leaves Okta gone for the 04:59 warm-up.
- **No ramp since 07:41 PT.** Hourly peaks 13:00–21:00 UTC are 305–476 MB, flat.

---

### What the previous session (this one) did

Six items were proposed; **the main lane did three of them underneath the report** between
20:37 and 20:59 UTC — merged #171 and #146, closed #168 as superseded, and updated the box.
The other three landed as **PR #173** (`d8c64bb`, docs only, `verify` green):

- **§24a** — the 2026-08-23 hold was a **test fixture**, not a real user's, and §23's argument
  for "real" was inverted. Struck in place. Filed as **#174**.
- **§24b** — **neither 9 GB ramp tripped the RAM arm**; free RAM bottomed at 3,191/3,328
  against a 2,000 floor, and a browser replacement ended both. Raised as a question about the
  floor's premise, not a patch. Filed as **#175**.
- **§24c / `docs/PLAY-STORE.md` §0c** — the Play production application, submitted 2026-08-22
  and never written up, plus the gap that the vendor answer sheet's three false claims were
  never recorded.

---

### Open

- **#174** and **#175** — this session's two findings, both corrections to **main-lane files**
  and theirs to fold. Left as issues precisely so they are not re-derived.
- **#76** — `rc-holds.test.mts`'s fixture sweep deletes a concurrent run's live rows.
- **#14** — rec.gov timeout cascade.
- **A CI run can still turn `autocart.rc_session` RED.** The health route carries its own
  inline `upcoming`/`imminent` counts that never got the `REAL_UNIT` filter, so test fixtures
  are visible to it. Bounded to the length of a run, and it prints the destructive
  `rc-login.bat` remedy while it lasts. Main lane's find (CLAUDE.md, 08-23), recorded not fixed.
- **The live manage token `EQO2oXcQ`** — still unrotated, still returns 200 with the owner's
  real watch. In git history, so scrubbing files is insufficient; rotation is one DELETE from
  `action_tokens`. **Owner's call — not acted on, three sessions running.**
- **iOS `1.0 (5)`** — awaiting a decision, same binary, rewritten notes. Release is
  **AUTOMATIC** on approval, so you may find out it shipped by seeing it on the App Store. A
  3.1.1 rejection now is the real answer and moves the decision to StoreKit.

---

### Traps that fired, and one that did not

- **`applied_note` and `applied_sha` describe DIFFERENT events**, and the note points either
  way. **`git-status` through `bot_commands` is the only thing that answers "did it land?"**;
  `bot_commit` is COALESCEd and can sit stale beside a live heartbeat.
- **A requested update LIFTS the quiet window.** Only the 6h release check is unliftable.
  Three separate write-ups got this wrong with the guard source open.
- **Read the readout's `site` column.** `TEST · ` in `unit_name` is written only by
  `rc-test-hold.mts` and is the one unambiguous fixture marker — it was on screen for a day
  while three documents called the hold real (§24a).
- **`claimed` in the readout is `claimed_at ?? released_at`.** A time there does not mean the
  hold was claimed; `released` is the successful terminal state and `claimed` is a distinct
  later one.
- **A health reading goes stale faster than a conclusion drawn from it.** Master moved twice
  during this session — once *between* the report and acting on it, once *between* the push
  and the merge. Re-read before quoting.
- **Do not run `npm test`** — production DB, serialized between lanes. CI runs it for you on
  every push, which is itself the fixture-red window above.

---

### Side lane hygiene

On `claude/camphawk-side-lane-status-mnsbld`, reset to master and clean. **The branch name does
not match `docs/LANES.md`'s `claude/side-<topic>` convention**, and the branch name IS the lane
token — worth correcting on the next side session rather than mid-flight.

This file is continued rather than replaced. §24 corrects §23 in place, and a correction living
in a different file from the claim it corrects is how the Feature E note got re-derived three
times.

---

## 25. THE ROUTINES WERE CONSOLIDATED — 7 to 4, AND TWO WERE DUPLICATES NOBODY HAD NOTICED

*Side lane, 2026-08-23 evening. The owner's report: "none of them fire back to a session we are
still using, a lot flag red a lot and I'm guessing they are stale and crying wolf." All three
halves of that were correct, and the duplication was visible in the Routines list itself.*

### 25a. TWO EXACT DUPLICATE PAIRS, FIRING THE SAME CRON MINUTE

| kept / rebuilt | duplicate, created 2026-08-13 |
|---|---|
| `trig_015nU7…` RC runner pre-flight, `40 14 * * *` | `trig_01DHDm…` "07:40 PT pre-flight", `40 14 * * *` |
| `trig_01KvxP…` RC 8am hold — did it cart?, `15 15 * * *` | `trig_01SygA…` "RC 08:15 PT outcome", `15 15 * * *` |

The two duplicates were created **two minutes apart** (12:38:52 and 12:40:25) by one session
that did not know the originals existed — **and CLAUDE.md documents both originals by ID**, in
the "Two Routines cover this daily" block. So every morning alert had been arriving twice for
ten days, from a pair of routines the repo's own memory file already named.

**This is §24a's shape one level out**: the fact was on screen (two identical cron expressions
in the Routines list) and was read past, while the authoritative record sat in a file nobody
re-checked before creating.

### 25b. `created_via` DECIDES WHAT AN AGENT MAY TOUCH — AND IT IS NOT VISIBLE IN THE UI

Both duplicates were `created_via: "http_api"`, i.e. made through the claude.ai Routines UI.
**An agent can neither delete nor disable those.** Both calls are refused outright:

```
delete_trigger: this routine was created via "http_api", not by an agent. Agents can only
delete routines they created (via create_trigger), or a routine may delete itself from its
own session.
update_trigger: … A routine's own session may still disable itself (enabled=false only).
```

Only `created_via: "meta_mcp"` routines — the ones an agent made — are agent-editable. **So the
set of routines an agent can INVENTORY is not the set it can ACT on**, and nothing in the list
view distinguishes them. Budget for the owner having to delete UI-created routines by hand; say
so up front rather than discovering it halfway through a consolidation. (The owner deleted both
on request, confirmed by re-listing.)

### 25c. TWO FIELDS ARE CREATE-ONLY, SO "EDIT THE ROUTINE" IS OFTEN "REPLACE IT"

`update_trigger` accepts only `name`, `prompt`, `cron_expression`, `run_once_at`, `enabled` and
`model`. It **cannot** change:

- **`notifications`** — so adding push to an existing routine needs a delete+recreate.
- **`persistent_session_id`** — so binding a routine to a session, or RE-POINTING one at a new
  session, also needs a delete+recreate.

That is why two trigger IDs changed in this pass, and it is the part with an ongoing cost: when
CampHawk-Main is replaced, the 08:15 routine cannot be edited to follow it. It has to be rebuilt.

### 25d. PUSH AND IN-SESSION ARE MUTUALLY EXCLUSIVE — the design constraint

**The server rejects `notifications` on any routine bound to a session** (self-bind or
`persistent_session_id`); they are accepted only for `create_new_session_on_fire`. So a routine
either reaches the phone **or** lands in a conversation someone is reading. Never both.

The split taken, and the reasoning:

- **The 07:40 pre-flight KEEPS push** and stays a fresh session. Its entire product is reaching
  a human with twenty minutes in which a hold can still be saved. A finding that lands silently
  in a conversation at 07:40 is worth nothing.
- **The 08:15 outcome is BOUND** to CampHawk-Main. Nothing can be saved by then — it is a
  post-mortem — so being read matters more than being pushed.

**A bound routine dies with its session, silently.** The evidence was already in the list: the
dead `send_later` from 08-11 carries `ended_reason: auto_disabled_session_gone`. Against that,
the Wheel routine has been bound to `session_01AZmkidxhboQaFN6TDBex2q` since **2026-08-03** and
last fired **08-21**, so binding is durable exactly as long as the session is. **The failure mode
is a self-disable with no alarm** — the same shape as the Windows Scheduled Tasks that stopped on
2026-08-17 and wrote nothing, and the same reason it is recorded here rather than trusted.

### 25e. THE NIGHTLY OPS REVIEW WAS GUARANTEED TO REPORT FALSE PROBLEMS — DISABLED

`trig_01GRLZ…`, cron `7 14 * * *` (07:07 PT). Its prompt is dated **2026-07-28** and two of its
checks describe a world that no longer exists:

1. *"Feature E accrual … Healthy is ~1,000 rows/hr across ~502 probe targets."* Feature E was
   **fully stopped 2026-07-30** — all 502 `probe_targets` rows are `active = false` and
   `PROBE_ENABLED` is `"false"`. It reported a catastrophic-looking zero **every night, by
   design.**
2. *"Expect EXACTLY ONE machine started and one stopped."* **Sharding went live 2026-08-02 at
   `SHARD_COUNT = 2`** — two machines in iad, both running, `min_machines_running` tracking it.
   The CORRECT state tripped this check nightly.

It also still authorises itself to *"commit and push such fixes to master"*, which
`docs/LANES.md` (2026-08-15) forbids outright and `.claude/hooks/push-guard.mjs` would block.

**DISABLED, not deleted**, so the run history and the prompt survive for whoever rewrites it.
Note it still shows a `next_run_at` — that is a stale computed field, not an armed schedule.

### 25f. THE HEALTH WATCH HAD INHERITED THE CI FIXTURE RED, WITH THE DESTRUCTIVE REMEDY ATTACHED

It fired **every 2 hours, push AND email**, and its prompt was otherwise good — it already said
to stay silent when green. What made it cry wolf was the 08-23 finding it did not know about:
the health route's own inline `upcoming`/`imminent` counts never received the `REAL_UNIT`
filter, so **any CI run turns `autocart.rc_session` red** citing *"4 hold(s) ahead and the next
is within 25 min"*, and the detail prints `mini-pc\rc-login.bat` — **which force-kills the
Chromium the live RC token lives in.** Every merge fires CI. Twelve chances a day to send
somebody to destroy a healthy session.

Cut to **every 6 hours** and the prompt now carries three named rules, each for a false alarm
that has actually happened:

1. **UNREACHABLE IS NOT DOWN** — HTTP 000 or a proxy 403 to CONNECT is the sandbox network
   policy. Verified 2026-08-23: camphawk.app, `*.supabase.co` and fly.io were ALL 403 at the
   gateway while the site was fine. Report "could not check — egress blocked", never an outage.
2. **A `rc_session` fail citing N holds may be FIXTURES** — re-check two minutes later, and
   never print `rc-login.bat` on that basis. A real hold carries RC's own label (`#W123`); a
   fixture's `unit_name` starts `TEST · `.
3. **`rc_session` warn/dead is usually CORRECT** — the token lives ~60 minutes.

The same three went into the new pre-flight prompt, and the fixture rule plus §24a's `TEST · `
marker and the `claimed = claimed_at ?? released_at` trap went into the new outcome prompt.

### 25g. THE CART CANARY WAS FIRING AT THE RELEASE MINUTE

`trig_012s8e…` ran at `0 15 * * *` = **08:00 PT exactly** — the minute the runner is carting and
the box is under load. Moved to **14:00 PT** (`0 21 * * *`). Nothing else changed; it remains a
genuinely valuable check that RC has not altered the cart internals the design depends on.

**Its double-notify was NOT fixed**: the routine carries push+email AND the script itself emails
the owner via `--notify`, so one failure arrives twice. Removing the routine-level notification
needs a delete+recreate (25c), which was not worth spending on a cosmetic duplicate.

### 25h. THE END STATE

| Routine | Fires (PT) | Reports to |
|---|---|---|
| `trig_01NdJC1SvSDwxZZroAooVKnU` RC pre-flight | 07:40 | **phone** — push + email |
| `trig_01CzPKmDUz5MC3tbYFGMTS4a` RC 08:15 outcome | 08:15 | **CampHawk-Main**, bound |
| `trig_01Vmg72qxMMSucjfUERr8rYv` health watch | 23:12 / 05:12 / 11:12 / 17:12 | phone, faults only |
| `trig_012s8ekj1nEjoQTdRY21PGRM` cart canary | 14:00 | phone, failures only |
| `trig_01GRLZziuYX38yrYgf2Eq4UA` nightly ops review | — | **DISABLED** |

`trig_01HqLPXsYHF7yBG9GmXe8GCV` (Wheel check-ins) is not CampHawk and was not touched.

Notification volume: **~14 pushes a day down to at most 4 scheduled fires**, three of which are
silent unless something is genuinely wrong. And the morning sequence no longer collides — it was
07:07, 07:40 x2, 08:00 and 08:15 x2 inside seventy minutes.

### 25i. DOC DRIFT THIS PASS CREATED, IN A MAIN-LANE FILE

**CLAUDE.md's "Two Routines cover this daily" block names `trig_015nU7BciNU5GKimmgXjvAZG` and
`trig_01KvxPSzmrwKHZ8CY3tDgbnj`. Both are now DELETED**, replaced by `trig_01NdJC…` and
`trig_01CzPK…` respectively. Filed as an issue rather than edited, per the one-writer rule.

**And CampHawk-Main was never told** that a routine now fires into its session at 08:15.
`ListAgents` reports no reachable peers across cloud containers, so `SendMessage` could not
deliver. Whoever reads this next should say so to that session.

### 25j. AN OPEN HYPOTHESIS WORTH ONE COMMAND

**The routine-fired sessions may share this container's egress block.** The health watch runs in
`env_01NNXGWqS3cK1KTqhy4dH3JF` — the same environment as this session, which cannot reach
camphawk.app, supabase.co or fly.io — and it last fired at 02:12:32Z, two minutes after this
session started and found them all blocked.

If routine sessions are also getting HTTP 000, **a share of the red flags were never about
CampHawk at all** and the fix is the egress policy, not any routine. The prompts now refuse to
report a 000 as an outage either way, so the failure direction is safe. But it is untested, and
the cheap test is to read what the next health-watch firing actually says.

---

## Handover — 2026-08-23 night (side lane)

*Supersedes the evening block above for STATE only; its §25 and the "START HERE" hold entry
still stand. Read at 20:40 PT.*

### START HERE: the hold releases at 07:58:47 PT and it is an INSTRUMENT

Unchanged from the evening block — **read it there in full.** The one-line version:
`TEST · 43129`, Morro Bay SP — Lower Section, releases **2026-08-24 07:58:47 PT**, queued by the
main lane (#176) **to manufacture a ramp for Track A**. The T−3h warm-up opens **~04:59 PT** with
Okta gone, forcing the ~9.4 GB password Okta trip. **A 9 GB ramp tomorrow morning is the ordered
outcome, not an incident.** It locks a real campsite; the LANES.md SERIAL rules bind until it
clears; the updater's 6h release gate shut at 01:58:47 PT.

**Its status could NOT be re-read tonight** — see the environment note below. The last reading
was `requested` at 14:39 PT.

### THE ENVIRONMENT BLOCKED EVERY LIVE READING — VERIFY YOURS BEFORE DIAGNOSING

```
camphawk.app/api/health/status  ->  000
supabase.co                     ->  000
api.github.com                  ->  200
```

The agent proxy names it itself: `curl -sS "$HTTPS_PROXY/__agentproxy/status"` lists
`connect_rejected · "gateway answered 403 to CONNECT"` for `camphawk.app:443`,
`mraeprivokvmxbvhwbbj.supabase.co:443`, `fly.io:443`, `mcp.vercel.com` and `mcp.sentry.dev`.
`selective: false`, `toolScoped: false` — a blanket policy. The proxy README says explicitly not
to retry a 403 but to report it.

**CampHawk is not down. It could not be looked at.** Both readouts were run and died on the
network rather than on logic (`DB query error: TypeError: fetch failed`), so no hold status, no
health, no memory series this session. `/rc-status` fails the same way. **Check your own egress
first**, and never report an outage from a 000.

### State — GitHub-only, read 20:40 PT

| | |
|---|---|
| Master | `8cbff92`, identical on origin and locally |
| Open PRs | **none** (before this branch's) |
| Open issues | **#175, #174, #76, #14** — unchanged |
| Mini-PC | `6d4100b` as of the 14:39 PT reading; **not re-verifiable tonight** |

**Three open findings were re-verified in source**, since live state was unavailable:

- **#175 stands** — `rc-keepwarm.mjs:2241` is still `stalledMs > MEM_STALL_MS && freeMb <
  LOW_RAM_MB`, an AND, with `LOW_RAM_MB = 2000` (`:470`) and `MEM_STALL_MS = 60_000` (`:480`).
  Free RAM bottomed at 3,191 / 3,328 MB on the two 9 GB ramps, so the arm still cannot fire.
- **#174 stands** — `CLAUDE.md:2663` and `NEXT-SESSION.md:126` still call hold `45719` a real
  morning, while `CLAUDE.md:4608` and `:4697` call the same unit synthetic.
- **The fixture red stands** — `REAL_UNIT` exists only in `src/lib/rc-holds.ts`; the health
  route's own `upcoming` count is `status IN (…) AND release_at >= now`, unfiltered.

`LINKOUT_BY_STORE` is `{ios: true, android: false}`, as documented.

### What this session did

**Consolidated the Routines, 7 to 4 — §25 above is the write-up.** Nothing in the repo changed
except this notes file; no code, no migrations, no bot commands, nothing on the box.

The reusable parts, in case §25 is too long to read at 07:30: `created_via: "http_api"`
routines cannot be deleted OR disabled by an agent (the owner removed both duplicates by hand);
`update_trigger` cannot change `notifications` or `persistent_session_id`, so those edits are
delete-and-recreate; and **push and in-session reporting are mutually exclusive** — the server
rejects notifications on any bound routine.

### Open

- **#174, #175** — main lane's to fold, deliberately left as issues.
- **CLAUDE.md names two deleted trigger IDs** (§25i) — filed as an issue this session.
- **CampHawk-Main has not been told** a routine now fires into it at 08:15 (§25i).
- **#76** — `rc-holds.test.mts`'s fixture sweep deletes a concurrent run's live rows.
- **#14** — rec.gov timeout cascade.
- **A CI run can still turn `autocart.rc_session` RED**, printing the destructive
  `rc-login.bat` remedy. Bounded to the length of a run. Recorded, not fixed.
- **The live manage token `EQO2oXcQ`** — still unrotated, still in git history. **Owner's call,
  four sessions running.**
- **iOS `1.0 (5)`** — awaiting a decision, same binary, rewritten notes. **Release is AUTOMATIC**
  on approval. A 3.1.1 rejection now is the ANSWER, not a fourth process failure.
- **The leak is not fixed and remains the standing ask.** Everything shipped is containment or
  relocation.

### Traps, including one new one

- **`created_via` is invisible in the Routines UI** and decides whether an agent can act. Do not
  promise a routine cleanup before checking it. **NEW this session.**
- **Read the readout's `site` column** — `TEST · ` is the one unambiguous fixture marker.
- **`claimed` in the readout is `claimed_at ?? released_at`** — a time there does not mean
  claimed. `released` is the successful terminal state.
- **A health reading goes stale faster than a conclusion drawn from it.**
- **Do NOT run `npm test`** — production DB, serialized between lanes, and a hold is queued.
- **The branch name IS the lane token**, and `claude/camphawk-side-lane-status-iij2xm` still does
  not match `docs/LANES.md`'s `claude/side-<topic>`. Third session running. Worth fixing at the
  START of a side session, never mid-flight.


---

> **STATUS CLAIMS IN THIS SECTION ARE SUPERSEDED BY §28.** The fix shipped the same day
> (#183, `d842dc0`, 14:36 PT) and BOTH defects are addressed. The measurements below stand;
> "recorded, not fixed" does not. Read §28 before quoting any of this as current.

## 26. A PARK WATCH SENT 52 MESSAGES IN AN HOUR — `rc_hold_notified_for` IS ONE COLUMN FOR N DIVISIONS

*Side lane, 2026-08-24 midday. Reported by the owner as "Melinda got six texts for her Morro
Bay watch." It was 52, it was still firing when it was reported, and it is the failure the
park-watch entry in CLAUDE.md predicted in as many words: "Watch for a duplicate or missing
alert on that watch specifically."*

~~**MAIN LANE: both bugs below are in `worker/poller.ts` and the fix for the first is a
migration. Recorded here rather than fixed. The live flood is stopped by a DATA change.**~~

**STRUCK — BOTH BUGS WERE FIXED AND DEPLOYED THE SAME DAY. SEE 26h.** The main lane shipped
`d842dc0` (#183) at **14:36 PT**, roughly two hours after this was written: migration 067 plus
`worker/hold-claim.ts`. Read 26h BEFORE acting on anything below, and do not go looking for an
unfixed defect in `worker/poller.ts` — `claimHoldNotification` no longer lives there.

### 26a. THE MEASUREMENT

```
watch 336d742c…  melinda.flores0501@yahoo.com  active
  divisions: rc-2185 Morro Lottery · rc-582 Lower Section · rc-583 Upper Section
  rc_hold_notified_for = 'rc-583|2026-8-25T8'     <- ONE value, three claimants

coming_soon, 11:40 → 12:42 PT (62 minutes):
  rc-2185   12 SMS + 12 email
  rc-583    12 SMS + 12 email
  ------------------------------------------------
  52 messages, ALL for site 43191, ALL for one release (Aug 25 08:00)
```

Every ~5 minutes (`RC_HELD_CHECK_DEFAULT_MS = 300_000`), two divisions each. The release was
**19 hours away**, so the run rate projected to **~460 more SMS and ~460 more email to one
person** — against a Sole Proprietor A2P campaign capped near 1,000 segments/day to T-Mobile.
This was a carrier-filtering risk, not merely an annoyance.

### 26b. ROOT CAUSE — THE NAMESPACING TURNED "FIRST WINS" INTO A ROUND-ROBIN

`loadWatches` expands a park watch to **one row per (watch, campground)**. But
`rc_hold_notified_for` is **one column on the one `watches` row** (`worker/poller.ts:700`):

```sql
UPDATE watches SET rc_hold_notified_for = $2
 WHERE id = $1 AND active = true AND rc_hold_notified_for IS DISTINCT FROM $2
```

with `key = scope.multi && scope.campgroundId ? `${campgroundId}|${hour}` : hour`.

So per cycle:

```
rc-2185 : key 'rc-2185|H'  vs stored 'rc-583|H'   -> DISTINCT -> ALERT -> stores its own
rc-583  : key 'rc-583|H'   vs stored 'rc-2185|H'  -> DISTINCT -> ALERT -> stores its own
[5 minutes later, both again, forever]
```

**A single-valued column cannot hold N division markers.** The namespacing was added to stop
one division *silencing* another — the comment above it says exactly that — and it kept the
keys apart while leaving them sharing one slot. It converted a suppression bug into an
amplification bug, which is strictly worse: the first is a missed alert, the second is a
carrier ban.

**THE SHAPE IS MIGRATION 026 EXACTLY.** The alert claim had this identical defect (one
timestamp per WATCH) and was fixed by moving to a row per (watch, site). This column needs the
same move — a row per (watch, campground) — or a JSON map keyed by campground. Either is a
migration on the release-critical alert path.

**PING-PONG REQUIRES TWO OR MORE DIVISIONS EACH FINDING A HELD UNIT.** That is what makes it
rare and is why the path survived since migration 070 without firing. See 26d.

### 26c. SECOND BUG — TWO DIVISIONS RETURNED THE SAME UNIT

`rc-583` and `rc-2185` both reported **site 43191**, labelled **"Site #96"**. Ninety-six sits
inside Upper Section's own 86-140 range and has no business appearing under "Morro Lottery
sites". So the per-division grids are not filtering to their own units.

**FIXING 26b ALONE STILL LEAVES TWO ALERTS FOR ONE SITE.** They are separate defects and the
second is not cosmetic — it is the reason a two-division park could ping-pong at all.

### 26d. WHY THE OTHER PARK WATCH DID NOT FLOOD — evidence, not reassurance

`eb886697…` (tylerflores1992@gmail.com) is also a park watch: **rc-582 + rc-583**, marker
`rc-583|2026-8-25T8`. It alerted **once** at 12:47:16 across three channels and did **not**
repeat at 12:52.

The discriminator is in the data: **`rc-582` produced ZERO coming_soon in 24 hours.** With only
one producing division there is nothing to ping-pong against — it claims, the marker matches on
the next cycle, silence.

- **THAT IS A LIVE CONDITION, NOT A PROPERTY.** If any Lower Section site is locked before the
  release, this watch starts ping-ponging immediately — and at **3 channels x 2 divisions x 12
  cycles ≈ 72 messages/hour**, worse than Melinda's, because push is enabled on it.
- Only **two** active park watches exist. There is no third exposure.

### 26e. THE STOPGAP — a DATA change, reversible, owner-approved

Melinda's watch trimmed to the single division whose site range actually contains #96:

```sql
DELETE FROM watch_campgrounds WHERE watch_id='336d742c…' AND campground_id <> 'rc-583';
UPDATE watches SET rc_hold_notified_for='2026-8-25T8' WHERE id='336d742c…';
```

`multi_campground` is derived — `(COALESCE(array_length(e.ids,1),1) > 1)` — so one row makes it
false, the key becomes the bare hour, and the marker was pre-set to that bare hour so it settles
**without one final alert**. Verified through the poller's own expansion: one row, `rc-583`,
`multi=false`.

**SHE KEEPS the 08:00 availability alert for #96** and loses Lottery/Lower coverage until the
real fix ships. Re-adding two rows restores it. `watches.campground_id` is still `rc-582`; that
is the FALLBACK representative and only applies when the division list is empty, so it is
harmless — but do not read it as the division being polled.

### 26f. THE VERIFICATION WAS WRONG FIRST, AND THAT IS THE REUSABLE PART

The first check asked "any coming_soon in the last 12 minutes?" on a **5-minute cadence**, so it
necessarily swept up pre-fix rows and printed **`STILL FIRING — 4 in last 12 min`** over a fix
that had worked. All four were timestamped 12:42:18, before the change.

**A window wider than the interval you are testing cannot answer a before/after question.**
Re-anchored strictly after the fix: `count since 12:43 = 0`.

**AND SILENCE MEANS TWO THINGS.** "The claim held" and "the poller died" write the identical
row count. The discriminator was that the **12:47 cycle demonstrably ran** — it alerted a
DIFFERENT watch in that same cycle — plus `poller.shards 2/2 held` and
`availability_observations` advancing at 12:45:42. Never report a flood as stopped on absence
alone.

### 26g. WHAT NOBODY HAD MEASURED, AND WHY IT WENT UNNOTICED FOR AN HOUR

Nothing anywhere counts alerts **per watch**. Every suppression in `worker/claim.ts` is per
(watch, site) — `RENOTIFY_WINDOW`, `CONTINUOUS_GAP`, `NUDGE_AFTER` — and `claimHoldNotification`
is per (watch, release hour). A watch emitting 52 messages an hour trips no threshold, appears
on no health check, and pages nobody. **The owner's phone was the monitoring.**

A per-watch burst ceiling — N alerts per watch per hour, then a digest — would have capped this
at source regardless of which claim was broken. That is a product decision on the most
safety-critical path in the repo, so it is recorded, not built.

### 26h. CORRECTION — FIXED AND DEPLOYED THE SAME DAY, AND THEIR FIX IS BETTER THAN MINE

**Written 2026-08-24 21:30 PT, correcting this section's central claim.** Everything above about
the mechanism and the measurement stands. What is wrong is the disposition: 26a-26g say the
defects are recorded-not-fixed and that the remedy is a future migration. **Both were fixed and
deployed on 2026-08-24.**

```
11:40 - 12:42 PT   the flood (52 messages)          <- measured in 26a
12:43 PT           side lane trims Melinda's watch  <- the flood stops
14:36 PT           d842dc0 (#183) committed         <- the REAL fix, main lane
```

**THE TRIM WAS STILL LOAD-BEARING, AND THE ORDER PROVES IT.** The fix landed nearly two hours
after the flood stopped, so the stopgap is what ended it — this is not a case of crediting a
repair to the wrong mechanism. But everything written afterwards about the defect being live was
wrong from 14:36 onward, **and I repeated it to the owner at ~21:00 PT, seven hours late.**

**HOW I GOT IT WRONG IS THE REUSABLE PART: I READ THE CODE BEFORE A REBASE AND ANSWERED AFTER
ONE.** `claimHoldNotification` was at `worker/poller.ts:700` when I read it. #183 **moved it** to
`worker/hold-claim.ts`, and my later `grep` for `rc_hold_notified_for` in `poller.ts` returned
only the type and the SELECT — which I read as "the column is still there, so the bug is still
there" instead of "the function has gone somewhere else". **A grep that returns fewer hits than
before is a signal to find out why, not a confirmation of the previous reading.**

**THEIR FIX IS STRICTLY BETTER THAN THE ONE 26b PROPOSES, AND IT IS WORTH SAYING WHY.** 26b says
the column needs "a row per (watch, campground) — the same move migration 026 made". That would
have fixed the round-robin **and left 26c intact**: two divisions reporting the same unit would
still each hold their own claim and still send two texts for one campsite. The shipped fix keys
on the **UNIT** instead — `rc_hold_notified_keys text[]`, key `<releaseHour>|<unitId>`, appended
with `array_append` under a `NOT (... @> ARRAY[key])` guard — so the two divisions that both
reported unit 43191 now compute the *same* key and only one wins. **One fix, both defects.**
`releaseHoldClaims` is unit-scoped to match, and `worker/hold-claim.test.mts` carries 7 tests.

**THE DEPLOY GUARD IS WHY NOTHING RE-ANNOUNCED.** Migration 067 backfills a live legacy claim as
`<hour>|*` and the claim checks that wildcard too, so every watch mid-claim is suppressed for
that release hour rather than sending one more alert the moment the poller ships. Both watches
read `["2026-8-25T8|*"]`, which is why restoring divisions produced no alerts.

**BOTH WATCHES ARE RESTORED TO FULL COVERAGE (2026-08-24 21:30 PT).** Melinda's `336d742c` is
back to all three divisions (`rc-2185`, `rc-582`, `rc-583`); the owner's `eb886697` was never
trimmed and keeps `rc-582` + `rc-583`. **No stopgap remains in place and nothing is owed.**

**AND THIS WAS CONCURRENT DISCOVERY, NOT A RE-DERIVATION.** CLAUDE.md's own "26 TEXTS IN AN HOUR"
entry documents the same storm; it did not exist when 26a was measured. Two lanes diagnosed one
incident within hours of each other without knowing — which is the cost `docs/LANES.md` names,
arriving in its expensive form. **A one-line message to the other session would have saved a
duplicated investigation**, and `ListAgents` reports no reachable peers across cloud containers,
so there is currently no cheap way to send one.


---

## Handover — 2026-08-24 midday (side lane)

*Supersedes the 08-23 night block for STATE. §25 (Routines) and §26 (the park-watch flood)
stand. Read 12:55 PT.*

### EGRESS IS BACK, AND I WAS WRONG ABOUT NEEDING A NEW SESSION

The block was the **CampHawk environment's Network access level**, set to `Trusted` —
"allowlisted domains only: package registries, GitHub, cloud SDKs". The owner switched it to
**Custom** with an allow-list, and **it took effect in the ALREADY-RUNNING session**. I had
said a new session would be required; that was an assumption and it was wrong. Test with
`curl -s -o /dev/null -w "%{http_code}" https://camphawk.app/api/health/status` rather than
reasoning about when policy is applied.

Domains added: `camphawk.app`, `*.supabase.co`, `*.fly.io`, `fly.io`, `api.machines.dev`,
`*.recreation.gov`, `recreation.gov`, `*.reservecalifornia.com`, `*.usedirect.com`,
`*.tylerapp.com`, `*.frame.claudeusercontent.com`, with "also include default package
managers" ticked. Edited at **claude.ai/code** → cloud icon above the message box → gear on the
environment. There is no settings URL for it and no documented mobile-app path.

### THE ONE THING THAT NEEDS A DECISION

**§26 — two bugs in `worker/poller.ts`, main lane's.** The live flood is stopped by a data
change; the defects are untouched.

1. `rc_hold_notified_for` is one column for N divisions → infinite round-robin. Needs a
   migration (row per (watch, campground)), the same move migration 026 made.
2. Two divisions returned the same unit. Fixing (1) alone still sends two alerts for one site.

**AND A LIVE RISK TONIGHT:** `eb886697` (the owner's own Morro Bay watch, rc-582 + rc-583) is
one locked Lower Section site away from the same flood at **~72 messages/hour**, because push
is enabled on it. It has not fired because rc-582 has produced zero held units in 24h — a
condition, not a property. Trimming it to `rc-583` is the same one-line stopgap and was offered,
not taken.

### State, read 12:55 PT

| | |
|---|---|
| Master | `dd2ab82` (#178, #179, #182 landed while this session ran) |
| This branch | rebased onto it; PR **#180** open, docs only |
| Open issues | **#175, #174, #76, #14** |
| Worker | `poller.shards 2/2 held`, `poller.capacity 1/8`, `autocart.rc_runner ok` |
| Overall health | `degraded` — the ordinary state, every failure non-paging |
| Routines | 4 active + 1 disabled (§25); 08:15 outcome binds to **CampHawk-Main** |

### What this session did

- **Consolidated the Routines 7 → 4** (§25). Two duplicates were UI-created and had to be
  deleted by the owner — an agent can neither delete nor disable a `created_via: "http_api"`
  routine.
- **Diagnosed and stopped the park-watch flood** (§26). 52 messages in 62 minutes; ~460 more
  prevented.
- **Answered the auto-cart-states question** and did not act on it. Summary: adding a UseDirect
  state's CATALOG is one entry in `USEDIRECT_PROVIDERS` plus one in `data-sources.ts` — genuinely
  cheap. Adding HOLDS to the 9 states already detected is expensive and needs an account per
  portal, a cart API host that is **not derivable** (RC's cart is `rdapi.reservecalifornia.com`,
  a different host from its availability `rdrBase`), and another resident Chromium on the leaking
  mini-PC. rec.gov auto-cart is already nationwide. **Every live watch is `reservecalifornia` or
  `ridb`, so a new state's holds serve zero known users today** — measure demand first.

### Open

- **§26's two bugs** — main lane's, not filed as issues.
- **#174, #175** — still unfolded main-lane corrections.
- **CLAUDE.md names two deleted trigger IDs** (§25i), and **CampHawk-Main has never been told**
  a routine fires into it at 08:15 — `ListAgents` shows no reachable peers across containers.
- **A CI run can still turn `autocart.rc_session` RED** and print the destructive
  `rc-login.bat` remedy. Recorded, not fixed.
- **The live manage token `EQO2oXcQ`** — still unrotated. Owner's call, five sessions running.
- **iOS `1.0 (5)`** — awaiting a decision. Release is AUTOMATIC on approval.
- **The leak is not fixed** and remains the standing ask.

### Traps

- **A verification window wider than the cadence you are testing cannot answer a before/after
  question** (§26f). It reported a working fix as broken.
- **Silence means two things** — "it stopped" and "the poller died". Prove the cycle ran.
- **`created_via` is invisible in the Routines UI** and decides whether an agent can act.
- **`TEST · ` in the readout's `site` column** is the one unambiguous fixture marker.
- **`claimed` in the readout is `claimed_at ?? released_at`** — `released` is the success state.
- **Do NOT run `npm test`** — production DB, serialized between lanes.
- **The branch name IS the lane token**, and `claude/camphawk-side-lane-status-iij2xm` still does
  not match `docs/LANES.md`'s `claude/side-<topic>`. Fourth session running.


---

## 27. SUPABASE EGRESS IS 2.1x THE FREE LIMIT, AND 60% OF IT IS ONE 2-SECOND LOOP

*Side lane, 2026-08-24 afternoon. Supabase sent a Fair Use warning: **11.81 GB of 5.5 GB**, grace
cut to **3 days (Aug 27)**, after which projects return **402** until upgraded. The owner asked
whether an upgrade was needed. Measured rather than guessed.*

**MAIN LANE: the dominant cost is `scripts/auto-cart-bot/bot.mjs` and the route it polls. The
immediate lever is an env var on the mini-PC; the real fix is code.**

### 27a. IT IS CALL COUNT, NOT PAYLOAD SIZE

```
live sample, 60s:      3.4 PostgREST requests / second   =  ~290,000 / day
cumulative:            16,418,388 requests since 2026-05-22 (stats_reset)
11.81 GB / ~8.7M req per month  =>  ~1.4 KB per request
```

1.4 KB is a small JSON body plus HTTP/TLS overhead. **Nothing is shipping large result sets on
the hot path** — the bill is eight-and-a-half million round trips.

**`pg_stat_statements` IS AVAILABLE AND IS THE INSTRUMENT.** `SELECT calls, rows, query FROM
pg_stat_statements ORDER BY rows DESC` answers this in one query. Because every call goes through
the `exec_select` / `exec_dml` RPCs, the top rows are PostgREST's own wrappers and the per-request
`set_config(...)` — **summing `calls` on `query LIKE 'select set_config%'` gives total API
requests**, which is the number that maps to the egress bill.

### 27b. THE DOMINANT LOOP — FOUR ROUND TRIPS EVERY TWO SECONDS

`bot.mjs:38` — `const POLL_MS = Number(process.env.POLL_MS || 2000)` — and each roster poll costs
**four separate database requests**:

| | |
|---|---|
| `UPDATE autocart_bot_heartbeat SET beat_at = NOW()` | fire-and-forget liveness beacon |
| the roster `SELECT` | enrolled users + their pending jobs |
| `botUpdateState()` | inside `botControlFor()` |
| `claimBotCommands()` | inside `botControlFor()` — a `Promise.all` of two |

```
43,200 polls/day x 4  =  ~173,000 requests/day  =  2.0 req/sec
                          ~59% of the measured 3.4 req/sec
                          ~7 GB of the 11.81
```

**THE CADENCE IS CONFIRMED, NOT ASSUMED.** `autocart.bot` read *"last beat 1s ago"*, and
`autocart_bot_heartbeat.beat_at` advanced **20.1s across a 20s window** with an age of 3.4s at
sample time. The bot is genuinely polling at two seconds. The 59% is arithmetic on top of that
(`POLL_MS` read from source x 4 call sites counted in source, over a measured total).

**AND IT IS POLLING FOR ALMOST NOTHING.** Every live watch is `reservecalifornia` or `ridb`, with
essentially ONE rec.gov watch; `autocart_jobs` holds 73 rows lifetime. Forty-three thousand polls
a day to service a feed that is nearly always empty.

### 27c. TUNING ALONE DOES NOT GET UNDER 5 GB — the arithmetic, stated so it is not re-derived

```
POLL_MS 2000 -> 15000 :  173k/day -> ~23k/day
total                 :  290k/day -> ~140k/day
projected             :  ~5.7 GB/month     <- still over the 5 GB free limit
```

**The free tier is simply tight for a 24/7 polling product** with two Fly shards, a mini-PC bot
and a hold runner. Even after the fix you would sit permanently near the ceiling, and one
incident clears it — §26's alert flood wrote 52 notifications plus every poller cycle behind it.

**SO THE RECOMMENDATION WAS: UPGRADE *AND* FIX**, which are separate decisions.
A 402 takes CampHawk dark — no alerting, no 08:00 carts — for paying subscribers, with the App
Store review live. That is a bad trade against ~$25/mo, and Pro's egress allowance is roughly
50x the free one. The fix is still worth doing: 43,200 polls/day for one watch is waste whatever
plan pays for it.

### 27d. THE ONE FACT THAT DECIDES THE TIMING, AND NOBODY IN A SESSION CAN SEE IT

**When does the billing period reset?** The 11.81 GB is ALREADY SPENT — cutting the rate today
cannot un-spend it. If the cycle rolls before Aug 27 there is room to fix and stay free; if it
does not, the 402 lands regardless of what changes now. That is on the usage dashboard and it is
the deciding fact. **Do not tell the owner a tuning change averts the deadline without it.**

### 27e. THE LEVERS, CHEAPEST FIRST

1. **`POLL_MS` on the mini-PC** — env var in `scripts/auto-cart-bot/.env`, read at process start,
   so it needs a bot restart (`stop-all` then `start-all.bat`) and **no code change and no
   deploy**. 10-15s costs up to ~13s of rec.gov auto-cart pickup latency on one watch, against a
   detection loop already running at 15s. The control channel tolerates it (diagnostics arrive a
   few seconds later) and so does `autocart.bot`, which warns at ~120s.
2. **The four-round-trips-per-tick shape is the real defect.** The heartbeat write and the two
   control-channel reads do not need to run on every poll — the heartbeat could be written every
   Nth tick, and the control channel could ride a longer cadence than the job feed. That is
   `scripts/auto-cart-bot/` plus `src/lib/bot-control.ts`, i.e. main lane, and it is the same
   class of finding as `/api/rc-proxy` batching: a hot loop nobody had counted.
3. **Do NOT reach for the roster query's shape.** It is one `SELECT` returning at most 200 rows
   and it is not the problem; the problem is that it happens 43,200 times a day alongside three
   siblings.

### 27f. CATALOGUED WHILE LOOKING, NOT INVESTIGATED

From `pg_stat_user_tables`, worth a look if anyone chases this further:

```
watch_campgrounds      3,624,469 seq scans on a 5-row table
users                  1,259,030 seq scans
watches                1,030,007 seq scans   (34.1M tuples read)
rc_hold_requests         478,333 seq scans
campgrounds                9,359 seq scans   (73.4M tuples read)  <- 8,037-row table
```

Sequential scans on tiny tables are cheap and produce no egress, so **none of this is the bill** —
but `campgrounds` reading 73 million tuples, and `watch_campgrounds` being scanned 3.6 million
times, are both worth understanding before the next growth step. Recorded as observations, not
findings.

### 27g. CLOSED OUT — UPGRADED 2026-08-24, AND THE COSTS TAB HAD NO ROW FOR IT

**The owner upgraded to Supabase Pro, $25/month.** The Aug 27 402 deadline is cleared. Health
read **18 of 19 ok** immediately after, the single warn being the benign `autocart.bot_version`
sha drift with nothing bot-side pending. So 27c's "upgrade AND fix" is now half done, and it is
the half with the deadline on it.

**AND THE ADMIN COSTS TAB HAD NO SUPABASE ROW AND NO FLY ROW AT ALL.** `cost_items` held eight
rows and the only monthly recurring ones were Vercel ($20) and Claude ($20) — so the page that
computes **Net/month**, goes red, and says *"Losing money"* was understating recurring cost by
**$30.11**.

```
tracked before:  Vercel $20 + Claude $20                                   = $40.00
actual:          + Supabase $25.00  + Fly.io worker $5.11                  = $70.11
```

**HOW THE GAP WAS CREATED IS THE REUSABLE PART, AND IT WAS A TIDY-UP.** Migration 024 seeded
`Supabase` and `Fly.io worker` (along with Clerk, Mapbox and the Twilio number) at **$0**,
precisely so the operator would just fill in amounts. CLAUDE.md records them being removed —
*"the '$0.00 providers' note is resolved — 6 rows, none at zero, after a dedupe"* — which was
the right call for the display and is what left no row and no reminder for two services that
LATER started costing money. Migration 030 deliberately dropped `ended_at`, so **deleting a row
is the only way to remove one**, and that is exactly what made the placeholder unrecoverable.
**A zero-cost row is a reminder; deleting it buys a tidy table and a silent blind spot.**

Both rows re-added, with the `started_at` choices stated so they can be corrected rather than
trusted:

- **Supabase** — `data`, $25.00/mo, `started_at 2026-08-24`. Exact: the upgrade date.
- **Fly.io worker** — `hosting`, $5.11/mo, `started_at 2026-08-01`. **This one is a judgement
  call.** $5.11 is the *upcoming* invoice read from the Fly billing page on 2026-08-24; the
  prior invoice was **$0.00**, so Fly only just began accruing and dating it to the start of
  the current billing month is the most defensible reading. It is not a measured start date.

**`POLL_MS` REMAINS OPEN AND IS STILL WORTH DOING.** The upgrade removed the deadline, not the
waste: 43,200 polls a day at four round trips each, servicing a feed for essentially one rec.gov
watch. It is now a headroom-and-tidiness job rather than an emergency, which is a better place
to make the change from — see 27e.


---

### Handover addendum — 2026-08-24 afternoon

**§26 IS CORRECTED — SEE 26h. Both defects were FIXED AND DEPLOYED the same day** (`d842dc0`,
#183, 14:36 PT: migration 067 + `worker/hold-claim.ts`, keyed on the UNIT). The trim at 12:43
was still what stopped the flood — the fix came two hours later — but §26's "recorded, not
fixed" framing was wrong from 14:36 onward and I repeated it seven hours late. **Both watches
are restored to full coverage and nothing is owed.** Multi-division watches WORK.

**§26 IS SUPERSEDED BY §28: the coming-soon fix SHIPPED the same day (#183, `d842dc0`, 14:36
PT) and both defects are addressed. Multi-division watches WORK. What is left is data — Melinda's
watch is still trimmed to one division by my stopgap and should be restored to all three, which
is safe to do now.**

**§27 is CLOSED OUT (see 27g): upgraded to Supabase Pro on 2026-08-24, $25/month, deadline
cleared, and the admin Costs tab turned out to have no Supabase row and no Fly row — monthly
recurring was understating by $30.11 and is now $70.11. `POLL_MS` remains open.**

**§27 supersedes nothing; it is new.** Supabase sent a Fair Use warning (11.81 GB of 5.5 GB,
402 on **Aug 27**) and the cause is measured: **~60% of all database traffic is `bot.mjs`
polling the roster feed every 2 seconds at four round trips per poll.** Recommendation given
to the owner was **upgrade AND fix** — tuning alone lands at ~5.7 GB against a 5 GB limit, and
the 11.81 GB is already spent so no change now averts the deadline.

**The deciding fact nobody in a session can see: when the billing period resets.**

Immediate lever is `POLL_MS` in `scripts/auto-cart-bot/.env` (bot restart, no deploy). The real
fix — not writing the heartbeat and both control-channel reads on every tick — is main lane's.


---

## 28. CORRECTION TO §26 — THE FIX SHIPPED THE SAME DAY, AND I SAID IT HAD NOT

*Side lane, 2026-08-24 evening. §26 says the two coming-soon defects are "untouched" and need a
migration. **That was true when written and false within two hours**, and I repeated it to the
owner at ~21:30 as current state. This section is the correction; §26's measurements stand, its
status claims do not.*

### 28a. WHAT ACTUALLY SHIPPED

**`d842dc0` — #183, committed 2026-08-24 14:36 PT** — *"One campsite is one text"*:

- **Migration 067** adds `watches.rc_hold_notified_keys text[]`, backfilling any live legacy
  claim as `<hour>|*`.
- **`worker/hold-claim.ts`** is extracted from `poller.ts` (the same reason `claim.ts` was:
  importing the poller starts it, so the decision governing how many texts a user gets was
  untestable where it lived).
- The claim is now **a SET keyed `<releaseHour>|<unitId>`**, one atomic
  `UPDATE .. SET array_append(..) WHERE NOT (keys @> ARRAY[key])`.
- **`worker/hold-claim.test.mts`, 7 tests**, real-DB.

**BOTH of §26's defects are addressed, and the second one by the same stroke.** Keying on the
UNIT means two divisions reporting the same unit compute the SAME key, so the duplicate
collapses — there is an explicit test named *"the SAME unit found under two divisions is
announced ONCE"*. §26c said "fixing the column alone still leaves two alerts for one site"; that
was right about a campground-keyed fix and does not apply to the unit-keyed one that shipped.

### 28b. HOW I GOT IT WRONG — read pre-rebase, answered post-rebase

I read `worker/poller.ts:683-706` and quoted the single-column `UPDATE` as current. Between that
read and the answer I ran `git rebase origin/master`, which **moved the function into
`worker/hold-claim.ts`**. I never re-read. So I quoted code that had not existed in the tree for
some minutes, with a line number that was by then pointing at something else.

**A LINE NUMBER IS ONLY VALID FOR THE TREE YOU READ IT FROM.** Re-read anything you are about to
quote as current state after a rebase, a merge, or a fetch — especially in a repo where the other
lane ships several times a day. Every fact in §26's *measurement* half came from the database and
is unaffected; every fact in its *status* half came from source and went stale.

### 28c. THE TRIM WAS STILL REAL — the timeline, so neither party's work is misattributed

```
11:40 - 12:42 PT   the flood: 48 messages, 2 divisions, one site
~12:43 PT          side lane trims Melinda's watch to rc-583  -> flood stops
14:36 PT           main lane commits #183, the real fix
```

**The fix did not exist when the flood was stopped**, so the trim is what stopped it, and the
~2 hours between them were covered by data rather than code. This was **concurrent discovery, not
duplicated work** — but the two lanes were both on it without either knowing, which is what
`docs/LANES.md` exists to prevent and what `ListAgents` returning no reachable peers made
impossible to avoid here.

### 28d. WHAT IS ACTUALLY LEFT — data, not code

The code is fixed and deployed (`poller.shards 2/2 held`). What remains is the stopgap I applied,
which is now unnecessary and is costing coverage:

| watch | divisions now | should be | note |
|---|---|---|---|
| `336d742c` Melinda | `rc-583` | `rc-582, rc-583, rc-2185` | **trimmed by me; restore** |
| `eb886697` owner | `rc-582, rc-583` | unchanged | never trimmed; **now safe** |

Restoring Melinda's two rows is two `INSERT`s into `watch_campgrounds`. **It is safe to do now
rather than after the release**, because the shipped claim is per-unit and the backfilled
`<hour>|*` wildcard suppresses the 08:00 release for both watches regardless — §26e's
"re-adding tonight restarts the flood" was reasoning about the OLD code and is superseded.

**NOT DONE IN THIS SESSION**, because it is another user's watch and the correction landed at the
end of the session rather than in the middle of it.


---

## 29. STORE BILLING SETUP — 2026-08-24 evening (side lane)

Two workstreams, both console work, both ending blocked on somebody else. **Docs only — nothing
in `src/`, `worker/` or any main-lane file was touched.** Branch
`claude/camphawk-side-lane-status-iij2xm`, PR **#180**.

### 29a. §26's LAST OPEN ITEM IS CLOSED — Melinda's watch IS restored

The tail of §28 ends *"NOT DONE IN THIS SESSION"*, and that sentence is **stale**. Read back
from the database 2026-08-24, not assumed:

```
336d742c  Melinda  rep rc-582  parts [rc-2185, rc-582, rc-583]  active
eb886697  owner    rep rc-582  parts [rc-582, rc-583]           active
```

**All three divisions are back.** Do not re-run the restore — it is another user's watch, and a
second pass either duplicates `watch_campgrounds` rows or fails a constraint. Both watches are
in the state §28 says they should be.

**This is the same shape as §28 itself**: a status sentence that was true when written and false
by the time it was read, with nothing marking the difference. The remedy is what was done here —
query the table, don't trust the note.

### 29b. What landed on the stores

Everything both consoles allow. Full detail in `docs/STOREKIT-PLAN.md`, which now opens with a
**STATE AS OF** block written for exactly this handover.

| | Done tonight | Now waiting on |
|---|---|---|
| **Apple** | — | bank + Paid Applications agreement processing |
| **Play** | merchant account · public merchant profile · account group + declaration · **15% service fee enrolled** · production track set **US-only** | bank micro-deposits, and a build |

### 29c. THE FINDING WORTH CARRYING: Play products need a build, Apple's do not

`Monetize with Play → Products → Subscriptions` offers **only `Upload a new APK`** — there is no
create button, with every console prerequisite satisfied. Play requires an uploaded binary
declaring **`com.android.vending.BILLING`**, which arrives with the Play Billing Library.
Verified in the tree: no billing dependency in `package.json`, and the permission appears nowhere
outside `node_modules`.

**So Play's order is library → build → upload → products, and it is native work, not console
work.** Apple creates products with no build at all. Written up as `STOREKIT-PLAN.md` §9a-bis.

### 29d. FIVE CORRECTIONS IN ONE EVENING, ALL THE SAME SHAPE

Recorded together because the pattern is the point, not any one of them:

1. §9d said Google gives 15% *"with no enrolment"* — read off Google's published fee table and
   never off this account. There is an enrolment.
2. I told the owner **not to press `Manage account group`**, reasoning the group's existence
   already answered the associated-accounts question. It opens a **declaration dialog** whose two
   questions were blank; the advice would have blocked the step it described.
3. I predicted accepting the service-fee terms was a **separate** step after saving the
   declaration. Saving carried it.
4. §9f said the merchant account was the **last** gate on creating products. §9a-bis is a second.
5. I gave a per-store walkthrough that was right for Apple and unreachable for Play.

**Every one is a state inferred from a published document or a UI's appearance instead of
opened.** The house rule this repo already has — *presence is not liveness* — restated for
consoles: **a rate in a table is not a rate on an account, and a screen that looks finished is
not a finished screen.** `STOREKIT-PLAN.md` now carries a standing note that Apple and Play have
been collapsed into one shape three times and must not be again.

### 29e. Not started, deliberately

The migration (§2), the webhook (§5), the product-id → tier mapping and the paywall. All
**main-lane** files. §9a's proration trap is the expensive one: Play has no subscription groups,
so upgrade-vs-downgrade is stated by app code and no console screen can show the mistake.
