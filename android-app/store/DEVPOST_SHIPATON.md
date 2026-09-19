# Bottle Tree: Antique Estimates — RevenueCat Shipaton 2026 submission

**Tagline:** Photograph an antique, get an AI price estimate, list it. Free inventory; estimates are the product.

**Store:** Google Play — `ai.banksy.bottletree` (link once production is live)
**Video:** (YouTube link to bottletree_shipaton_2min.mp4)
**Repo:** https://github.com/banksythequantLab/bottletree-appraiser
**Categories:** #BuildInPublic · Best Business/Productivity · Kotlin/Android

## Inspiration
Every antique dealer knows the moment: someone sets a piece on the counter and asks "what's it worth?" The
honest answer used to be "give me an hour and a laptop." Bottle Tree started as a point-of-sale for antique
shops and garage sales; the Shipaton was the push to turn the appraiser into something people pay for.

## What it does
- Free forever: sales, items, photos, sellers, cash/card checkout, and your own storefront page.
- Estimates: shoot front/back/underside/marks, type what you know and the marks you can read, tap
  **Identify & price**. NVIDIA Nemotron 3 Super (on Nebius Token Factory) identifies the piece, returns a price
  range with a suggested retail, and drafts the listing. Your text outranks the model's guess, on purpose.
- Metered with RevenueCat: $0.99 single, $4.99 for 10, $9.99/mo Pro (300/mo), $29.99/mo Unlimited. One free
  estimate on sign-up. Same account on web and Android.

## How we built it
- App: Capacitor 8 shell around the live PWA (same origin → session cookie, camera and storefront unchanged) +
  `@revenuecat/purchases-capacitor`. The PWA detects the native bridge and swaps its paywall to RevenueCat
  offerings with live store prices.
- Backend: Cloudflare Worker + D1 + R2. A credits/plans ledger, an atomic "consume estimate" (unlimited → pro
  cap → credits → 402 paywall), refunds on failed runs, and a RevenueCat webhook that is idempotent on event id.
- Appraiser: FastAPI on Nebius; Gemma 3 27B reads photos, Nemotron reasons over an evidence sheet, Tavily
  pulls comps. Also runs fully offline on a laptop GPU for the counter kiosk (Nemotron Mini + Gemma 3 4B).

## Challenges
- Small vision models on real webcam frames: qwen2.5vl aborted ("token repeat limit"), qwen3-vl thought for
  80 s per photo. Gemma 3 4B answers in 4–10 s; dealer text guards keep the item name honest.
- `getOfferings()` returns the offerings object directly — one destructure made the whole paywall say
  "store not reachable." Caught on the emulator with the RevenueCat Test Store.
- Twelve days from "should we?" to a published internal build, including Play Console, JDK 21, signing.

## Accomplishments
End-to-end purchase loop verified on device: paywall → RevenueCat Test Store → webhook → credits in D1 →
pill updates without a reload. Pro subscription path too.

## What we learned
Meter the thing that costs you money, keep everything else free, and let the store handle the receipts.

## What's next
Real Play products + `goog_` key, eBay/Etsy one-tap crosslisting from the appraisal, the offline counter
kiosk as a shop tier, iOS once the Apple account clears.
