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
