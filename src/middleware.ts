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
