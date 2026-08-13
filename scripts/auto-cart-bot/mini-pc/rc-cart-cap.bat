@echo off
REM ===========================================================================
REM  Is ReserveCalifornia's "maximum 2 in cart" a limit on the CART or on the
REM  ACCOUNT?  This is the one measurement that changes how many holds we can
REM  run at one release.
REM
REM  WHY IT MATTERS.  RC_HOLD_CAPACITY is RC_SITES_PER_CART (2, measured, RC's)
REM  times RC_MAX_CARTS (1, ours - and 1 ONLY because that is all we can prove).
REM  The hold runner has always funnelled every hold into one cart, so on
REM  2026-08-13 the third hold of one morning was refused in RC's own words:
REM  "The maximum number of reservations allowed in the cart is '2'."  Nothing
REM  of ours failed.  If the cap is per CART the fix is one line in the runner
REM  and the ceiling stops being 2.  If it is per ACCOUNT then concurrency
REM  costs identities, which is a far more expensive answer.
REM
REM  IT LOCKS THREE REAL CAMPSITES for the length of the run and releases them
REM  again in a finally, including on a throw.  It only ever removes entries it
REM  created, never empty/shoppingcart, so a real hold in the bot's cart is
REM  untouched - and it saves and restores the probe profile's cart pointer.
REM
REM  RC serves a reCAPTCHA on sign-in, so this is HEADFUL and a human has to be
REM  here.  A browser window will open and drive itself; solve the challenge if
REM  one appears, then leave it alone.
REM
REM  --------------------------------------------------------------------
REM  TWO CONFOUNDS.  BOTH PRODUCE THE PESSIMISTIC ANSWER, WHICH IS THE
REM  EXPENSIVE ONE TO BELIEVE.  Clear them before you press a key:
REM
REM   1. THE BOT'S CART MUST BE EMPTY - no hold in 'carted' or 'claiming'.
REM      Check with:  npx tsx scripts/rc-holds-readout.mts
REM
REM   2. YOUR PHONE'S RC CART MUST BE EMPTY TOO, and the probe's own header
REM      does not say this.  The claim flow now carts inside the app, on YOUR
REM      ReserveCalifornia session - and if that is the same RC account the bot
REM      uses (there is only one), a site sitting in your phone's cart occupies
REM      exactly the seat a per-ACCOUNT cap is being tested for.  Step 4 would
REM      then be refused for a reason that has nothing to do with carts.
REM      Open reservecalifornia.com/Customers/ShoppingCart on your phone and
REM      make sure it is empty.  A completed BOOKING is fine - that is a
REM      reservation, not a cart entry.
REM  --------------------------------------------------------------------
REM
REM  Do not run this near 08:00, or with a hold queued for the next release.
REM ===========================================================================
setlocal
cd /d "%~dp0.."

REM Pfeiffer Big Sur SP - Weyland Camp, verified genuinely bookable on
REM 2026-12-01 by scripts/rc-test-hold.mts --find.  Far future, midweek,
REM off-peak: three locks for ten minutes costs nobody anything.
REM
REM NEVER INVENT A UNIT ID.  An invented one can collide with a real site and
REM lock it.  To pick different ones, run --find and paste from its output.
set RC_CAP_UNITS=43793,43794,43795
set RC_ARRIVAL=2026-12-01
set RC_NIGHTS=1

echo(
echo === RC cart cap probe ===
echo   units   %RC_CAP_UNITS%
echo   arrival %RC_ARRIVAL% (%RC_NIGHTS% night)
echo(
echo   This locks three real campsites and releases them again.
echo   Before you continue, confirm BOTH carts are empty - the bot's
echo   (rc-holds-readout says no 'carted' or 'claiming' row) AND the one
echo   in the CampHawk app on your phone.
echo(
pause

REM No profile juggling: the probe runs on .rc-probe-profile, so it does not
REM touch the lock the keep-warm and the hold runner share.  Deliberately does
REM NOT stop them - the RC session they hold is what carts at 08:00.
if not exist "logs" mkdir "logs"
powershell -NoProfile -Command "node rc-probe.mjs --cart-cap --headful 2>&1 | Tee-Object -FilePath logs\rc-cart-cap.log; exit $LASTEXITCODE"

echo(
echo === HOW TO READ IT ===
echo   Look for the line beginning with a tick or a cross under step 6.
echo(
echo   "THE CAP IS PER CART"      =^> the ceiling is OURS.  The hold runner
echo                                 reuses one cart key and need not.  Raise
echo                                 RC_MAX_CARTS.
echo   "THE CAP IS NOT PER CART"  =^> the ceiling is the ACCOUNT.  More holds
echo                                 at once means more identities.
echo   "RC PUT IT BACK IN THE SAME CART" =^> a second cart is not obtainable
echo                                 this way.  Treat the cap as binding.
echo   "INCONCLUSIVE"             =^> it says which step failed and why.  This
echo                                 is NOT an answer - do not round it to one.
echo(
echo   Anything else, send logs\rc-cart-cap.log.
echo(
pause
