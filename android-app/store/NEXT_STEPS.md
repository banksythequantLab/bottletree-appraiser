# Bottle Tree — what's left, in order

Status as of Sep 19, 2026.

## 1. Fix the RevenueCat credentials (2 minutes, only Derek can do it)

RevenueCat has the key file saved. Two of its three checks pass; the failing one is
"Can validate Google Play subscription purchases". The service account was invited to Play
but without two required permissions.

Open (note **/u/1/** — /u/0/ is a different Google account stuck on a terms page):

    https://play.google.com/console/u/1/developers/6615735360865289088/users-and-permissions

1. Click **Manage** on `revenuecat@bottletree-app-2026.iam.gserviceaccount.com`
2. Under **Account permissions**, tick:
   - View financial data, orders, and cancellation survey responses
   - Manage orders and subscriptions
   (leave "View app information" and "Manage store presence" ticked if already on)
3. Apply / Save
4. Back in RevenueCat -> app settings -> **Check credentials**. All three turn green,
   possibly after a few minutes.

    https://app.revenuecat.com/projects/d8d4752b/apps/app995e6da677

## 2. Swap the SDK key (Claude can do this once step 1 is green)

- `RC_ANDROID_KEY` in `worker/wrangler.jsonc`: `test_JocUlLPMbvRTkSmTlqEGEAThDMr`
  -> `goog_bruXXcAjAfxUxeHpcoCYElturCQ`
- `npx wrangler deploy` — worker only, no new AAB, no new Play review

## 3. Sandbox purchase test

- Add the tester Google account as a license tester in Play Console
- Install from the internal testing link, buy the 10-pack, confirm credits land in D1

## 4. Devpost (the real deadline — Sep 30, 11:45 pm PDT)

- Upload `bottletree_shipaton_2min.mp4` to YouTube
- Paste that link + the production store URL into `DEVPOST_SHIPATON.md` and submit

## Reference

- Play app id 4976073647558684413 · package `ai.banksy.bottletree`
- Internal test link: https://play.google.com/apps/internaltest/4700209593663356261
- Service account key (gitignored, never commit): `android-app/keys/revenuecat-play-sa.json`
- Google Cloud project: `bottletree-app-2026`
- Play reviewer account: `playreview@bottletree.test` (25 credits preloaded)
