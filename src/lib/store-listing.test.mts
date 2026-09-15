/**
 * THE APP STORE DESCRIPTION MUST CARRY A TERMS OF USE (EULA) LINK, AND MUST FIT.
 *
 * ## The finding (2026-09-15) — the fifth Apple rejection, and the cheapest one
 *
 * iOS `1.0 (27)` was rejected on **3.1.2 Business: Payments - Subscriptions**, by an
 * automated check, before a human opened the app:
 *
 *   > The submission offers auto-renewable subscriptions, such as Auto-Cart Monthly,
 *   > Base Yearly, Base Monthly, Auto-Cart Yearly, but does not include a functional
 *   > link to the Terms of Use (EULA) in the app metadata that appears on the app's
 *   > App Store product page.
 *
 * It was correct. `docs/appstore-description.txt` named neither a Terms of Use nor a
 * Privacy Policy link anywhere in its 3,582 characters — checked, not assumed. The
 * whole six-item submission (the app version, the subscription group and all four
 * subscriptions) was blocked on two lines of text in one metadata field.
 *
 * ## Why this is a GATE and not a one-off edit
 *
 * The same blind spot as the `jsx-spacing` and `us-spelling` gates: a store listing is
 * plain text that `tsc`, `next build` and the entire test suite are structurally unable
 * to see. Nothing in this repo referenced `docs/appstore-description.txt` at all — one
 * grep, zero hits — so the requirement could only ever be enforced by somebody
 * remembering it, and the four-round-trip history of `docs/APP-STORE.md` is what
 * remembering is worth here.
 *
 * ## The length cap is the same class of defect
 *
 * `CLAUDE.md` records "paste the file, re-count after any edit" for both listings, which
 * is an instruction rather than a mechanism. The Play description has **102 characters**
 * of headroom against its 4,000 limit, so an edit that reads as small is one paste away
 * from being silently truncated in a console — and a truncated description is how the
 * 2026-08-03 Play "Misleading Claims" rejection could recur, because the government
 * source URLs it was fixed with live at the BOTTOM of that file.
 *
 * ## What this deliberately does NOT assert
 *
 * **Not a specific URL.** Apple accepts either form and the choice is a real decision:
 * link the standard Apple EULA in the description, or upload a CUSTOM EULA in App Store
 * Connect (App Information -> License Agreement). Pinning Apple's own URL here would
 * fail the day somebody legitimately takes the second path. What is asserted is the
 * property the rejection was actually about: a labelled, functional link.
 *
 * **Not the Play listing's legal links.** Google was never cited for this and there is
 * no evidence to encode. Widening a guard past its evidence is how one gets deleted by
 * the next person it inconveniences, taking the real finding with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** App Store Connect and Google Play both cap the long description at 4,000 characters.
 *  ASC's own counter agrees with `wc -c` exactly — it counts newlines — so a local count
 *  is trustworthy and nobody has to paste-and-see. */
const DESCRIPTION_LIMIT = 4000;

const APPLE = 'docs/appstore-description.txt';
const PLAY = 'docs/play-full-description.txt';

/** A line that both NAMES the agreement and carries a URL. Both halves are required:
 *  the words alone are what the rejected description very nearly had (it discusses
 *  subscriptions at length), and a bare URL is not a "functional link" a reviewer or an
 *  automated scan can attribute to anything. */
const LABELLED_LINK = (label: RegExp) =>
  // THE GROUP IS LOAD-BEARING, and its absence survived the first mutation round.
  // `TERMS_LABEL` is an alternation, so interpolating it bare builds
  // `^.*terms of use|EULA|licen[sc]e agreement.*https?://\\S+` — three top-level
  // branches, the middle one matching the bare word "EULA" anywhere with no URL
  // required at all. The guard passed against a description reading
  // "Terms of Use (EULA): see the CampHawk website", i.e. against the exact defect
  // Apple rejected. Un-grouped alternation is the ~29th instance of a guard in this
  // repo anchored on the wrong thing.
  new RegExp(`^.*(?:${label.source}).*https?://\\S+`, 'im');

