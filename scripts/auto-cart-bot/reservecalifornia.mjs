// ReserveCalifornia (CA State Parks). RC is a Redux SPA whose cart key lives in
// in-memory state, so a fully-silent add-to-cart isn't reliable yet. For now the
// bot opens the booking page in your logged-in session and surfaces exactly which
// unit + dates to grab, so you finish in a couple of clicks. (rec.gov is full-auto.)

export async function cartReserveCalifornia(context, job, log) {
  // Fragment: #camphawk-rc=<unitId>_<arrival>_<nights>_<sleepingUnitId>
  const frag = (job.bookingUrl.split('#camphawk-rc=')[1] ?? '').split('&')[0];
  const [unitId, arrival, nights] = frag.split('_');
  const url = job.bookingUrl.split('#')[0] || 'https://www.reservecalifornia.com/';
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log(
      `  ↗ OPENED (finish in tab): ${job.campgroundName} — arrival ${arrival || job.startDate}` +
        (nights ? `, ${nights} night(s)` : '') +
        (unitId ? `, unit #${unitId}` : '')
    );
    return true; // leave open for you to complete
  } catch (err) {
    log(`  ✗ RC error for ${job.campgroundName}: ${err.message}`);
    await page.close().catch(() => {});
    return false;
  }
}
