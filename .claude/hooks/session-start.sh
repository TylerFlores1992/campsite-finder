#!/bin/bash
# SessionStart hook for Claude Code on the web.
# Installs project dependencies so web sessions can typecheck, lint, and build
# without a manual `npm install`. Synchronous by design — deps are guaranteed
# ready before the agent runs (the container caches the result afterward).
set -euo pipefail

# Local dev manages its own deps; only run inside the remote web sandbox.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

echo "[session-start] installing npm dependencies…"
npm install --no-audit --no-fund
# npm install re-normalizes package-lock.json in the sandbox (prunes entries that
# don't match the resolved tree), which leaves the repo dirty every session and
# trips the "uncommitted changes" stop-hook. We only want the node_modules, not a
# lockfile rewrite — so restore it. (A real dependency change would come through
# an intentional package.json edit + commit, not this hook.)
git -C "$CLAUDE_PROJECT_DIR" checkout -- package-lock.json 2>/dev/null || true

# ---------------------------------------------------------------------------
# Fly.io / Supabase ops tooling — STAGED, OFF by default.
#
# This does NOTHING useful until TWO things are configured on the ENVIRONMENT
# (not in this repo), which only a human with the env settings can do:
#   1. Network policy that allows: fly.io, api.fly.io, api.machines.dev,
#      registry.fly.io, and your <project>.supabase.co host. Under the current
#      locked-down policy flyctl can't even be downloaded, which is why this is
#      gated off — an install failure here would fail every session start.
#   2. Scoped secrets on the environment:
#        FLY_API_TOKEN         (from: fly tokens create deploy -a campsite-finder-worker)
#        SUPABASE_ACCESS_TOKEN (Supabase CLI) and/or SUPABASE_DB_URL (for psql migrations)
#
# Once (1) is done, set ENABLE_OPS_TOOLS=1 as an env var on the environment and
# this block installs flyctl + the Supabase CLI and puts them on PATH.
# ---------------------------------------------------------------------------
if [ "${ENABLE_OPS_TOOLS:-}" = "1" ]; then
  echo "[session-start] installing ops tooling (flyctl + supabase)…"
  npm install -g supabase@2 || echo "[session-start] WARN: supabase CLI install failed"
  if curl -fsSL https://fly.io/install.sh | sh; then
    echo 'export FLYCTL_INSTALL="$HOME/.fly"'      >> "$CLAUDE_ENV_FILE"
    echo 'export PATH="$HOME/.fly/bin:$PATH"'       >> "$CLAUDE_ENV_FILE"
  else
    echo "[session-start] WARN: flyctl install failed (network policy still blocking fly.io?)"
  fi
fi

echo "[session-start] done."
