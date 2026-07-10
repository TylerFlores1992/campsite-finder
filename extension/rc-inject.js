/*
 * CampHawk — ReserveCalifornia token grabber (runs in the PAGE's world).
 *
 * RC's auth token is stored AES-encrypted by Okta and only decrypted in the
 * page's JS memory, so a normal (isolated-world) content script can't read it.
 * This runs in the MAIN world at document_start and wraps XHR/fetch to capture
 * the live `accesstoken` (or `authorization`) header off RC's own API calls,
 * then hands it to our content script via window.postMessage. It never sends
 * the token anywhere else.
 */
(function () {
  let last = null;
  function post(v) {
    if (!v) return;
    const token = String(v).replace(/^Bearer\s+/i, '').trim();
    if (token.length > 20) { last = token; window.postMessage({ __camphawk_token: token }, '*'); }
  }
  // Re-broadcast the last token for a while, so a listener that attaches after
  // RC's initial API calls still receives it.
  let n = 0;
  const iv = setInterval(() => {
    if (last) window.postMessage({ __camphawk_token: last }, '*');
    if (++n > 20) clearInterval(iv);
  }, 1500);

  // Capture ONLY the RC-specific "accesstoken" header — other services (Okta,
  // analytics) set "authorization" with different tokens that would 401 here.
  const setHdr = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, val) {
    try { if (String(k).toLowerCase() === 'accesstoken') post(val); } catch {}
    return setHdr.apply(this, arguments);
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const h = (init && init.headers) || (input && input.headers);
        if (h) {
          if (typeof Headers !== 'undefined' && h instanceof Headers) post(h.get('accesstoken'));
          else post(h.accesstoken || h.Accesstoken);
        }
      } catch {}
      return origFetch.apply(this, arguments);
    };
  }
})();
