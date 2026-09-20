---
name: browser-qa
description: Drive camphawk.app in a real, signed-in Chrome (Claude in Chrome on the home server) and walk the product's user flows — search, campground page, watches, manage link, new watch, settings — reporting what a person would see. Use when asked to check, test, click through, screenshot or QA the site or the app's web screens, or when /loop is running it on a schedule. Needs the Chrome extension; refuses without it.
---

# Browser QA — the hands

This skill runs on the **home server** (the Windows mini-PC that is NOT the RC bot box),
in a Claude Code session started with the Chrome extension attached:

```
claude --chrome --remote-control "camphawk-qa"
```

It needs a real Chrome with a real signed-in session, which is why it cannot run from a
cloud session: the agent proxy resets headless-Chromium TLS to camphawk.app, and a cloud
session holds no Clerk login. **If `/chrome` does not read "Status: Enabled" and
"Extension: Installed", STOP and say so.** Do not substitute `curl`, a fetch, or a
description of what the page probably shows — a report about a page nobody rendered is
worse than no report, and this repo has paid for that shape repeatedly.

**Start the session from a plain folder, not from the repo checkout.** The repo's
`CLAUDE.md` is enormous and would eat most of the QA session's context on every start for
no benefit — nothing here reads the code. Install or refresh this file as a personal skill
on the server (PowerShell, one line; the repo is public):

```
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills\browser-qa" | Out-Null; irm https://raw.githubusercontent.com/TylerFlores1992/campsite-finder/master/.claude/skills/browser-qa/SKILL.md -OutFile "$env:USERPROFILE\.claude\skills\browser-qa\SKILL.md"
```

The copy in the repo is the source of truth; the copy on the server is what runs.

## Accounts — which one for which flow

| account | what it is | use it for |
| --- | --- | --- |
| `tylerflores1992@gmail.com` | the owner's REAL account. `is_beta`, so the UI treats it as subscribed everywhere — and it holds live watches, real hold offers, and is `line_priority = 1` in the hold line | **read-only flows only**: search, campground pages, the watches page, settings as a screen, the manage link as a screen |
| the QA account (a third address, owner-created; ask which if unsure) | a plain account with no real watches. If the owner has set `is_beta = true` on it, it sees the subscribed UI exactly like the Gmail account with none of the real state | **everything that creates, edits or removes**: new watch, edit dates, pause/resume, mute/unmute, remove watch |
| `iamtylerflores12345@yahoo.com` | the App Store review demo account. It must stay a **non-subscriber** or the next Apple review is rejected (that happened on 2026-08-22) | **never sign in as it, never touch it** |

Whichever account the browser is signed in as when you start, say which one at the top of
the report, because it decides what the screens can show. Beta accounts never see a paywall
or a subscribe prompt; a flow that expects one is SKIPPED on a beta account, not failed.

If Clerk asks for an emailed one-time code (first sign-in on a new device), **stop and tell
the owner** — they clear it over RustDesk. Never guess a code and never type a password into
anything except camphawk.app's own sign-in.

## NEVER — these are hard rules, not preferences

