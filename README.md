# Jev Cloudflare proxy

An authenticated TypeSafe-compatible `POST /v1/systemone` endpoint backed by Cloudflare's `typesafe/jev` model.

## Deploy

```sh
npm install
wrangler secret put PROXY_API_KEY
npm run deploy
```

Clients send `Authorization: Bearer <PROXY_API_KEY>`. Keep `.dev.vars` and `.secrets/` private.

No `CF_AI_API_TOKEN` is required. Do not rely on Worker→workers.dev `fetch` (that path returned HTTP 522 in production).

## API

`GET /health` returns `{ "status": "ok" }`.

`POST /v1/systemone` accepts TypeSafe SystemOne JSON (`model`: `jev-latest` or `typesafe/jev`).

```json
{
  "model": "jev-latest",
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?"
    }
  }
}
```

## LHR / custom-domain recovery

Observed in production:

| Path | Result |
| --- | --- |
| Custom domain, ingress `colo=LHR`, `env.AI.run` | `AiGatewayError` `2002` |
| Same with `cf-placement: remote-SIN` | still `2002` |
| Worker `fetch(workers.dev)` hop | HTTP **522** timeout |
| External curl to workers.dev (`local-SIN`) | HTTP 200 `jev-1.13.0` |

Mitigation in this Worker:

1. Call `env.AI.run("typesafe/jev", input)` with **no** explicit `gateway` option (matches Cloudflare catalog examples).
2. On ingress colo `LHR` (or binding `2002`), re-enter once via **Service Binding** `env.SELF.fetch(...)` with `x-jev-edge-hop: 1` so inference runs in a fresh internal invocation without the public hop.
3. Optional: if `CF_AI_API_TOKEN` is ever set, prefer account REST before the service hop.

Insufficient AI Gateway credits still map to HTTP `402` / `insufficient_credits`.

## Verify

```sh
curl -sS https://jev-proxy.topviewai.app/health

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

Expect HTTP `200` with `model`, `answers`, and `usage`.
