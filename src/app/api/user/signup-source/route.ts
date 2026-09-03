import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requireAuth, syncUser } from '@/lib/auth';
import { mutate } from '@/lib/db/client';
import { SIGNUP_SOURCE_COOKIE, parseSignupSource } from '@/lib/acquisition';

/**
 * Stamp a new account with where it came from (migration 072).
 *
 * Called once by `Welcome`, which is where Clerk lands every new account. There is no GET:
 * the value is read by `scripts/funnel-readout.mts` against the database, and an endpoint
 * that hands an account its own acquisition record back would be a surface with no reader.
 *
 * THE VALUE IS READ FROM THE COOKIE SERVER-SIDE, NOT FROM THE REQUEST BODY. The client
 * already set the cookie, so taking it from the body would add a second way to supply the
 * same fact and no extra trust -- both are client-controlled. Reading it here keeps the
 * write path to one input, which is the thing that can be reasoned about.
 *
 * IT IS STILL UNTRUSTED, AND `parseSignupSource` IS WHY. A cookie can be hand-edited between
 * being written and being sent, so every cap and key restriction applied at capture is
 * applied AGAIN here -- otherwise they were never applied at all. Nothing gates on this
 * column, which is what makes an untrusted diagnostic acceptable in the first place.
 *
 * FIRST TOUCH IS ENFORCED IN THE `WHERE`, not in a read-then-write. Two tabs finishing the
 * welcome step at once would both see NULL and both write; `WHERE signup_source IS NULL`
 * makes the second a no-op inside the same statement. Same shape as `grandfathered`, which
 * the Stripe webhook is likewise forbidden to overwrite.
 */
export async function POST() {
  const userId = await requireAuth();
  await syncUser(userId);

  const jar = await cookies();
  const source = parseSignupSource(jar.get(SIGNUP_SOURCE_COOKIE)?.value);

  // No cookie, or nothing usable in it. Report it rather than writing an empty object: a
  // direct signup and a lost cookie are different facts, and `{}` in the column would make
  // them the same one -- the absent-reading-as-a-value mistake this repo keeps paying for.
  if (!source) return NextResponse.json({ ok: true, recorded: false });

  // JSON.stringify + an explicit ::jsonb cast. `sqlit` INTERPOLATES rather than binds and
  // now throws on a plain object, because handing it one once wrote the literal
  // '[object Object]' into a jsonb column and switched off an instrument for ten minutes.
  await mutate(
    `UPDATE users
        SET signup_source = $1::jsonb, updated_at = NOW()
      WHERE id = $2 AND signup_source IS NULL`,
    [JSON.stringify(source), userId]
  );

  // `recorded: true` means "we had something and asked for it to be stored", NOT "this row
  // now carries this value" -- the WHERE may have matched nothing because a first touch was
  // already recorded, which is the correct outcome and not a failure.
  return NextResponse.json({ ok: true, recorded: true });
}