1. **Never navigate to reservecalifornia.com, signin.reservecalifornia.com, okta.com or
   recreation.gov**, and never follow a link that leads there (booking links, "Finish on
   ReserveCalifornia", the hand-off screen's open button). The household IP has been blocked
   by those portals for twelve hours at a time over automated traffic, and the RC bot on the
   other machine depends on that IP staying clean. If a step lands there, go back at once
   and report it.
2. **Never press anything that holds, hands over, claims, releases or declines a campsite** —
   "Hold it for me", the claim screen's release button, "I don't want this one", the X on a
   queued hold. Those act on real campsites and real users' places in line. Read the
   watches page's hold cards; do not touch them.
3. **Never complete a purchase.** Stop at camphawk.app's own pricing page. Do not proceed
   into Stripe Checkout, do not press a store paywall's buy button, do not change plan.
4. **Never press an action button on `/admin`** — "Ring my phone now", "Update now", "Ask",
   "Open the claim screen", "Ring", the reconcile's "Apply". Reading `/admin` is fine.
5. **Never on the Gmail account**: create a watch, edit dates, pause, mute, "Turn off" SMS,
   change the phone number, sign out, or "Delete account". Every one of those changes real
   alerting for a real person. The QA account exists so those flows can be exercised.
6. **Never leave state behind.** A QA watch you created is removed before the run ends; a
   toggle you flipped is flipped back; the browser is left signed in as it was found. The
   report lists what was created and confirms it was removed.
7. **Never solve a CAPTCHA.** Stop, say so, and let a human do it.
8. **Never run `npm test`, push, merge, or touch the RC bot machine.** This is a QA session;
   it reads the site and writes a report.

## The flows

Run the ones asked for; with no instruction, run 1–5 in order. Each flow ends with one
screenshot that shows the outcome. Wait for a page to finish loading before judging it;
retry a timed-out screenshot once before calling anything broken.

**1. Smoke: search and a campground page.** Open `camphawk.app/search`. Search "Morro Bay".
Expect a results list with a count and a map. Open the first result's page. Expect the
campground name, a monthly availability calendar, and a "Watch this campground" control.
*Known open finding (2026-09-20): clicking a result card's TITLE did nothing; only its
"See full calendar" link navigated.* Check whether the title navigates now and say which.

**2. The watches page.** Open `camphawk.app/watches`. Expect one card per watch, each naming
the park and, for a park watch, its parts. Open one card's "Alert history". If a "Sites we're
holding" panel or a hold badge is present, describe it — do not press anything in it.

**3. The manage link (screen only on Gmail; round trips on the QA account).** From a card,
press "Manage". Expect `/manage/<token>` to show the watch's dates, "Pause checks" or
"Resume checks", "Mute individual campsites" with a filter, and "Remove watch". On the QA
account: press Pause and confirm the card shows paused, then Resume; open the mute list,
mute one site, confirm it is listed as muted, unmute it. Leave everything as found.

**4. New watch (QA account only).** Open `camphawk.app/new`. Pick "Morro Bay SP" as the
campground, a stay two to four weeks out, and press "Start watching". Expect a new card on
`/watches`. A blank space where a note about cancellations might be is **by design**, not a
render failure (the note stays silent when the stay is close, already bookable, or the
portal read failed). Then open its Manage link and press "Remove watch" → "Remove". Confirm
the card is gone. Never leave more than one QA watch live; the per-account cap is 6.

**5. Settings as a screen.** Open `camphawk.app/settings`. Expect sections headed Account,
How we reach you, Auto-cart, Subscription. Screenshot. Press nothing.

**6. Public pages (any account, or signed out).** `camphawk.app/`, `/pricing`, `/sources`,
`/camping/california`, `/sold-out-campsite`. Each should render with no error page, no
overlapping text at the top, and images or maps where the layout has slots for them. On
`/pricing` stop at the page; do not follow any subscribe or plan button.

**7. A signed-out and a non-subscriber view.** Only if the owner has set up a second Chrome
profile for it, or says to sign out. Signing out of the QA profile costs a Clerk code on the
way back in, so it is not done casually. If it cannot be done, mark it SKIPPED and say why.

## Reporting

Findings first. Then one line per flow: `PASS`, `FAIL`, or `SKIPPED (why)`, with the
screenshot path. A run with nothing wrong is a few lines, not a page.

Keep two things apart, always: **what the site did** and **what the browser tool did**. A
screenshot that timed out, a tab the extension lost, or a click the tool could not deliver
is a tool problem and is reported as one, not as a site defect. On 2026-09-20 the first
screenshot attempt timed out and the second succeeded; that is a tool event, not a finding.

State what you left behind: which account the browser is signed in as, any watch created
and removed, any toggle changed and restored. If anything could not be restored, lead
with that.

## Running it on a schedule

In the server's `camphawk-qa` session, `/loop 24h /browser-qa` runs this daily and reports
into the same session, which the owner reads from the phone. (Untested as of 2026-09-20 —
the first scheduled run is the check that it works; a run that reports nothing is a run to
look at, not a quiet day.) Cloud Routines cannot run this at all; they have no browser.
