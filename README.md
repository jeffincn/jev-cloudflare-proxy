# Jev Cloudflare proxy

Authenticated TypeSafe-compatible `POST /v1/systemone` backed by Cloudflare `typesafe/jev`.

## Deploy

```sh
npm install
wrangler secret put PROXY_API_KEY
wrangler secret put CF_AI_API_TOKEN   # Account → Workers AI → Read (required for custom-domain recovery)
npm run deploy
```

## Inference recovery (custom domain / LHR)

Production showed:

1. `env.AI.run` fails on LHR ingress (`AiGatewayError` / HTTP 500) even with `remote-SIN` placement
2. Worker → `workers.dev` hop times out (**522**)
3. Service Binding self-hop retries the broken binding when `colo` is null
4. Account REST `POST /accounts/.../ai/run` with `CF_AI_API_TOKEN` returns **200** `jev-1.13.0` from outside Cloudflare

Current order:

1. **REST first** when `CF_AI_API_TOKEN` is set (never blocked on binding / hop)
2. If Worker-originated REST fails → **Durable Object** `JevInference` with `locationHint: "apac"` (binding, then REST)
3. Binding alone only on healthy ingress when no token is configured

`unwrap` accepts direct results and REST nests such as `{ state: "Completed", result: { model, answers, usage } }`.

## Verify on the custom domain

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
