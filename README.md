# Bottle Tree — Antique Price AI Guess-estimator

Photograph an antique on your phone, tell the app what you know, and get an identification, a
price range with evidence, and a ready-to-approve listing — then sell it in the store or online.

Built by [Banksy AI LLC](https://github.com/banksythequantLab) for the
**Nebius × NVIDIA Global AI Hackathon** (Track: Best Apps & Agents).

## How it works

```
 phone PWA ──photos + description + markings──▶ Bottle Tree worker (Cloudflare) ──▶ R2 photos, D1 items
                                                        │
                                                        ▼  POST /appraise
                                        appraiser service (FastAPI on Nebius AI Cloud)
                                                        │
                    ┌───────────────────────────────────┼─────────────────────────────┐
                    ▼                                   ▼                             ▼
      vision model per photo               NVIDIA Nemotron 3 Super            comps search (Tavily)
      (Nebius Token Factory)               identify · price · draft            re-price with comps
                    └───────────────── evidence sheet ──┘
                                                        │
                                                        ▼
                   dealer sees appraisal card ──▶ "Approve & list" ──▶ public storefront + Stripe Checkout
```

1. **Guided capture.** The PWA asks for front / back / underside / marks / detail / damage shots (any
   subset, plus extras), a brief description, and any writing or stamps the dealer can read. Dealer-
   transcribed markings are weighted above OCR — a human reading a worn stamp beats a camera.
2. **Per-photo vision.** Every photo goes to a vision model on Nebius Token Factory with a literal
   "report only what you see" prompt: object type, materials, construction, condition, transcribed text.
3. **Evidence sheet → Nemotron.** Findings are merged with the dealer's text into one evidence sheet.
   `nvidia/nemotron-3-super-120b-a12b` returns identification, confidence, cited evidence, a price
   range (low / high / suggested / floor), a listing draft and questions that would sharpen the appraisal.
4. **Comparables.** If `TAVILY_API_KEY` is set, sold/asking comps from eBay, LiveAuctioneers, 1stDibs etc.
   are fetched and Nemotron re-prices against them. Without it the range is flagged as model-estimated.
5. **Approve & list.** The dealer edits title/price/description and publishes. The item appears at
   `/shop/<slug>` with Stripe Checkout; an online sale marks it sold in the POS so it can't be double-sold.

## Repo layout

```
service/   FastAPI appraisal service (Python 3.11) — deploy on Nebius AI Cloud
worker/    Bottle Tree app: Cloudflare Worker + D1 + R2, PWA in worker/public, storefront rendering
```

## Run the appraiser locally

```
cd service
python -m venv .venv && .venv\Scripts\activate      # or source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env                              # add NEBIUS_API_KEY
python scripts/probe_models.py                      # shows which models/vision candidates your key can use
uvicorn app.main:app --port 8080
pytest -q                                           # 5 tests, no network needed
```

`POST /appraise` (JSON: photos as URLs or data URLs + description + markings) or
`POST /appraise/upload` (multipart) → an `Appraisal` JSON. `GET /health` shows the resolved models.

Docker: `docker build -t bottletree-appraiser service && docker run -p 8080:8080 --env-file service/.env bottletree-appraiser`

## Deploy the app

```
cd worker
npx wrangler d1 execute bottletree --remote --file=migrations/0001_init.sql   # first time only
npx wrangler d1 execute bottletree --remote --file=migrations/0002_auth.sql
npx wrangler d1 execute bottletree --remote --file=migrations/0003_appraiser.sql
npx wrangler r2 bucket create bottletree-photos
npx wrangler secret put APPRAISER_SERVICE_KEY   # same value as the service's APPRAISER_SERVICE_KEY
npx wrangler secret put STRIPE_SECRET_KEY       # optional — enables "Buy now"
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # webhook: POST /api/public/stripe-webhook
npx wrangler deploy
```

Set `APPRAISER_URL` and `PUBLIC_ORIGIN` in `worker/wrangler.jsonc`.

## API (worker)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/sales/:id/items` | create item (`name`, `price?`, `description?`, `markings?`) |
| POST | `/api/items/:id/photos` | multipart `photos[]` + `kinds` (csv) → stored in R2 |
| POST | `/api/items/:id/appraise` | queue appraisal (202); worker calls the service in the background |
| GET | `/api/items/:id` | item + photos + latest appraisal |
| POST | `/api/items/:id/publish` | `title`, `description`, `price`, `listing_status` (live / hidden) |
| PUT | `/api/me/shop` | set shop slug / name / tagline |
| GET | `/shop/:slug`, `/shop/:slug/item/:id` | public storefront (server-rendered) |
| POST | `/api/public/checkout` | Stripe Checkout session for a live item |

## Sponsor tools used

- **NVIDIA Nemotron 3 Super (120B-A12B)** on **Nebius Token Factory** — all reasoning, pricing and copy.
- **Vision model on Nebius Token Factory** — per-photo analysis and OCR (NVIDIA Nemotron Nano Omni /
  Nano VL when served; auto-falls back to the first available VL model on the account).
- **Nebius AI Cloud** — hosts the appraisal service.

## License

MIT © 2026 Banksy AI LLC
