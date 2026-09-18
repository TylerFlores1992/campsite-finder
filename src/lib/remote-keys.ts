// What the /connect streamed sign-in window forwards to the remote rec.gov page.
//
// THE SURFACE.  `/connect`'s stream mode overlays a transparent <input> on the canvas so a
// phone's on-screen keyboard has something real to type into (a <canvas> cannot raise one).
// Nothing reads that input's value for its own sake; it is a BUFFER whose changes we diff
// and forward as keystrokes to whatever field the user tapped on the remote page.
//
// THE BUG THIS EXISTS FOR (reported 2026-09-18, Android).  The old diff had three arms:
// append -> send the new tail, trim -> send Backspaces, and "anything else" -> RE-SEND THE
// WHOLE VALUE.  The buffer is never cleared between remote fields, so after typing an email
// it still holds the email; the first Gboard composition/autocorrect while typing the
// password takes the third arm and re-types `<email><password-so-far>` into the password
// field.  It fires on EVERY keystroke that recomposes, which is exactly what was reported:
// "as I'm typing in password it starts auto filling the email in the password section with
// every keystroke".  Worse, that arm sent the new value WITHOUT deleting the old one, so the
// remote field accumulated rather than merely being wrong.
//
// THE FIX IS THE ORDINARY DIFF: longest common prefix, Backspaces for the rest of `prev`,
// then the rest of `next`.  Every case the old code handled specially falls out of it
// (append -> 0 Backspaces; trim -> 0 text), and the case it got wrong becomes a one-character
// correction instead of a replay.
//
// IT CAN NEVER DELETE MORE THAN IT TYPED, and that property is the safety argument for
// forwarding Backspaces at all: the count is bounded by `prev.length`, and `prev` only ever
// grows by characters this module has already forwarded.  A "select all and replace" from the
// keyboard therefore costs at most the keystrokes we sent since the last reset — never the
// contents of a remote field we did not put there.
//
// CODE POINTS, NOT UNITS.  `Array.from` so an astral character is never split into half a
// surrogate pair and forwarded as two broken chars.

export type RemoteKey = { t: 'text'; text: string } | { t: 'key'; key: string };

/**
 * The keystrokes that turn a remote field holding `prev` into one holding `next`.
 * One message per character on purpose — that is what the broker's
 * `page.keyboard.insertText` / `press` loop consumes, and it keeps a partially
 * delivered batch meaningful.
 */
export function diffKeystrokes(prev: string, next: string): RemoteKey[] {
  const a = Array.from(prev);
  const b = Array.from(next);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const out: RemoteKey[] = [];
  for (let k = a.length; k > i; k--) out.push({ t: 'key', key: 'Backspace' });
  for (let k = i; k < b.length; k++) out.push({ t: 'text', text: b[k] });
  return out;
}

/**
 * Keys that move the remote caret without changing our buffer's value, so the buffer stops
 * describing the field it was diffed against and has to be dropped.  Backspace and Delete are
 * deliberately NOT here: they shrink the value, so the diff above already sees them, and
 * forwarding them twice would eat a character the user meant to keep.
 */
export const CARET_MOVING_KEYS = [
  'Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
];
