import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { runJev } from "../src/index.js";

const payload = { model: "jev-latest", state: "urgent", questions: { urgent: { type: "noul", instructions: "Urgent?" } } };
const result = { model: "jev-1.13.0", answers: { urgent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 5 } };
const input = { state: payload.state, questions: payload.questions };
const req = (body = payload, key = "test", { cf, headers } = {}) => {
  const request = new Request("https://example.com/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
};
test("preserves TypeSafe result and invokes only Cloudflare Jev", async () => {
  const response = await worker.fetch(req(), { PROXY_API_KEY: "test", AI: { run: async (model, body, options) => {
    assert.equal(model, "typesafe/jev");
    assert.deepEqual(body, input);
    assert.deepEqual(options, { gateway: { id: "default" } });
    return result;
  } } });
  assert.deepEqual(await response.json(), result);
});
test("rejects unauthenticated, unsupported models and malformed requests", async () => {
  const env = { PROXY_API_KEY: "test", AI: { run: () => { throw Error("must not run"); } } };
  assert.equal((await worker.fetch(req(payload, "wrong"), env)).status, 401);
  assert.equal((await worker.fetch(req({ ...payload, model: "another-model" }), env)).status, 422);
  assert.equal((await worker.fetch(req(null), env)).status, 422);
  assert.equal((await worker.fetch(req(), {})).status, 503);
});
test("unwraps gateway result and sanitizes upstream failure", async () => {
  assert.deepEqual(await (await worker.fetch(req(), { PROXY_API_KEY: "test", AI: { run: async () => ({ result }) } })).json(), result);
  const response = await worker.fetch(req(), { PROXY_API_KEY: "test", AI: { run: () => { throw Error("secret"); } } });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("secret"));
});
test("returns an actionable status for insufficient Cloudflare AI Gateway credits", async () => {
  const response = await worker.fetch(req(), {
    PROXY_API_KEY: "test",
    AI: { run: () => { throw Error("2021: Insufficient AI Gateway credits"); } },
  });
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), {
    error: { message: "Cloudflare AI Gateway has insufficient credits", code: "insufficient_credits" },
  });
});
test("falls back to the account AI REST API after AiGatewayError 2002", async () => {
  const originalFetch = globalThis.fetch;
  let restCalls = 0;
  globalThis.fetch = async (url, init) => {
    restCalls += 1;
    assert.match(String(url), /\/accounts\/5b6c981ebeb77b3e3566ffc9ba8be751\/ai\/run$/);
    assert.equal(init.headers.authorization, "Bearer rest-token");
    assert.deepEqual(JSON.parse(init.body), { model: "typesafe/jev", input });
    return new Response(JSON.stringify({ success: true, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const output = await runJev({
      CF_AI_API_TOKEN: "rest-token",
      AI: { run: () => { throw Object.assign(new Error("2002: Error"), { name: "AiGatewayError" }); } },
    }, input);
    assert.deepEqual(output, result);
    assert.equal(restCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("skips binding on LHR ingress and hops via workers.dev without CF_AI_API_TOKEN", async () => {
  const originalFetch = globalThis.fetch;
  let hopCalls = 0;
  globalThis.fetch = async (url, init) => {
    hopCalls += 1;
    assert.equal(String(url), "https://jev-cloudflare-proxy.imabing.workers.dev/v1/systemone");
    assert.equal(init.headers.authorization, "Bearer test");
    assert.equal(init.headers["x-jev-edge-hop"], "1");
    assert.deepEqual(JSON.parse(init.body), { model: "typesafe/jev", ...input });
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = {
      PROXY_API_KEY: "test",
      WORKERS_DEV_ORIGIN: "https://jev-cloudflare-proxy.imabing.workers.dev",
      AI: { run: () => { throw new Error("binding must not run for LHR"); } },
    };
    const output = await runJev(env, input, { colo: "LHR", allowHop: true });
    assert.deepEqual(output, result);
    assert.equal(hopCalls, 1);

    const response = await worker.fetch(req(payload, "test", { cf: { colo: "LHR" } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.equal(hopCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("hop requests do not recurse when x-jev-edge-hop is set", async () => {
  const env = {
    PROXY_API_KEY: "test",
    WORKERS_DEV_ORIGIN: "https://jev-cloudflare-proxy.imabing.workers.dev",
    AI: { run: () => { throw Object.assign(new Error("2002: Error"), { name: "AiGatewayError" }); } },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  try {
    const response = await worker.fetch(
      req(payload, "test", { cf: { colo: "LHR" }, headers: { "x-jev-edge-hop": "1" } }),
      env,
    );
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("prefers REST over workers.dev hop when CF_AI_API_TOKEN is set", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    assert.match(String(url), /\/ai\/run$/);
    return new Response(JSON.stringify({ success: true, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const output = await runJev({
      CF_AI_API_TOKEN: "rest-token",
      PROXY_API_KEY: "test",
      WORKERS_DEV_ORIGIN: "https://jev-cloudflare-proxy.imabing.workers.dev",
      AI: { run: () => { throw new Error("2002: Error"); } },
    }, input, { colo: "LHR" });
    assert.deepEqual(output, result);
    assert.deepEqual(urls.length, 1);
    assert.match(urls[0], /\/ai\/run$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
