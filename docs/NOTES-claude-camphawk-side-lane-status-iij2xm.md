# Side-lane notes — `claude/camphawk-side-lane-status-iij2xm` (2026-09-16)

For the main lane to fold into `CLAUDE.md`. Inference is labelled as inference. Everything
else was measured, and says how.

**`ls docs/NOTES-*.md` returns TWO files now** — this one and
`docs/NOTES-claude-side-lane-setup-f7bpe2.md` (the previous side lane's, §1-§30). The glob
in `docs/LANES.md` finds both; a fold-in that reads only the older one misses this.

---

## 1. GOOGLE CLOUD: THREE PROJECTS, AND THE LIVE ONE IS THE UNBILLED ONE (2026-09-16)

Owner asked what CampHawk uses Google Cloud for and how to check its billing. **The answer
is "two things, and neither can cost anything" — but getting there turned up three Cloud
projects with near-identical names, two of which have a billing account attached.**

**Full write-up is `docs/PLAY-STORE.md` §0e** (side-lane file, so it lives there rather than
here). The part worth carrying into `CLAUDE.md` is the shape, not the console state:

### What we use Google Cloud for — two service accounts, one project between them

1. **Firebase Cloud Messaging.** `src/lib/notifications/push.ts` posts to
   `fcm.googleapis.com/v1/projects/<project_id>/messages:send`, minting an OAuth token via
   `oauth2.googleapis.com/token` from a service-account JWT in `FCM_SERVICE_ACCOUNT`.
   Native halves are `GoogleService-Info.plist` / `google-services.json`, injected at build
   time by `codemagic.yaml` from `GOOGLE_SERVICE_INFO_PLIST_B64` / `GOOGLE_SERVICES_JSON_B64`.
2. **The Play Developer API.** A second service account whose JSON key lives in Codemagic as
   `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS` (group `google_play`), uploading every green
   `android-release` AAB to the `alpha` track. Setup record is `docs/PLAY-STORE.md` §0b.

Play Console, Play Billing (which we reach through RevenueCat) and Search Console are Google
but are **not** Cloud billing surfaces.

### THE HEALTH ROUTE ALREADY NAMES THE PROJECT, AND NOBODY HAD READ IT

```
$ curl -s https://camphawk.app/api/health/status
delivery:push_web | ok | FCM service account loads (project campapp-39c4b), matching the worker
delivery:push     | ok | FCM credential valid — access token minted for project campapp-39c4b
```

That is `push.ts` printing `sa.project_id` out of the live credential. **One curl settles
which of three identically-named projects is load-bearing** — and it is `campapp-39c4b`,
the one the console lists as **"Billing is disabled"** and Firebase reports as **Spark /
No-cost**. The instrument was running and unread, which is this file's most-repeated shape.

- **`FCM_SERVICE_ACCOUNT` IS NOT IN AN AGENT SESSION'S ENV** (`printenv` finds nothing) —
  it is a Vercel variable. So a session must ask PRODUCTION for the project id, and the
  CLAUDE.md rule that "the credentials are process env vars, there is no `.env` file" does
  **not** cover this one. Worth a line, because absence here reads as a missing credential.

### THE READING RULE: an ACCOUNT TYPE beats a COST FIGURE

Two separate readings answered "has this ever charged us", and in both cases the structural
fact is stronger than the number sitting next to it:

- **"Billing is disabled"** on the live project ⇒ it *cannot* charge, not merely that it
  did not this month.
- The single billing account is a **free trial** (`$300.00 credit, 12 days left`, banner read
  2026-09-16, so expiring **~2026-09-28** — arithmetic off a banner, not a stated date).
  **A trial cannot charge the card**; Google requires an explicit *Upgrade*. The `$0.00` for
  September 1-16 is corroboration and covers one month.

Same family as `status = 'sent'` meaning only "Twilio returned 2xx": the number is accurate
and it is not the question. **Read the billing column before reading the cost.**

### RECOMMENDATION RECORDED: let the trial lapse, do NOT upgrade

Nothing we use needs a billing account — FCM already runs without one, and the Play Developer
API has no charge. **Upgrading is the act that creates the ability to be charged.**

**One check first: where does the Play publisher service account live?** If it is in one of
the two billing-attached projects (`camp-hawk`, `camp-501802`), the first `android-release`
build after the lapse is the test. **Service accounts and no-charge APIs are EXPECTED to
survive a billing account closing — general Google behaviour, NOT tested on this setup, so
do not record it as established.** The failure mode is a red CI step naming *"The caller does
not have permission"*, which §0b already warns reads like a Play problem and sends you to the
wrong console. Re-enabling billing on that one project is a minutes-long fix.

**Prefer unlinking billing to deleting a project** — deleting takes any service account inside
it with it, surfacing weeks later as a broken publish with no obvious cause. The trial lapsing
unlinks both stray projects on its own, so the likely correct action is **none**.

### NOT RECORDED ANYWHERE: the billing account id

It is an identifier rather than a credential, and it is in the console URL — but **this
repository is public**, and a Firebase project id is public by construction (it ships inside
`google-services.json` in the app binary) where a billing account id is not. The project ids
above are safe to write down for exactly that reason; the billing account id is not written
down for exactly that reason.

### THIS EXISTED ONLY IN A CHAT, WITH A DATED DECISION ATTACHED

Every figure above came from owner screenshots; `gcloud` is absent and the billing console is
human-only. That is the same shape as the Apple submission state that "existed only in the
conversation, so every compaction re-derived it from screenshots" — and this one carries a
~12-day deadline. Written down for that reason rather than because the state is alarming:
**the state is fine, and the risk was that nobody would remember it was fine.**

### NOT INVESTIGATED

- **What is in `camp-hawk` and `camp-501802`.** Only that both have billing attached and
  neither is the FCM project. An all-time **Billing → Reports, grouped by Project** would
  settle whether either ever accrued anything; only the current month was read.
- **Whether more than one FIREBASE project exists.** The Firebase console showed one; the
  Cloud list showed three. Two of the three may not be Firebase projects at all.
- **Google Cloud has no row in the admin Costs tab**, and neither does the $25 Play developer
  registration ("Android Testers" $15 is there). Expected for Cloud at $0; the Play fee is an
  actual gap. Ten rows read 2026-09-16: Vercel $20, Supabase $25, Claude $20, Fly $5.11
  monthly; domain $15 and Apple Dev $99.99 yearly; four one-times.
