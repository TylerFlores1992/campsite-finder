import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { execFileSync } from "node:child_process";

/**
 * What commit is THIS deploy, and when did bot-side code last change?
 *
 * Baked at build time because the running server has no git checkout, and the health check
 * `autocart.bot_version` has to compare the mini-PC's reported HEAD against something. The
 * mini-PC and Vercel deploy by different routes — Vercel auto-deploys on a push to master,
 * the box waits for a quiet window or a human — so drift between them is the normal state
 * for part of every day, and the expensive case is drift that includes bot-side code.
 *
 * `CH_BOT_CODE_AT` is what makes that distinguishable without git ancestry on the server:
 * master is linear, so a box whose HEAD is OLDER than the last commit touching
 * `scripts/auto-cart-bot/` is missing bot-side code. Comparing shas alone could only ever
 * say "different".
 *
 * EVERY VALUE IS OPTIONAL AND FAILURE IS SILENT. Vercel builds from a shallow clone, so
 * `git log` over a path can legitimately find nothing; a missing value makes the check
 * report "unknown", which is a warn. What must never happen is a build failing because a
 * diagnostic could not run, or an unknown being rendered as healthy.
 */
function gitFacts(): Record<string, string> {
  const git = (...a: string[]) => {
    try {
      return execFileSync("git", a, { encoding: "utf8", timeout: 5_000 }).trim();
    } catch {
      return "";
    }
  };
  const out: Record<string, string> = {};
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || git("rev-parse", "HEAD");
  const at = git("log", "-1", "--format=%cI");
  if (sha) out.CH_DEPLOY_SHA = sha;
  if (at) out.CH_DEPLOY_AT = at;

  /**
   * A SHALLOW CLONE DOES NOT SAY "I DON'T KNOW" — IT LIES, and the lie is the dangerous
   * direction. Measured on 2026-08-12 by cloning this repo at both depths:
   *
   *   depth=1   HEAD 05:16:01   log -1 -- scripts/auto-cart-bot -> 05:16:01  (WRONG: HEAD)
   *   depth=10  HEAD 05:16:01   log -1 -- scripts/auto-cart-bot -> 05:14:34  (right)
   *
   * Git treats a shallow BOUNDARY commit as parentless, so every file looks like it was
   * added there and the path filter matches it unconditionally. `CH_BOT_CODE_AT` would then
   * always equal `CH_DEPLOY_AT` — and since the check asks `boxCommitAt < botCodeAt`, that
   * is TRUE for any box behind by even one commit. Every ordinary drift would report
   * "MISSING bot-side changes", and with a hold queued that is a FAIL: exactly the
   * cry-wolf failure botVersionVerdict's severity rules exist to prevent, walked back in
   * through the build environment instead of the logic.
   *
   * So the commit is only trusted when it is NOT a root of the available history. In a
   * shallow clone the boundary reports as a root; in a full clone the only root is the
   * repo's initial commit, and bot code was not added there. Untrusted means the variable
   * is OMITTED, which the check already renders as "could not read when bot code last
   * changed" — a warn that names the missing evidence rather than a fail built on it.
   */
  const botSha = git("log", "-1", "--format=%H", "--", "scripts/auto-cart-bot");
  const roots = git("rev-list", "--max-parents=0", "HEAD").split("\n").filter(Boolean);
  if (botSha && !roots.includes(botSha)) {
    const botAt = git("log", "-1", "--format=%cI", "--", "scripts/auto-cart-bot");
    if (botAt) out.CH_BOT_CODE_AT = botAt;
  }
  return out;
}

const nextConfig: NextConfig = {
  env: gitFacts(),
  // The RC precart route READS extension/*.js at runtime and serves them to the mobile
  // in-app webview, so the extension source is the single implementation of that wire
  // contract. Next only bundles files it can trace through imports, and a readFileSync
  // path is invisible to tracing — without this the route 500s in production while
  // working perfectly in dev, which is the worst shape of deploy bug.
  outputFileTracingIncludes: {
    '/api/rc-precart': ['./extension/rc-inject.js', './extension/content-rc.js'],
  },
};

// Sentry wraps the build for error monitoring. Source-map upload only runs when
// SENTRY_AUTH_TOKEN/org/project are set; otherwise the build proceeds normally.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  disableLogger: true,
  telemetry: false,
});
