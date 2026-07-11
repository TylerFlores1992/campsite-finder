/*
 * Camp Hawk — ReserveCalifornia token grabber (runs in the PAGE's world).
 *
 * RC's auth token is stored AES-encrypted by Okta and only decrypted in the
 * page's JS memory, so a normal (isolated-world) content script can't read it.
 * This runs in the MAIN world at document_start and wraps XHR/fetch to capture
 * the live `accesstoken` (or `authorization`) header off RC's own API calls,
 * then hands it to our content script via window.postMessage. It never sends
 * the token anywhere else.
 */
(function () {
  let lastToken = null, lastCartKey = null;
  function post(v) {
    if (!v) return;
    const token = String(v).replace(/^Bearer\s+/i, '').trim();
    if (token.length > 20) { lastToken = token; window.postMessage({ __camphawk_token: token }, '*'); }
  }
  function setCartKey(k) {
    if (!k || !/^[0-9a-f-]{30,}$/i.test(k)) return;
    lastCartKey = k;
    window.postMessage({ __camphawk_cartkey: k }, '*');
  }
  // The real shoppingCartKey (a GUID) rides in RC request bodies AND URLs.
  function grabBody(body) {
    try {
      if (typeof body !== 'string' || body.indexOf('shoppingCartKey') < 0) return;
      const o = JSON.parse(body);
      if (o && o.shoppingCartKey) setCartKey(o.shoppingCartKey);
    } catch {}
  }
  function grabUrl(u) {
    try {
      const url = typeof u === 'string' ? u : (u && u.url) || '';
      const m = url.match(/shoppingCartKey=([0-9a-fA-F-]{30,})/);
      if (m) setCartKey(m[1]);
    } catch {}
  }
  // Re-broadcast so a listener that attaches after RC's initial calls still gets them.
  let n = 0;
  const iv = setInterval(() => {
    if (lastToken) window.postMessage({ __camphawk_token: lastToken }, '*');
    if (lastCartKey) window.postMessage({ __camphawk_cartkey: lastCartKey }, '*');
    if (++n > 20) clearInterval(iv);
  }, 1500);

  // Capture ONLY the RC-specific "accesstoken" header — other services (Okta,
  // analytics) set "authorization" with different tokens that would 401 here.
  const openXHR = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { try { grabUrl(u); } catch {} return openXHR.apply(this, arguments); };
  const setHdr = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, val) {
    try { if (String(k).toLowerCase() === 'accesstoken') post(val); } catch {}
    return setHdr.apply(this, arguments);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) { grabBody(body); return send.apply(this, arguments); };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        grabUrl(input);
        const h = (init && init.headers) || (input && input.headers);
        if (h) {
          if (typeof Headers !== 'undefined' && h instanceof Headers) post(h.get('accesstoken'));
          else post(h.accesstoken || h.Accesstoken);
        }
        if (init && init.body) grabBody(init.body);
      } catch {}
      return origFetch.apply(this, arguments);
    };
  }
})();
