#!/usr/bin/env node
/**
 * Off-platform Jev relay for jev-cloudflare-proxy.
 *
 * Runs outside the Cloudflare Worker isolate (Mac/box). Calls account AI REST
 * with CF_AI_API_TOKEN — the path that returns 200 while Worker/DO AI returns 2002.
 *
 * Env:
 *   RELAY_KEY            shared secret; Worker sends Authorization: Bearer <RELAY_KEY>
 *   CF_AI_API_TOKEN      Account → Workers AI → Read
 *   CLOUDFLARE_ACCOUNT_ID optional (defaults to TopView account)
 *   PORT                 optional (default 8788)
 *
 * Example:
 *   RELAY_KEY=... CF_AI_API_TOKEN=... node relay/server.mjs
 *   cloudflared tunnel --url http://127.0.0.1:8788
 *   wrangler secret put RELAY_URL   # https://....trycloudflare.com/v1/systemone
 *   wrangler secret put RELAY_KEY
 */
import http from "node:http";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "5b6c981ebeb77b3e3566ffc9ba8be751";
const PORT = Number(process.env.PORT || 8788);
const RELAY_KEY = process.env.RELAY_KEY || "";
const CF_AI_API_TOKEN = process.env.CF_AI_API_TOKEN || "";

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};

const unwrap = (output) => {
  let cur = output;
  for (let i = 0; i < 4 && cur && typeof cur === "object" && !cur.answers; i++) {
    cur = cur.result ?? null;
  }
  return cur?.answers && cur?.usage && typeof cur.model === "string" ? cur : null;
};

const readBody = (req, limit = 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let length = 0;
  req.on("data", (chunk) => {
    length += chunk.length;
    if (length > limit) {
      reject(Object.assign(new Error("Request exceeds 1 MiB"), { status: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    return json(res, 200, { status: "ok", service: "jev-relay" });
  }
  if (url.pathname !== "/v1/systemone" || req.method !== "POST") {
    return json(res, 404, { error: { message: "Not found" } });
  }
  if (!RELAY_KEY || !CF_AI_API_TOKEN) {
    return json(res, 503, { error: { message: "Relay credentials are not configured" } });
  }
  const auth = req.headers.authorization || "";
  const token = auth.match(/^Bearer (.+)$/i)?.[1];
  if (!token || token !== RELAY_KEY) {
    return json(res, 401, { error: { message: "Invalid relay key" } });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (cause) {
    return json(res, cause.status || 422, { error: { message: cause.status === 413 ? "Request exceeds 1 MiB" : "Invalid JSON" } });
  }
  if (!body || typeof body !== "object" || body.state == null || !body.questions || typeof body.questions !== "object") {
    return json(res, 422, { error: { message: "state and questions are required" } });
  }

  try {
    const upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CF_AI_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "typesafe/jev",
        input: { state: body.state, questions: body.questions },
      }),
    });
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const message = payload?.errors?.[0]?.message ?? `AI REST HTTP ${upstream.status}`;
      console.error("relay upstream failed", { status: upstream.status, message });
      return json(res, 502, { error: { message } });
    }
    const result = unwrap(payload?.result ?? payload);
    if (!result) return json(res, 502, { error: { message: "Unexpected model response" } });
    return json(res, 200, result);
  } catch (cause) {
    console.error("relay exception", cause);
    return json(res, 502, { error: { message: "Relay upstream error" } });
  }
});

if (!RELAY_KEY || !CF_AI_API_TOKEN) {
  console.warn("Warning: set RELAY_KEY and CF_AI_API_TOKEN before serving production traffic");
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`jev-relay listening on http://127.0.0.1:${PORT}/v1/systemone`);
});
