# Jev Cloudflare proxy

Authenticated TypeSafe-compatible `POST /v1/systemone` backed by Cloudflare `typesafe/jev`.

## Deploy

```sh
npm install
wrangler secret put PROXY_API_KEY
wrangler secret put CF_AI_API_TOKEN   # Account → Workers AI → Read (used inside APAC DO only)
npm run deploy
```

## Why custom domain failed

| Path | Result |
| --- | --- |
| Edge `env.AI.run` on LHR ingress | `AiGatewayError` `2002` |
| Worker-originated account REST from LHR | same `2002` (`Model execution failed`) |
| Same token REST from Mac / outside CF | **200** `jev-1.13.0` |
| Durable Object id `"jev"` first created under LHR | hint ignored on later `get()`; DO stayed on broken path |

## Current recovery

1. On ingress `colo=LHR`: **skip edge REST/binding** → Durable Object `idFromName("jev-apac-v2")` with `locationHint: "apac-se"` (new id so the hint applies).
2. Inside the DO: **`env.AI.run` first**, REST only if binding fails.
3. Healthy ingress: edge binding, then the same APAC-SE DO on failure.

Look for logs: `Jev edge → Durable Object`, `Jev DO path start`, `Jev DO path ok` (`via: binding|rest`).

If a **fresh** APAC-SE DO still cannot run binding or Worker REST, the next escape hatch is an **off-platform relay** (Mac/box/CI calling account `/ai/run` and returning the result), because AI Gateway `2002` appears intrinsic to Cloudflare Worker isolates on this account/path.

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
