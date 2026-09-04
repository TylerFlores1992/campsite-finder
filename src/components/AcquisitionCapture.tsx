"use client";

import { useEffect } from "react";
import {
  SIGNUP_SOURCE_COOKIE,
  SIGNUP_SOURCE_COOKIE_MAX_AGE_S,
  captureSource,
} from "@/lib/acquisition";

/**
 * Records the FIRST page of a visit into a first-party cookie, so that when (or if) it
 * becomes an account, we can say where it came from. Renders nothing.
 *
 * IT IS IN THE ROOT LAYOUT AND HAS TO BE. The pages this exists to measure -- `/camping`,
 * `/camping/<state>`, the accommodation-type hubs, `/campground/<id>` -- are the SEO surface
 * and sit OUTSIDE the `(app)` route group. Mounting this in the `(app)` layout instead would
 * miss exactly the traffic it was built for, and would look like it was working.
 *
 * A CLIENT COMPONENT, and it must stay one: `document.referrer` is the whole point and only
 * the browser has it. It is also why this cannot be done server-side in the layout -- a
 * request-time API (`headers()`/`cookies()`) in the ROOT layout throws and 500s every page,
 * which took the site down in July 2026. Nothing here is async and nothing here touches the
 * server.
 *
 * FIRST TOUCH: the cookie is read before it is written, so a visitor who arrives from Reddit,
 * browses four pages and signs up tomorrow is still a Reddit signup. See `lib/acquisition.ts`
 * for why last-touch would cut the channel that actually worked.
 *
 * THE WHOLE BODY IS IN A TRY. This is a diagnostic; `document.cookie` throws outright when a
 * browser is set to block site data, and a page that fails to render because an analytics
 * line threw is a far worse outcome than a missing row.
 */
export default function AcquisitionCapture() {
  useEffect(() => {
    try {
      const already = document.cookie
        .split("; ")
        .some((c) => c.startsWith(`${SIGNUP_SOURCE_COOKIE}=`));
      if (already) return;

      const source = captureSource({
        href: window.location.href,
        referrer: document.referrer,
      });
      if (!source) return;

      // SameSite=Lax, not Strict: sign-up leaves for Clerk and comes back, and Strict drops
      // the cookie on a cross-site top-level navigation -- which would lose the value on the
      // one journey it exists to survive.
      document.cookie =
        `${SIGNUP_SOURCE_COOKIE}=${encodeURIComponent(JSON.stringify(source))}` +
        `; Path=/; Max-Age=${SIGNUP_SOURCE_COOKIE_MAX_AGE_S}; SameSite=Lax`;
    } catch {
      /* A page must never fail to render because a diagnostic could not be written. */
    }
  }, []);

  return null;
}
