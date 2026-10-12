# Jev Cloudflare proxy

An authenticated TypeSafe-compatible `POST /v1/systemone` endpoint backed by Cloudflare's `typesafe/jev` model.

## Deploy

The Worker is configured for the `TopView.ai` account and the custom hostname `jev-proxy.topviewai.app`.

```sh
npm install
wrangler secret put PROXY_API_KEY
# Optional but recommended: account token with Account → Workers AI → Read.
# Used only when the edge AI binding returns AiGatewayError 2002 (seen in LHR).
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

The response is the model's native JSON result with `model`, `answers`, and `usage`. Requests are capped at 1 MiB. The proxy does not cache requests or log bodies. Inference runs through the Cloudflare Workers AI binding, with an optional account REST fallback when the edge binding returns AI Gateway error `2002`.

Jev is a third-party model served through Cloudflare AI Gateway. The Worker explicitly uses the `default` gateway; third-party inference uses Unified Billing and deducts prepaid AI Gateway credits. The gateway's Workers AI billing setting applies to Workers AI models, not to Jev. If the balance is insufficient, the endpoint returns HTTP `402` with `error.code` set to `insufficient_credits`. Other upstream failures are returned as `502` and logged with their error code, status, and edge colo.

## Placement

`wrangler.jsonc` pins Worker execution near `aws:ap-southeast-1`. Production Workers Logs showed successful `typesafe/jev` calls from SIN/NRT and repeated `AiGatewayError: 2002` / HTTP 500 failures from LHR (the colo that served most `jev-proxy.topviewai.app` inference traffic). Placement keeps inference off the failing EU edge path.

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

Expect HTTP `200` with `model`, `answers`, and `usage`. HTTP `402` means AI Gateway credits are exhausted. HTTP `502` with Workers Log fields `upstreamCode=2002` and `colo=LHR` means the edge AI Gateway path still failed — set `CF_AI_API_TOKEN` (Workers AI Read) and redeploy, and/or check AI Gateway credits in the dashboard.

## Credentials Jeff may need to grant

| Gap | Needed permission / action |
| --- | --- |
| Deploy / secrets | Wrangler login or API token with Workers Scripts Edit + Workers Routes Edit + Workers AI Read |
| Optional REST fallback secret | `wrangler secret put CF_AI_API_TOKEN` — Account → Workers AI → Read |
| AI Gateway dashboard / log API | Account → AI Gateway → Read (current tokens that only cover Workers often get auth errors on `/ai-gateway/*`) |
| Billing confirmation | Dashboard → AI Gateway → Unified Billing credits for the `default` gateway |
