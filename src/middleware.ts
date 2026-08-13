import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Protect all routes except public ones
const isPublicRoute = createRouteMatcher([
  '/',
  '/privacy',
  // The App Store's required Support URL. A reviewer opens it signed out.
  '/support',
  '/terms',
  '/sms-opt-in',
  '/auto-cart',
  // Where the campground data comes from. Google Play requires an accessible link
  // to the official source of any government information an app shows, and the
  // store listing points here — a reviewer opens it signed out, so a 404 from
  // auth.protect() would fail the very check it exists to pass.
  '/sources',
  // The RC precart script the mobile in-app webview injects. Fetched by a webview with
  // no CampHawk session, at 08:00:00, when a site is seconds from being lost — an auth
  // dance there is latency we cannot spend. It is the source of a published extension
  // and carries no credential; see the route.
  '/api/rc-precart',
  '/robots.txt',
  '/sitemap.xml',
  // The app's free surface. Search is the funnel and must work signed-out;
  // /watches and /settings render their own account wall rather than 404ing,
  // which is what Clerk's auth.protect() would do (404, not 401).
  //
  // /new is listed too, deliberately. Clerk's auth.protect() would bounce a
  // signed-out visitor before the page rendered, and the New watch screen
  // handles its own 401 with a message that KEEPS the campground, dates and
  // filters already entered. Letting middleware intercept would throw that away.
  '/search',
  '/watches',
  '/settings',
  // The dedicated plans page (2026-08-01). Marketing — its whole audience is
  // signed out, and auth.protect() would 404 it for exactly those visitors.
  '/pricing',
  // The post-signup welcome step. Listed for the same reason `/new` is: Clerk
  // redirects here the instant an account is created, and if the session cookie
  // is not yet readable by middleware on that first request, auth.protect() would
  // answer 404 — a brand-new user's very first impression being a dead page. The
  // component renders its own signed-out state instead.
  '/welcome',
  '/new',
  '/campground/(.*)',
  // State landing pages — public by definition, they exist for search traffic.
  '/camping',
  '/camping/(.*)',
  '/w/(.*)',
  // The POST that confirms a "hold it for me". Authorised by the same token as /w/<token>
  // — the confirm step changes WHEN the action fires, not who may fire it — so it has to
  // be public for the same reason /w/ is: it is tapped from an email or a push
  // notification, by someone who is not signed in on that device.
  '/api/w/hold',
  '/b/(.*)',
  '/manage/(.*)',
  '/api/manage/(.*)',
  '/api/search(.*)',
  '/api/suggest(.*)',
  '/api/geo',
  '/api/likelihood(.*)',
  '/api/health/(.*)',
  '/api/campgrounds/(.*)',
  '/api/webhooks/(.*)',
  '/api/auto-cart/(.*)',
  // Claim a held RC site. Authorised by (hold id + the watch's manage token), not by a
  // login: the claim happens on a phone at 8am from an email link, and a sign-in wall
  // would spend the very seconds the hold exists to save. Both halves are unguessable
  // and the route checks them; Clerk would 404 it otherwise.
  '/claim/(.*)',
  // ENUMERATED, NOT `/api/rc-holds/(.*)`. The wildcard was written when every route under
  // it was token-authed, so it read as a description of the whole family — and then
  // `/api/rc-holds/mine` arrived, which is Clerk-authed and lists a user's own holds. A
  // blanket public matcher would have quietly opted it out of middleware protection, and
  // nothing about adding a file makes that visible. Naming the two token-authed routes
  // means the next one has to be added deliberately.
  '/api/rc-holds/claim',
  '/api/rc-holds/report',
  '/api/rc-proxy',
  '/api/tnsc-availability',
  // Vercel Cron entry points. Vercel invokes these unauthenticated as far as Clerk
  // is concerned, so auth.protect() would 404 them and the cron would "run" and
  // fail forever with nothing in the app's own logs. Each route does its own
  // secret check (CRON_SECRET bearer, or SYNC_SECRET by hand) and fails closed.
  '/api/cron/(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
