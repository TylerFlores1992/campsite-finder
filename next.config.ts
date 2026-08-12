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
  const botAt = git("log", "-1", "--format=%cI", "--", "scripts/auto-cart-bot");
  if (sha) out.CH_DEPLOY_SHA = sha;
  if (at) out.CH_DEPLOY_AT = at;
  if (botAt) out.CH_BOT_CODE_AT = botAt;
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
