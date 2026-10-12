import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { runJev, runRelay, unwrap } from "../src/index.js";

const payload = { model: "jev-latest", state: "urgent", questions: { urgent: { type: "noul", instructions: "Urgent?" } } };
const result = { model: "jev-1.13.0", answers: { urgent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 5 } };
const input = { state: payload.state, questions: payload.questions };
const req = (body = payload, key = "test", { cf } = {}) => {
  const request = new Request("https://example.com/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
};

test("preserves TypeSafe result via binding on healthy ingress", async () => {
  const response = await worker.fetch(req(), {
    PROXY_API_KEY: "test",
    AI: {
      run: async (model, body, options) => {
        assert.equal(model, "typesafe/jev");
        assert.deepEqual(body, input);
        assert.equal(options, undefined);
        return result;
      },
    },
  });
  assert.deepEqual(await response.json(), result);
});

test("rejects unauthenticated, unsupported models and malformed requests", async () => {
  const env = { PROXY_API_KEY: "test", AI: { run: () => { throw Error("must not run"); } } };
  assert.equal((await worker.fetch(req(payload, "wrong"), env)).status, 401);
  assert.equal((await worker.fetch(req({ ...payload, model: "another-model" }), env)).status, 422);
  assert.equal((await worker.fetch(req(null), env)).status, 422);
  assert.equal((await worker.fetch(req(), {})).status, 503);
});

test("unwraps nested gateway and Completed REST envelopes", () => {
  assert.deepEqual(unwrap({ result }), result);
  assert.deepEqual(unwrap({ state: "Completed", result }), result);
  assert.deepEqual(unwrap({ state: "Completed", result: { result } }), result);
  assert.equal(unwrap({ state: "Completed", result: { model: "x" } }), null);
});

test("sanitizes upstream failure", async () => {
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

test("LHR skips binding and calls off-platform relay first", async () => {
  const originalFetch = globalThis.fetch;
  let relayCalls = 0;
  globalThis.fetch = async (url, init) => {
    relayCalls += 1;
    assert.equal(String(url), "https://relay.example/v1/systemone");
    assert.equal(init.headers.authorization, "Bearer relay-secret");
    assert.deepEqual(JSON.parse(init.body), input);
    return Response.json(result);
  };
  try {
    const env = {
      PROXY_API_KEY: "test",
      RELAY_URL: "https://relay.example/v1/systemone",
      RELAY_KEY: "relay-secret",
      AI: { run: () => { throw new Error("edge binding must not run for LHR"); } },
    };
    const output = await runJev(env, input, { colo: "LHR" });
    assert.deepEqual(unwrap(output), result);
    assert.equal(relayCalls, 1);

    const response = await worker.fetch(req(payload, "test", { cf: { colo: "LHR" } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.equal(relayCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("healthy ingress falls back to relay after AiGatewayError 2002", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://relay.example/v1/systemone");
    assert.equal(init.headers.authorization, "Bearer relay-secret");
    return Response.json({ state: "Completed", result });
  };
  try {
    const response = await worker.fetch(req(), {
      PROXY_API_KEY: "test",
      RELAY_URL: "https://relay.example/v1/systemone",
      RELAY_KEY: "relay-secret",
      AI: { run: () => { throw Object.assign(new Error("2002: Model execution failed (Error)"), { name: "AiGatewayError" }); } },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runRelay requires RELAY_URL and RELAY_KEY", async () => {
  await assert.rejects(() => runRelay({}, input), /RELAY_URL and RELAY_KEY/);
});

test("runRelay surfaces upstream errors without leaking the relay key", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  globalThis.fetch = async () => Response.json({ error: { message: "upstream boom" } }, { status: 502 });
  try {
    await assert.rejects(
      () => runRelay({ RELAY_URL: "https://relay.example/v1/systemone", RELAY_KEY: "super-secret-relay" }, input),
      /upstream boom/,
    );
    assert.ok(!JSON.stringify(logs).includes("super-secret-relay"));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
