# Bottle Tree: Antique Estimates — RevenueCat Shipaton 2026

Paste-ready submission. Everything is final except the two lines marked **TODO**.
Deadline: **Sept 30, 2026, 11:45 pm PDT**.

---

## Submission fields

| Field | Value |
| --- | --- |
| Project name | Bottle Tree: Antique Estimates |
| Tagline | Photograph an antique, get an AI price estimate, list it. Inventory is free; estimates are the product. |
| Platform | Android (Google Play) |
| Package | `ai.banksy.bottletree` |
| Store link | **TODO** — live URL once review clears; submitted for review Sep 19, 2026 |
| Test link (works now) | https://play.google.com/apps/internaltest/4700209593663356261 |
| Video (<=2 min) | **TODO** — upload `bottletree_shipaton_2min.mp4` to YouTube, paste link |
| Repo | https://github.com/banksythequantLab/bottletree-appraiser |
| Web version | https://bottletree-app.dj-b02.workers.dev |
| Team | Derek Soltis — Banksy AI LLC |
| Categories | #BuildInPublic · Best Business / Productivity App |

---

## Inspiration

Every antique dealer knows the moment: someone sets a piece on the counter and asks what it's
worth. The honest answer used to be "give me an hour and a laptop" — you're searching sold
listings, squinting at a patent stamp, guessing at a maker's mark.

Bottle Tree started as a point-of-sale and inventory app for antique shops and garage sales.
The Shipaton was the push to take the part dealers actually wanted — the appraisal — and turn
it into something worth paying for.

## What it does

**Free forever:** sales, items, photos, sellers, cash and card checkout, and your own storefront
page. Inventory has never been the hard part, so we don't charge for it.

**The estimate:** shoot the piece from a few angles — front, back, underside, marks — type what
you know and any stamp you can read, and tap *Identify & price*. NVIDIA Nemotron 3 Super
identifies the piece, returns a price range with a suggested retail, and drafts the listing.
Your description outranks the model's guess, on purpose: you know the piece, it knows the market.

**Metered with RevenueCat:** one free estimate on sign-up, then $0.99 for one, $4.99 for ten,
$9.99/mo for 300, or $29.99/mo unlimited. Same account on web and on Android.

## How we built it

**App** — Capacitor 8 shell around the live PWA, so the session cookie, camera and storefront
all work unchanged, plus `@revenuecat/purchases-capacitor`. The web app detects the native
bridge and swaps its own paywall for RevenueCat offerings with live store prices.

**Backend** — Cloudflare Worker + D1 + R2. A credits-and-plans ledger, an atomic *consume
estimate* (unlimited -> monthly plan cap -> credits -> 402 paywall), automatic refunds when a
run fails, and a RevenueCat webhook that is idempotent on event id and understands Play's
`productId:basePlanId` format.

**Appraiser** — FastAPI on Nebius Token Factory. Gemma 3 27B reads the photos, Nemotron reasons
over an evidence sheet, Tavily pulls comparable sales. The same pipeline runs fully offline on a
laptop GPU (Nemotron Mini + Gemma 3 4B) for a counter kiosk with no internet.

## Challenges we ran into

Small vision models on real webcam frames were rough: qwen2.5vl aborted with a token-repeat
limit, qwen3-vl thought for 80 seconds a photo. Gemma 3 4B answers in 4-10 seconds. Then it
confidently named the *dealer* instead of the object, because the dealer's own description was
the first thing it read — fixed with guards that detect and ignore dealer text.

`getOfferings()` returns the offerings object directly. One wrong destructure made the paywall
say "store not reachable" for twenty minutes. Read the types.

Twelve days from "should we even charge for this?" to an app submitted for review, including
Play Console, JDK 21, signing keys, and a store listing.

## Accomplishments we're proud of

The whole purchase loop verified on a device, not on a slide: paywall -> purchase -> RevenueCat
webhook -> credits written to D1 -> the pill in the header updates to "11 estimates left"
without a reload. Subscription path too — Pro shows "300 of 300 left" and the gate respects it.

And a real appraisal on a real object: a cast-iron fluting iron with a worn 1878 patent stamp,
identified as Shepard Hardware Co. of Buffalo, $120-250, in about twenty seconds.

## What we learned

Meter the thing that costs you money, keep everything else free, and let the store handle the
receipts. Every hour spent on the credits ledger was worth it; every hour spent guessing at
store plumbing would have been wasted if RevenueCat hadn't abstracted it.

## What's next

eBay and Etsy one-tap crosslisting straight from the appraisal, the offline counter kiosk as a
shop tier, and iOS once the Apple account clears.

## Built with

android · capacitor · revenuecat · cloudflare-workers · cloudflare-d1 · cloudflare-r2 ·
fastapi · python · nvidia-nemotron · gemma · nebius · tavily · javascript

## Shipaton checklist

- [x] New app, built during the Shipaton
- [x] RevenueCat SDK integrated (`@revenuecat/purchases-capacitor`)
- [x] Live on a store — internal testing track active; production submitted for review Sep 19
- [x] Public repo
- [x] Video under 2 minutes (`bottletree_shipaton_2min.mp4`)
- [ ] Video uploaded to YouTube and linked
- [ ] Production store URL pasted once review clears
- [ ] #BuildInPublic posts linked (see `BUILD_IN_PUBLIC_DAY1.md`)
