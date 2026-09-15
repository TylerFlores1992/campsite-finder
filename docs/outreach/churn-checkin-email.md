# Email: checking in on somebody who cancelled

*Written 2026-09-15 for brentwolfe@hotmail.com. The shape is reusable; the facts are not —
re-read them per person before sending.*

## What actually happened, from the data

Not a bad experience. **Auto-cart worked for him.** Five attempts at Nevada Beach
Campground, all detected and acted on:

| when | site | outcome |
|---|---|---|
| Sep 1 16:51 | 037 | already-booked — somebody beat us |
| Sep 1 19:45 | 028 | already-booked → fell back to a normal SMS (delivered) |
| Sep 1 22:29 | 028 | already-booked |
| Sep 2 15:46:21 | 024 | add-not-confirmed |
| **Sep 2 15:46:52** | **014** | **CARTED in 8.2 seconds** → SMS delivered |

So the product did the thing it promises, once, for a real paying customer. **Whether he
checked out is the one thing we don't know, and it is the single most valuable piece of
feedback available** — it is the only real-customer auto-cart outcome we have.

The rest of the shape:

- Signed up **Sep 1** on Auto-Cart with a trial; trip was **Sep 4–7** (Lake Tahoe).
- Charged **$10 on Sep 8** when the trial converted.
- Cancelled — Stripe says **cancels Oct 8**, so he keeps access until then.
- Both watches are now `expired` (their dates passed). He has created no new ones.
- He muted **40 and 76 sites** across the two watches, so he was curating hard.
- Three of five openings were gone before we could cart them. That is real competitive data
  and worth knowing separately.

**Read this as a one-trip customer, not a dissatisfied one.** He needed a Labor Day weekend
site at Tahoe, got one, and stopped paying $10/month for a thing he needs twice a year. That
is a pricing/packaging signal, not a product failure — so the email should NOT open by
apologising or asking what went wrong.

## The rules this one follows

- **Ask one question.** "Did you get the site?" Everything else is optional for him to answer.
- **Do not try to save the sale in the first email.** He cancelled a week ago and is still
  active until Oct 8; a discount offer now reads as desperate and buys a month at best.
- **Say the access continues.** True, and it removes any urgency that would make this feel
  like a sales call.
- **Name the yearly plan once, without pushing.** $50/yr is the honest answer to "I only camp
  a couple of times a year", and it is the actual fix for this churn shape.

---

## The email

**Subject:** Did you get the Nevada Beach site?

Hi Brent,

I saw you cancelled — no problem at all, and you're still set up through Oct 8 if you
need anything before then.

I did want to ask one thing, if you don't mind: back on 2 September we managed to get
site 014 at Nevada Beach into your cart about eight seconds after it opened up. **Did
that one actually work out — did you get the booking?**

I'm asking because Recreation.gov only holds a cart for about fifteen minutes, and
what I can see on my end is that we put it there — not whether that was enough time
for you to check out. So it either got you the site or got you a full cart and a
headache, and I'd like to know which.

And if there was anything annoying about it — too many texts, the wrong sites, having
to link your Recreation.gov account — I'd rather hear it.

One thing in case it's useful down the line: if you're camping a couple of times a
year rather than every month, the yearly plan works out at about $4 a month instead of
$10. Might suit better than paying through the quiet stretch. No pressure either way.

Thanks for giving it a shot,
Tyler
CampHawk

---

## Do not add to this

- No discount code. He hasn't complained, and it turns a feedback request into a sales call.
- No "we're sorry to see you go" opener — it invites him to invent a reason he didn't have.
- No stats about the other four attempts. He does not need our diagnostics; the one question
  is what we want answered.
- **Never tell a customer they are the first at anything.** An earlier draft said "you're the
  first person to have the auto-cart actually fire on a real trip" — true, and it tells a
  paying customer the product is barely used. The REASON for asking has to stand on its own,
  so it is now the fifteen-minute cart hold: we can see that we carted it and cannot see
  whether he checked out. Same question, no admission.
