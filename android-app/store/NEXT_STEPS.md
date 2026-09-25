# Bottle Tree — what's left, in order

Status as of Sep 25, 2026.

## 1. RevenueCat credentials — DONE, propagation resolved, verified Sep 25

Verified Sep 25 against Google's own API with the RevenueCat service account token:

    purchases/products/estimate_10/tokens/DUMMY   400 Invalid Value   (authorized)
    purchases/subscriptionsv2/tokens/DUMMY        400 Invalid Value   (authorized)
    purchases/voidedpurchases                     200 {}
    monetization oneTimeProducts.list             200  estimate_1 ACTIVE, estimate_10 ACTIVE
    monetization subscriptions.list               200  pro_monthly/monthly ACTIVE,
                                                       unlimited_monthly/monthly ACTIVE

400 on a dummy token is the documented "ready" signal (401 was the propagation symptom),
so purchase validation works. All four SKUs exist and are ACTIVE and match `PRODUCTS`
in `worker/billing.js` exactly.

Note: `inappproducts.list` returns **403 "Please migrate to the new publishing API"**.
That is Google deprecating the v3 legacy catalog endpoint, not a permission problem —
the replacement (`monetization.onetimeproducts.list`, path `oneTimeProducts`) returns 200.
If RevenueCat's dashboard check "Can read the Google Play in-app product catalog" shows
red, that is why; it does not affect purchase validation or credit grants.

Original diagnosis kept for history — the permissions fix that unblocked this.
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

## 2. Swap the SDK key — DONE Sep 20 (commit 48b0b3e, worker redeployed, verified live)

- `RC_ANDROID_KEY` in `worker/wrangler.jsonc`: `test_JocUlLPMbvRTkSmTlqEGEAThDMr`
  -> `goog_bruXXcAjAfxUxeHpcoCYElturCQ`
- `npx wrangler deploy` — worker only, no new AAB, no new Play review

## 3. Sandbox purchase test — REMAINING (needs a signed-in device)

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

> Status Sep 25, 2026: RESOLVED. Account-level permissions were granted Sep 19
> (accountPerms carries the full _GLOBAL set) and the 401 was Google's propagation lag,
> as suspected — the purchases API now answers 400 on a dummy token. Re-verify any time
> with (note: on Windows, node must spawn gcloud.cmd with shell:true, and `$` is eaten by
> some MCP shells — put the probe in a .mjs file rather than a one-liner):
>
>     gcloud auth print-access-token --account=revenuecat@bottletree-app-2026.iam.gserviceaccount.com --scopes=https://www.googleapis.com/auth/androidpublisher
>
> then GET androidpublisher/v3/applications/ai.banksy.bottletree/purchases/subscriptionsv2/tokens/DUMMY
> 401 = still propagating. 400/404 = ready; proceed to step 2.

