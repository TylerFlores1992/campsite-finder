-- Where a signup came from (2026-09-03). Main lane's block is 072-079; see docs/LANES.md.
--
-- THIS EXISTS BECAUSE NOTHING RECORDED IT. 38 real accounts, and not one of them carries
-- any trace of how it arrived -- no referrer, no campaign, not even the page it landed on.
-- Vercel Analytics is mounted in the root layout, but it is anonymous and page-level: it
-- can say a /camping/cabins page was viewed and it cannot say that view became an account.
-- So "which of the outreach emails, directory listings or SEO pages produced a user?" has
-- been unanswerable, and every growth decision so far has been taken without it.
--
-- ONE JSONB COLUMN, NOT FIVE TEXT ONES. The shape of what is worth capturing will change
-- (a new campaign parameter, a channel we have not met yet); a column per field means a
-- migration per field, and this is a diagnostic, not an entitlement. Nothing gates on it,
-- so a shape change can never break a paying customer.
--
-- FIRST TOUCH, WRITTEN ONCE, NEVER OVERWRITTEN. The writer is
-- `POST /api/user/signup-source`, whose UPDATE carries `WHERE signup_source IS NULL` -- the
-- same shape as `grandfathered` in migration 032, and for the same reason: the value is a
-- fact about an event that has already happened. A later visit from a different referrer is
-- a different question (retention, re-engagement) and must not be allowed to rewrite the
-- answer to this one. Reddit sends someone who signs up a week later from a Google search;
-- last-touch would credit Google and Reddit would look dead.
--
-- WHAT GOES IN IT IS DELIBERATELY NARROW, and the narrowness is the point:
--
--     {"ref": "https://www.reddit.com",     -- referrer ORIGIN only, never the path
--      "path": "/camping/cabins/california", -- landing PATHNAME only, never the query
--      "utm": {"source": "...", "medium": "...", "campaign": "..."},
--      "at": "2026-09-03T18:04:11.000Z"}
--
-- NEVER THE FULL LANDING URL. A query string is where a session token, an email address or
-- an OAuth code ends up, and this repo has published a credential twice by collecting a
-- field it then had to filter -- an OAuth authorization code on 2026-08-09 (reporting
-- `location.href` mid-Okta-flow) and a password on 2026-08-16. Origin plus pathname carries
-- the whole diagnostic value of a referrer with none of that exposure. `src/lib/acquisition.ts`
-- is the one place that decides, and its tests pin the refusal rather than the parsing.
--
-- IT IS SET BY THE CLIENT, SO TREAT IT AS UNTRUSTED. `document.referrer` and the landing URL
-- come from the browser and ride a first-party cookie; anyone can put anything in either.
-- That is acceptable for a diagnostic nothing gates on, and it is why the value is length-
-- capped and key-restricted on the way in rather than stored verbatim. Read it as evidence
-- about a population, never as a fact about one account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_source JSONB;

COMMENT ON COLUMN users.signup_source IS
  'First-touch acquisition: referrer origin, landing pathname, utm params. Written once by /api/user/signup-source, never overwritten. Client-supplied, so untrusted; nothing gates on it.';

-- NO INDEX. The only reader is scripts/funnel-readout.mts, over tens of rows, once in a
-- while. An index here would cost every signup a write to buy nothing.
