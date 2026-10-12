# Off-platform Jev relay

Worker isolates on LHR (and Durable Objects reached from LHR) get `AiGatewayError 2002` for `typesafe/jev`. The same account REST call from outside Cloudflare returns HTTP 200. This process is that outside caller.

## Run locally / on the box

```sh
export RELAY_KEY='long-random-shared-secret'
export CF_AI_API_TOKEN='account-token-with-workers-ai-read'
# optional: export CLOUDFLARE_ACCOUNT_ID=5b6c981ebeb77b3e3566ffc9ba8be751
# optional: export PORT=8788

node relay/server.mjs
```

Expose HTTPS (example with cloudflared quick tunnel):

```sh
cloudflared tunnel --url http://127.0.0.1:8788
# note the https://....trycloudflare.com URL
```

## Wire the Worker

Relay URL must include the path `/v1/systemone`:

```sh
wrangler secret put RELAY_URL
# paste: https://<tunnel-host>/v1/systemone

wrangler secret put RELAY_KEY
# paste the same RELAY_KEY the relay process uses

npm run deploy
```

`CF_AI_API_TOKEN` is required on the **relay host**, not on the Worker, when LHR traffic only uses the relay.

## Check

```sh
curl -sS https://<tunnel-host>/health
curl -sS -D - https://<tunnel-host>/v1/systemone \
  -H "authorization: Bearer $RELAY_KEY" \
  -H "content-type: application/json" \
  -d '{"state":"Help!","questions":{"is_urgent":{"type":"noul","instructions":"Urgent?"}}}'
```
