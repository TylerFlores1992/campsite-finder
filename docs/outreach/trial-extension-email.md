# Email: extending a quiet trial, with auto-cart switched on

*Sent to sheatullos@gmail.com 2026-09-15. Short on purpose — the previous draft was too
wordy and buried the two sentences that matter.*

## Before you send this, the Stripe half must be done BY HAND

The auto-cart grant is applied (`users.autocart_trial_until` → 2026-09-24 23:59:59 PT).
**Extending the paid trial is a separate thing and only Stripe can do it** — `api.stripe.com`
is unreachable from an agent session, so nobody here can move it.

Stripe → Customers → their subscription → **Update subscription → trial end → 24 Sep 2026**.

Do it first. The email says "your trial is extended", and if the Stripe trial has not moved
they get charged instead — which turns a goodwill email into a billing complaint.

## What is already true

| | |
|---|---|
| auto-cart grant | live, expires 24 Sep 23:59:59 PT, lapses by itself |
| subscription row | untouched — still `base` / `trialing` |
| rec.gov linked | **no** — the grant does nothing until they link it |
| their auto-cart switch | off |

---

## The email

**Subject:** A bit longer on us — and auto-cart switched on

Hi Shea,

Quick note about your CampHawk trial: you haven't had a single alert from us this
week, and I wanted to explain why before it ran out.

It's not that we missed anything. We've been checking Arapaho Bay, Willow Creek Group
and Collegiate Peaks continuously since you signed up, and all three have simply
stayed fully booked — there hasn't been a cancellation to tell you about.

That's pretty normal this far out. Cancellations tend to land closer to the trip,
often in the week or so before, as people's plans change. Your dates are the 24th, so
the busy stretch is really just starting.

So a couple of things from us:

**We've extended your trial through the 24th**, so you get that window for free rather
than paying for a quiet week.

**We've also upgraded you to auto-cart for the rest of the trial** — normally our
higher tier. Instead of just telling you a site opened up, it signs into your
Recreation.gov account and puts the site in your cart, so you check out instead of
racing everyone else who got the same alert.

That one needs a nudge from you: it won't do anything until you connect your
Recreation.gov login under **Settings → Auto-cart**. Takes a minute, and it's entirely
optional — leave it off and your normal alerts carry on exactly as they are.

Either way we'll keep watching all three right up to your dates. Hope we can catch you
something.

Thanks for giving us a go,
Tyler
CampHawk

---

## Notes on what this does and doesn't claim

- **"Cancellations tend to land closer to the trip"** is stated as a tendency, not a
  statistic. We have no data supporting a number — our own week showed one opening across
  the whole fleet — so do not let this harden into "70% of cancellations happen in the final
  week" in a later draft.
- **It never promises they'll get a site.** Auto-cart acts when something opens; if nothing
  opens it is as quiet as this week was.
- **It says the grant is optional and needs their action.** Without that sentence the comp
  expires having never run, which is the exact failure the email exists to avoid.
- **No numbers.** The 471-check figure was in the previous draft and was cut — it reads as
  defensive, and "we've been checking continuously" says the same thing in five words.
