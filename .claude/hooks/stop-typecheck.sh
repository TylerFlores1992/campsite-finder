#!/usr/bin/env bash
# Typecheck on Stop — the cheapest guard against "declared done, wasn't".
#
# WHY THIS AND NOT THE FULL RECIPE. `npm run verify` is typecheck + tests + build, about two
# minutes, and the tests hit the PRODUCTION database on purpose (the alerting claim's
# correctness lives inside one `INSERT .. ON CONFLICT .. WHERE`, so a mock would test a
# fake). Running that on every Stop would put real writes and two minutes between finishing
# a thought and saying so. CI carries the full recipe; this carries the 25-second part that
# catches the most common way work is wrongly declared finished.
#
# WHY TYPECHECK SPECIFICALLY. `npm run typecheck` runs BOTH tsconfigs — the root one
# EXCLUDES `worker` and `scripts`, so the poller was for a long time typechecked by nothing.
# It has already earned its place twice: it caught an invented `isAdmin`, and on 2026-08-12
# it caught three module-scope Stripe helpers left behind by an edit that `npm test` alone
# would have waved through as a runtime ReferenceError on the billing path.
#
# AND DO NOT OVER-TRUST IT. The same week, typecheck passed clean on a file `next build`
# rejected (backticks inside a template literal). It is a good 25-second gate; it is not a
# substitute for a build, and `next build` passing is itself not enough for layout changes
# because dynamic segments are not executed at build time.
#
# NON-BLOCKING BY DESIGN: exit 0 always. This reports, it does not gate. A hook that can
# refuse to let a turn end is a hook that will eventually be in the way during an incident,
# and the 08:00 cart is not something to stand between a person and their keyboard for.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Nothing to check if dependencies were never installed (fresh container, hook order).
[ -d node_modules/typescript ] || exit 0

if out=$(npm run --silent typecheck 2>&1); then
  exit 0
fi

echo "── typecheck FAILED ────────────────────────────────────────────────" >&2
# Tail, not head: tsc prints the summary last, and the first lines are npm noise.
echo "$out" | tail -25 >&2
echo "────────────────────────────────────────────────────────────────────" >&2
echo "Both tsconfigs are checked (root excludes worker/ and scripts/)." >&2
exit 0
