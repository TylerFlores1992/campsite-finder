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
`CostsPanel`). **All five now render and exit 0**; the harness throws on any page error,
verified by restoring the exact bug and watching `exit=1`, then restoring the fix and
watching `exit=0`.

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
4. **`npm run jsx-spacing` is not in `npm run verify`.** Given that the SWC entity trap
   (finding 3) silently broke four user-visible strings and this codebase escapes entities
   everywhere, it is worth adding — one line, and the recipe is the main lane's.
5. **`verify.yml` racing itself is FIXED** — the concurrency group is now
   `verify-${{ github.head_ref || github.ref_name }}`, so a branch's push run and its PR
   run share a group and cancel. Finding 5 below describes the race as live; read it as
   history. **What it does not fix** is the underlying fragility it documents: fixed
   fixture ids with prefix `DELETE`s against ONE production database, so two branches
   pushing at once still collide. That is why `docs/LANES.md` serializes `npm test`
   between lanes rather than treating it as ceremony.
