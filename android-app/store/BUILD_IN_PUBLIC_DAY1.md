# #BuildInPublic — Day 1 post (X / LinkedIn), for Derek to post as himself

Shipping an Android app in 12 days for the @RevenueCat #Shipaton.

Bottle Tree: photograph an antique, NVIDIA Nemotron tells you what it is and what it's worth, one tap lists it.
Inventory's free. Estimates are $0.99 each, 10 for $4.99, or $9.99/mo.

Day 1 scoreboard:
- credits + plans ledger on Cloudflare D1, RevenueCat webhook, paywall gate ✅
- Capacitor shell + RevenueCat SDK, signed AAB ✅
- first purchase through the RevenueCat Test Store on an emulator: paywall → buy 10-pack → webhook → "11 estimates left" ✅
- Play Console: app created, internal build 1.0.1 live ✅

Bug of the day: the paywall said "store not reachable" for 20 minutes because I destructured {offerings} from a call that returns the offerings object directly. Read the types.

Repo is public: github.com/banksythequantLab/bottletree-appraiser

(attach: shots/paywall.png + shots/pro_active.png side by side, or the 79-s video)
