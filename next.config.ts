import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
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
