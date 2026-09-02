# iOS vs Android — where they actually differ

*Written 2026-09-01, after the fourth "whoops, another difference" in three weeks.*

The standing instruction is that **iOS is the baseline**. Every time we act on it we find one
more thing Android does differently, fix it, and hit the next one. This file exists so that
stops being a discovery process.

It has two halves, and **the split is the whole point**:

- **The explicit surface** — code that says `if (platform === 'android')`. It is small,
  entirely deliberate, and a scanner finds all of it. `src/lib/platform-parity.test.mts`
  keeps it registered, so a new one fails the build instead of surprising somebody.
- **The emergent surface** — the platforms behaving differently while running *identical*
  code. **This is where every bug that has actually cost us a campsite has lived**, no
  scanner can find it, and a test cannot enforce it. It is written down instead.

**IF YOU ARE HERE BECAUSE SOMETHING WORKS ON ONE PHONE AND NOT THE OTHER, START WITH THE
SECOND HALF.** The first half has never been the cause. **And read §2a first: the one that
cost a month was a two-step sign-in and a plugin that kills in-flight requests on close.**

---

## 0. THE CONFOUNDER THAT INVALIDATES THE COMPARISON ITSELF

**The two devices are not running the same generation of native code, and nothing says so.**

On 2026-09-01 the hand-off traces read `[ios build 1.0 (21)]` and `[android build 1.0 (25)]`.
CLAUDE.md dates build 21 to **2026-08-09**. The Android build is from **2026-08-29/30**.

So the comparison everybody has been running is not iOS versus Android. It is a
**three-week-old shell versus a current one**, and at least one native dependency differs:
`@revenuecat/purchases-capacitor` was added on 2026-08-29 (#218), so **the iPhone build does
not contain it at all.**

**`PROJECT_BUILD_NUMBER` is PROJECT-WIDE, not per-workflow**, so the two numbers are on one
sequence and 21 really is older than 25. `codemagic.yaml` asserted the opposite in two
separate comments until this was written; the evidence against them is in CLAUDE.md, which
records `android-release` **build 8** producing **versionCode 16** — a per-workflow counter
would have produced 8.

**BEFORE COMPARING ANYTHING, COMPARE THE BUILD NUMBERS.** They are in every hand-off trace
and in the diagnostics panel. A difference in behaviour between builds three weeks apart is
not evidence about platforms.

---

## 1. The explicit surface — ten lines, five files, none in the RC flow

Registered in `src/lib/platform-parity.test.mts`. A branch that is not registered fails.

| File | What differs | Why |
|---|---|---|
| `lib/native/context.tsx` | the UA sniff itself | Android tested FIRST — an Android UA also contains "Linux" and some webviews carry both |
| `components/NativeBridge.tsx` | `StatusBar.setBackgroundColor` | Android-only API; it **throws** on iOS |
| `components/NativeBridge.tsx` | hardware back button | iOS has no hardware back. Without the listener Capacitor exits the app from any screen |
| `components/v2/nativeSubscribe.tsx` | `LINKOUT_BY_STORE` `{ios:true, android:false}` | both store carve-outs are **US-storefront only**; iOS is US-only, the Android track is deliberately worldwide |
| `components/v2/nativeSubscribe.tsx` | `IN_APP_PURCHASE_BY_STORE` `{ios:false, android:true}` | Play products exist; Apple's do not yet (`docs/STOREKIT-PLAN.md` §4e) |
| `lib/native/purchases.ts` | RevenueCat API key | one key per store, by construction |
| `lib/notifications/push.ts` | `android: { priority: 'high' }` | FCM's own per-platform payload |

**Not one of these is in the sign-in, hand-off, precart or cart path.** `rc-login-script.ts`
and `rc-precart-script.ts` contain **no functional platform branch at all**.

### The near-misses that are not branches

- **`rc-precart-script.ts` report transport** — prefer the raw `cordova_iab` global, fall
  back to `window.webkit.messageHandlers.cordova_iab`. Not a branch: it is one expression
  that works on both. It matters because Android's plugin aliases the webkit shape in
  `onPageFinished` via an async `evaluateJavascript`, which **races our `loadstop`
  injection** — get the order wrong and roughly the first report of every Android run is
  dropped. Diagnostics only; it cannot affect a cart.
- **`IAB_OPTIONS`** — `hardwareback=no` is meaningful only on Android, and
  `presentationstyle=fullscreen` only on iOS (Android's InAppBrowser is already
  full-height and ignores it). Both are sent to both. Cosmetic and navigational, not
  functional.
- **`capacitor.config.ts`** has an `ios:` block and no `android:` block. The one key in it,
  `limitsNavigationsToAppBoundDomains`, is an iOS-only concept. Not a gap.

### Build-config asymmetry, checked and benign

`ios-testflight` asserts the **RevenueCat pod**; `android-release` asserts the **Play Billing
permission in the merged manifest**. Different mechanisms, same property — on Android the
permission only appears when the billing library is linked, which is what RevenueCat pulls
in. The remaining iOS-only steps (export compliance, location usage string, push capability,
code signing) are Apple requirements with no Android counterpart, and `android-release`'s
extra steps (target API level, version code, keystore, signature verification) are Play's.

**`worker/codemagic-assertions.test.mts` checks each workflow on its own and has never
compared them to each other.** That is fine for the steps above, which are legitimately
different, and it is why a genuine gap would not be caught. Read the side-by-side rather
than trusting the suite.

---

## 2. The emergent surface — where the bugs live

Identical code, different behaviour. **Every one of these has cost us something.**

### 2a. THE ONE THAT WAS THE BUG — RC's sign-in is two steps and the plugins kill step two differently (RESOLVED 2026-09-01, #249)

Read out of RC's own bundle (`index-BvrbWbr2.js`), not inferred:

```
step 1  Okta callback  -> localStorage.ssoAccessToken (the JWT we capture), isLoggedIn: false
                          then:  GET WebAccessCustomer/SSO/GetSSOLoggedInUser?uniqueIdentifier=<sub>&email=<email>
step 2  its RESPONSE   -> customerId, customerName, accessToken (RC's OWN token), customerDetail
                          isLoggedIn: true, then a CLIENT-SIDE navigation to oktaOriginalUri
boot                   isLoggedIn: !!localStorage.getItem("customerId")
```

The header name is `customerName`; the cart page's API client requires RC's `accessToken` and,
when it is null, dispatches `customerLogOut` — which also deletes `ssoAccessToken`. So a session
cut off between the steps has a working Okta token (the cart POSTs succeed), no name, a login
prompt on the cart page, and a token that then vanishes.

**We were closing between the steps.** `rc-inject.js` captures the token off RC's outbound
`accesstoken` header, and the first such call after the callback IS step two's request — so
`token captured` marks the instant step two LEAVES, and every close rule we ever shipped was a
race against its response. #240's 10s timer could never `settle` (client-side navigation, no
`loadstop`) and fired on both platforms every time.