const TERMS_LABEL = /terms of use|EULA|licen[sc]e agreement/;
const PRIVACY_LABEL = /privacy polic/;

test('the App Store description carries a functional Terms of Use (EULA) link', () => {
  const text = read(APPLE);
  assert.match(
    text,
    LABELLED_LINK(TERMS_LABEL),
    `${APPLE} has no line carrying BOTH a Terms of Use/EULA label and a URL. ` +
      'That is exactly what Apple rejected iOS 1.0 (27) for on 2026-09-15 ' +
      '(guideline 3.1.2) — see docs/APP-STORE.md section 2e. An app offering ' +
      'auto-renewable subscriptions must link the EULA from the metadata that ' +
      "appears on the App Store product page."
  );
});

test('the App Store description carries a functional Privacy Policy link', () => {
  const text = read(APPLE);
  assert.match(
    text,
    LABELLED_LINK(PRIVACY_LABEL),
    `${APPLE} has no line carrying BOTH a Privacy Policy label and a URL. Apple's ` +
      '3.1.2 wording pairs the two, and the Privacy Policy URL field in App Store ' +
      'Connect is a SEPARATE field — filling that one does not put a link in the ' +
      'description.'
  );
});

// Both listings, because the failure is identical and the Play one is the tighter fit.
for (const [store, path] of [['App Store', APPLE], ['Play', PLAY]] as const) {
  test(`the ${store} description fits the ${DESCRIPTION_LIMIT}-character field`, () => {
    const n = read(path).length;
    assert.ok(
      n <= DESCRIPTION_LIMIT,
      `${path} is ${n} characters, over the ${DESCRIPTION_LIMIT} limit by ` +
        `${n - DESCRIPTION_LIMIT}. The console silently refuses the paste, and the ` +
        'obvious thing to trim is the government source list at the bottom — which is ' +
        'what the 2026-08-03 Play rejection was fixed with. Trim something else.'
    );
  });
}

/**
 * `docs/APP-STORE.md` section 6 carries a SECOND copy of the App Store description,
 * under a heading that calls itself a *"Verbatim copy"* and an instruction that reads
 * *"Paste `docs/appstore-description.txt`, don't retype from here."* Two copies of the
 * text that decides whether a submission is accepted, and only one of them enforced.
 *
 * On 2026-09-15 they were still identical, which is luck rather than a mechanism — and
 * the failure mode is specific and bad: the stale copy is the one somebody scrolling
 * `docs/APP-STORE.md` for the rejection reads FIRST, so the drift ships the exact text
 * Apple just rejected. "A correction applied to one copy is not applied" is the most
 * repeated shape in this repo.
 */
test('the section 6 "verbatim copy" really is verbatim, and its character count is right', () => {
  const doc = read('docs/APP-STORE.md');
  const live = read(APPLE).replace(/\n+$/, '');

  // The count convention in that heading excludes the file's trailing newline.
  const block =
    /\*\*Description\*\* \((\d+)\/4000 — (\d+) spare\)\. Verbatim copy of\n`docs\/appstore-description\.txt`:\n\n```\n([\s\S]*?)\n```/.exec(
      doc
    );
  // A MISSING ANCHOR MUST FAIL LOUDLY, NEVER PASS. `exec` returns null and every
  // assertion below would be skipped by an early return — which is a guard that has
  // silently stopped reading its subject while reporting green.
  assert.ok(block, 'docs/APP-STORE.md section 6 no longer has a Description block this can read');

  assert.equal(
    block[3],
    live,
    'docs/APP-STORE.md section 6 has drifted from docs/appstore-description.txt. ' +
      'The .txt is what gets pasted into App Store Connect; update section 6 to match it.'
  );
  assert.equal(Number(block[1]), live.length, 'the section 6 character count is stale');
  assert.equal(
    Number(block[2]),
    DESCRIPTION_LIMIT - live.length,
    'the section 6 "spare" figure is stale'
  );
});
