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
  '/w/(.*)',
  '/b/(.*)',
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
