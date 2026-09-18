# Deploying the appraiser on Nebius AI Cloud (Serverless Endpoints)

The service is a stateless FastAPI container. It runs on a **CPU-only** Serverless Endpoint because all
model inference happens on Nebius Token Factory (Nemotron 3 Super + Gemma 3 27B); the container only
orchestrates calls, so a 4 vCPU preset is plenty.

## 1. Image

Every push to `main` that touches `service/` builds and publishes
`ghcr.io/banksythequantlab/bottletree-appraiser:latest` (see `.github/workflows/appraiser-image.yml`).
The package must be **public** for Nebius to pull it without registry credentials: GitHub → the package
→ Package settings → Change visibility → Public (one-time). Private is fine too — add
`--registry-username <github user> --registry-password <PAT with read:packages>` to the create command.

## 2. Endpoint

Prereqs: [Nebius CLI](https://docs.nebius.com/cli/) installed and `nebius init` done (project + subnet in
`~/.nebius/config.yaml`), and the project has ≥1 VM quota and ≥1 VPC allocation.

```bash
export APPRAISER_TOKEN=$(openssl rand -hex 32)        # bearer the Bottle Tree worker will send
export SUBNET_ID=$(nebius vpc subnet list --format json | jq -r '.items[0].metadata.id')

nebius ai endpoint create \
  --name bottletree-appraiser \
  --image ghcr.io/banksythequantlab/bottletree-appraiser:latest \
  --platform cpu-d3 --preset 4vcpu-16gb \
  --public --container-port 8080 \
  --auth token --token "$APPRAISER_TOKEN" \
  --env "APPRAISER_MODE=cloud,MAX_PHOTOS=8,PORT=8080" \
  --env "NEBIUS_API_KEY=$NEBIUS_API_KEY,TAVILY_API_KEY=$TAVILY_API_KEY" \
  --subnet-id "$SUBNET_ID"
```

(`--env-secret KEY=<SecretStash selector>` is the tidier way to pass the two API keys once they are in
SecretStash; the plain `--env` form works for the hackathon.)

Wait for `RUNNING`, then:

```bash
ENDPOINT_URL=$(nebius ai endpoint get --name bottletree-appraiser --format json | jq -r '.status.url')
curl -s "$ENDPOINT_URL/health" -H "Authorization: Bearer $APPRAISER_TOKEN"
nebius ai endpoint logs --name bottletree-appraiser
```

## 3. Point Bottle Tree at it

```bash
cd worker
# wrangler.jsonc → vars.APPRAISER_URL = ENDPOINT_URL (https, no trailing slash)
npx wrangler secret put APPRAISER_TOKEN        # paste $APPRAISER_TOKEN
npx wrangler deploy
```

The worker sends `Authorization: Bearer <APPRAISER_TOKEN>` on every `/appraise` call (worker.js →
`runAppraisal`). Photo URLs it passes are public R2 links (`PUBLIC_ORIGIN/p/...`), which the endpoint
fetches itself, so no upload from the worker is needed.

## Smoke test end to end

Phone PWA → add item → shoot → **Appraise**. `GET /api/items/:id` should flip `appraisal.status` from
`pending` to `done` in ~20–90 s with `models.text = nvidia/nemotron-3-super-120b-a12b`.

## Tear down

```bash
nebius ai endpoint delete --name bottletree-appraiser
```
