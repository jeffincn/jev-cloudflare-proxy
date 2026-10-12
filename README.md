# Jev Cloudflare proxy

An authenticated TypeSafe-compatible `POST /v1/systemone` endpoint backed by Cloudflare's `typesafe/jev` model.

## Deploy

The Worker is configured for the `TopView.ai` account and the custom hostname `jev-proxy.topviewai.app`.

```sh
npm install
wrangler secret put PROXY_API_KEY
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

Cloudflare AI Gateway must have sufficient credits for model inference. If the balance is insufficient, the endpoint returns HTTP `402` with `error.code` set to `insufficient_credits`.
