# Jev Cloudflare proxy

Authenticated TypeSafe-compatible `POST /v1/systemone` backed by Cloudflare `typesafe/jev`.

## Deploy Worker

```sh
npm install
wrangler secret put PROXY_API_KEY
wrangler secret put RELAY_URL    # https://<public-host>/v1/systemone
wrangler secret put RELAY_KEY    # shared with the relay process
npm run deploy
```

`CF_AI_API_TOKEN` is **not** required on the Worker when LHR traffic uses the relay. Put that token on the **relay host** instead (see [`relay/README.md`](relay/README.md)).

## Why an off-platform relay

Same Mac, same payload, same `PROXY_API_KEY`:

| Target | Result |
| --- | --- |
| `jev-proxy.topviewai.app` (cf-ray `*-LHR`) | **502** `AiGatewayError` `2002` |
| `*.imabing.workers.dev` (cf-ray `*-SIN`) | **200** `jev-1.13.0` |
| Account REST `/ai/run` from outside CF | **200** |
| Worker / DO / Worker-origin REST on LHR path | **2002** |

On-platform AI only works when the **ingress** colo is healthy (SIN). Durable Objects and Service Bindings did not escape LHR AI Gateway failure. Public Worker→workers.dev hop previously **522**’d.

## Inference order

1. Ingress `colo=LHR` → **off-platform relay** (`RELAY_URL` + `RELAY_KEY`)
2. Other colos → `env.AI.run`; on `2002` / “Model execution failed” → relay if configured

## Stand up the relay (Jeff/box)

```sh
export RELAY_KEY='...'
export CF_AI_API_TOKEN='...'   # Account → Workers AI → Read
node relay/server.mjs
cloudflared tunnel --url http://127.0.0.1:8788
# then wrangler secret put RELAY_URL / RELAY_KEY and deploy
```

## Verify custom domain

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

Expect HTTP `200` with `model`, `answers`, and `usage`. Workers Logs should show `Jev edge → off-platform relay`.
