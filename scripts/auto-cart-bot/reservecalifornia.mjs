// ReserveCalifornia (CA State Parks) is intentionally NOT auto-carted by the bot.
// RC's cart lives in in-browser/session state (not tied to your account server-side),
// so a desktop add-to-cart wouldn't sync to your phone — which defeats the point when
// you're away. Instead, CampHawk's email/text alert links straight to the RC booking
// page: tap it on your phone (where you're logged in) and finish there in a few taps.
// So here we just log a one-line note; the alert does the real work.

export async function noteReserveCalifornia(job, log) {
  const url = job.bookingUrl.split('#')[0] || 'https://www.reservecalifornia.com/';
  log(`  ↗ CA State Parks opening: ${job.campgroundName} (${job.startDate}) — grab it from the CampHawk alert on your phone → ${url}`);
}
