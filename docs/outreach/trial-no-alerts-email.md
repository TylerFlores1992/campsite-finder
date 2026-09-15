# Email: a trial that ended with nothing to show

*Written 2026-09-15 for sheatullos@gmail.com. Reusable — the shape is what matters, the
numbers are per user and must be re-read before sending.*

## Where the numbers come from

Never send this with remembered figures. Re-run both, and use what they say:

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/grant-autocart-trial.mts --email=<them>   # read-only
```

and, for the "we checked and it never opened" line, the observation count per campground
(`availability_observations`, `had_opening`). For this user on 2026-09-15:

| campground | records | openings |
|---|---|---|
| Arapaho Bay | 155 | **0** |
| Collegiate Peaks | 161 | **0** |
| Willow Creek Group | 155 | **0** |

Last poller check: 8 seconds before the query ran. Fleet-wide over the same week: **one**
opening in 1,966 observations across 11 campgrounds. It was a quiet week everywhere, not a
quiet week for them.

## The rules this email follows

- **Lead with the number.** "We checked 471 times and it never opened" is the only thing in
  here that proves we did the work. Everything else is a claim.
- **Do not apologise for the absence of cancellations.** We did not cause it and cannot fix
  it, and apologising invites them to read it as a fault.
- **Never say a comp will get them a site.** Auto-cart acts when something opens. Nothing
  opened. Promising an outcome we cannot produce is worse than the quiet week.
- **Say the alerts keep running.** True — the poller filters on `active AND end_date >
  CURRENT_DATE`, not on the subscription — and it is the most generous accurate thing we can
  say.
- **Ask for one thing.** Widening the net is the ask. If they do nothing else, that.

---

## The email

**Subject:** Your CampHawk week — 471 checks, and what I'd change

Hi Shea,

You signed up a week ago for Arapaho Bay, Willow Creek Group and Collegiate Peaks,
24–27 September, and you haven't had a single alert from us. I wanted to tell you why
before your trial rolls over, because it isn't what it looks like.

We've been checking all three continuously since the 8th — the most recent check was
about a minute before I wrote this. Our log has 471 separate records across the three
campgrounds over that week, and **every one of them came back fully booked**. There was
nothing to tell you about. Not a missed alert; there was no cancellation to catch.

That's been true more widely — across everything we watched last week there was exactly
one opening. Late September is quiet.

**Two things you should know:**

**Your watches keep running whether or not you subscribe.** They're set to 24–27
September, and we'll keep checking them every day until that date passes. If a site frees
up on the 22nd, you get the alert.

**Three campgrounds on three fixed nights is a narrow net,** and that's the real reason
this week was silent. Two changes would do more for your odds than anything on our side:

1. **Turn on flexible dates.** Right now you're watching 24–27 exactly. If you can shift
   a night either way, "any 2 nights in this window" typically multiplies your chances —
   most cancellations don't line up neatly with one fixed range.
2. **Add a few more campgrounds nearby.** You're watching two spots in the Arapaho area
   and one near Buena Vista. Adding the neighbours costs you nothing and widens the net a
   long way.

You can also switch on text alerts — we have your number, but you're currently on email
and push only, and SMS is the fastest of the three.

If you'd rather not carry on, no hard feelings at all — cancel in Settings and the
watches will run out their dates regardless.

Thanks for giving it a week,
Tyler
CampHawk

---

## The optional paragraph, IF you decide to comp the auto-cart lane

Only include this if you have actually run the grant. Do not send it as an intention.

> I've also switched on **auto-cart** for your account through the 28th, at no charge —
> that's our paid tier, and it's the part I actually want you to see. When a watched site
> opens, instead of sending you an alert to race, it signs into your Recreation.gov
> account and puts the site in your cart. You get a notification and just check out.
>
> One thing only you can do: it needs your Recreation.gov login linked, once, in Settings
> → Auto-cart. Without that it can't act on your behalf. It takes a minute, and it's the
> difference between the two.

**Why the 28th and not "a week".** A seven-day comp from the 15th expires on the 22nd —
two days before their trip. The grant script takes a date rather than a duration for
exactly this reason.

**Do not send the paragraph without the rec.gov sentence.** The account reads
`autocart_connected = false`, so the grant gives them a switch that does nothing until
they link it. A comp they never activate is a comp that expires having proved nothing —
which is the failure this whole email is trying to avoid, repeated.
