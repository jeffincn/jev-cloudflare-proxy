# Jev Cloudflare proxy

An authenticated TypeSafe-compatible `POST /v1/systemone` endpoint backed by Cloudflare's `typesafe/jev` model.

## Deploy

The Worker is configured for the `TopView.ai` account and the custom hostname `jev-proxy.topviewai.app`.

```sh
npm install
wrangler secret put PROXY_API_KEY
# Optional (preferred long-term): Account → Workers AI → Read.
# Without it, LHR custom-domain traffic recovers via a workers.dev hop instead.
wrangler secret put CF_AI_API_TOKEN
npm run deploy
```

Set a strong, private value for `PROXY_API_KEY` when prompted. Clients send it as `Authorization: Bearer <key>`.
Keep `.dev.vars` and `.secrets/` private; both are git-ignored.

## API

`GET /health` returns a basic health status.

`POST /v1/systemone` accepts a TypeSafe SystemOne request. `model` may be `jev-latest` or `typesafe/jev`; both invoke the Cloudflare-hosted `typesafe/jev` model.

```json
{
  "model": "jev-latest",
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?"
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

The response is the model's native JSON result with `model`, `answers`, and `usage`. Requests are capped at 1 MiB. The proxy does not cache requests or log bodies.

## LHR / custom-domain recovery

Production showed:

- Ingress `colo=LHR` + `env.AI.run` → `AiGatewayError` `2002` / HTTP 500 (`aiGatewayLogId` null)
- `cf-placement: remote-SIN` does **not** fix that binding failure
- Same client via `workers.dev` with `local-SIN` → HTTP 200 `jev-1.13.0`

Recovery order:

1. Skip the AI binding on known-bad ingress colos (`LHR`)
2. If `CF_AI_API_TOKEN` is set → account REST `POST /ai/run` (preferred)
3. Else hop once to `WORKERS_DEV_ORIGIN` (`https://jev-cloudflare-proxy.imabing.workers.dev`) with `PROXY_API_KEY` and `x-jev-edge-hop: 1` so binding sees a healthy ingress

Jev is a third-party model on AI Gateway Unified Billing. Insufficient credits return HTTP `402` with `error.code=insufficient_credits`. Other upstream failures return `502` and log error code, status, and edge colo.

## Verify on the custom domain

Health (no secret):

```sh
curl -sS https://jev-proxy.topviewai.app/health
```

Inference (set `PROXY_API_KEY` in your shell; do not commit it):

```sh
curl -sS -D - https://jev-proxy.topviewai.app/v1/systemone \
  -H "authorization: Bearer $PROXY_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "jev-latest",
    "state": "Help! My payouts have been failing for 3 days.",
    "questions": {
      "is_urgent": {
        "type": "noul",
        "instructions": "Does this convey urgency?"
      }
    }
  }'
```

Expect HTTP `200` with `model`, `answers`, and `usage`. Keep `workers_dev` enabled while the hop fallback is in use.

## Credentials

| Item | Action |
| --- | --- |
| Required | `PROXY_API_KEY` (already set) |
| Preferred | `CF_AI_API_TOKEN` — Account → Workers AI → Read (avoids workers.dev hop) |
| Optional debug | Account → AI Gateway → Read for gateway logs; dashboard Unified Billing for credits |
