import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Protect all routes except public ones
const isPublicRoute = createRouteMatcher([
  '/',
  '/privacy',
  '/terms',
  '/sms-opt-in',
  '/auto-cart',
  '/robots.txt',
  '/sitemap.xml',
  '/campground/(.*)',
  '/api/search(.*)',
  '/api/suggest(.*)',
  '/api/health/(.*)',
  '/api/campgrounds/(.*)',
  '/api/webhooks/(.*)',
  '/api/auto-cart/(.*)',
  '/api/rc-proxy',
  // Guarded by its own x-sync-secret header, not Clerk. Must be public or the
  // middleware 404s it (same trap as /robots.txt and /sitemap.xml).
  '/api/gtc-proxy',
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