**The platform difference is in the InAppBrowser plugin, not in our code or the webviews'
storage.** Android's `closeDialog` navigates the WebView to `about:blank`, killing the in-flight
request instantly. iOS's `close` only dismisses the view controller; the WKWebView keeps running
until it is torn down later, so a request in flight finishes and writes `customerId`. That is why
iOS survived the same close and Android did not.

**Fixed by closing on RC's own signal.** The bundle reports `rc-session { loggedIn }` —
`!!customerId`, a boolean — on install and when it flips; the host closes on `true` and on
nothing else; no timer closes a sign-in window any more. If step two never finishes, a notice
inside the window says "when you see your name, tap Done", which is the configuration the 08-31
hand bisect proved works.

### 2a′. The password manager decides which Okta page you land on — REAL, but not the cause

```
iOS      signin-missing {candidates:6} → email → password → submitted
Android  signin-open {}                →         password → submitted
```

Android skipped Okta's identifier page because a password field was already present, and "Keep
me signed in" lives on the identifier step — so on that path nothing ticks it. **This decides
whether the NEXT sign-in is cookie-answered or a password form** (CLAUDE.md, 2026-08-09). It
does NOT decide the header name; that is `customerId`, above. It was reported as the leading
candidate on 09-01 evening and it was the wrong explanation for the empty header. Still
path-dependent, not platform-dependent, and still worth reporting (`keep-signed-in`).

### 2b. Cookie stores — RETIRED as an explanation for RC's login state

RC writes no session cookies of its own (the only `document.cookie` in its bundle is axios's
XSRF helper); its login state is localStorage, above. Okta's cookies decide only whether the
next sign-in needs a password. The CookieManager/WKWebsiteDataStore theory predicted the wrong
direction anyway (Android more durable, not less) and is recorded here so nobody reaches for it
again without new evidence.

### 2c. Two native implementations behind one plugin

`cordova-plugin-inappbrowser` is two separate native codebases. Known consequences: the
message-channel race in 2a's transport note; `presentationstyle` honoured on one side only;
`CDVWKInAppBrowser.m`'s handler having two branches of which only the string one is ours.
**A behaviour proven on one platform's InAppBrowser is not proven on the other's.**

### 2d. Webview engines

WKWebView (WebKit) versus Android System WebView (Chromium): different JS engines, different
CSS, different storage semantics, and **different versions in the field** — Android's updates
through Play independently of the OS, so two Android phones need not match either.

### 2e. RC's own behaviour may key on the User-Agent

`appendUserAgent: 'CampHawkApp'` rides on top of each platform's default UA, and
`rc-handoff.ts` records the deliberate decision not to override it. RC and Okta are free to
serve different flows to different agents. **Unmeasured** — do not assert it either way.

---

## 3. How to compare them without losing an evening

1. **Check the build numbers first.** Different builds, different experiment. (§0)
2. **Read the STAGES, not the outcome.** The 09-01 traces matched on every outcome field —
   `✓ Added to cart`, `cart read back: 1 entry`, `close: timeout`, the okta census — and
   diverged four stages earlier. The outcome fields are the ones that look decisive and are
   not.
3. **Ask for the screen.** `cart read back: 1 entry` is RC answering *our* question with
   *our* key. It has never once been corroborated by a human on either platform. The only
   proof of reachability is somebody looking at RC's cart page.
4. **A result on one platform is not a result on the other**, and the reverse is equally
   true: an Android-only symptom does not make the cause Android-specific. 2a looked like an
   Android bug for a day and is a path-dependent one.

---

## 4. What is deliberately NOT enforced

`platform-parity.test.mts` covers §1 only. **There is no mechanism for §2 and there cannot
be one** — the whole property is that the code is identical. Claiming otherwise would be a
guard that inspects nothing while reading as proof, which this repo has shipped and paid for
several times.

What reduces §2 instead is instrumentation: the hand-off record has to carry the facts that
*differ*, or two runs produce the same trace and the difference stays invisible. That is what
`keep-signed-in` and the sign-in-path line were added for, and it is the right place to spend
effort the next time this happens.
