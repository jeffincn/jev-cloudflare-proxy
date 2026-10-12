import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { runJev, runRest, unwrap, JevInference } from "../src/index.js";

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

const mockJev = (handler) => ({
  idFromName: (name) => ({ name }),
  get: (id, opts) => {
    assert.equal(id.name, "jev");
    assert.deepEqual(opts, { locationHint: "apac" });
    return { fetch: handler };
  },
});

test("preserves TypeSafe result via binding when no REST token", async () => {
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

test("uses CF_AI_API_TOKEN REST before any AI binding or Durable Object", async () => {
  const originalFetch = globalThis.fetch;
  let restCalls = 0;
  globalThis.fetch = async (url, init) => {
    restCalls += 1;
    assert.match(String(url), /\/ai\/run$/);
    assert.equal(init.headers.authorization, "Bearer rest-token");
    assert.deepEqual(JSON.parse(init.body), { model: "typesafe/jev", input });
    return Response.json({
      success: true,
      result: { state: "Completed", result },
    });
  };
  try {
    const env = {
      CF_AI_API_TOKEN: "rest-token",
      PROXY_API_KEY: "test",
      AI: { run: () => { throw new Error("binding must not run"); } },
      JEV: mockJev(async () => { throw new Error("DO must not run"); }),
    };
    const output = await runJev(env, input, { colo: "LHR" });
    assert.deepEqual(unwrap(output), result);
    assert.equal(restCalls, 1);

    const response = await worker.fetch(req(payload, "test", { cf: { colo: "LHR" } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.equal(restCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to APAC Durable Object when Worker-originated REST fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    errors: [{ code: 500, message: "Worker-origin REST 500" }],
  }), { status: 500 });
  try {
    let doCalls = 0;
    const env = {
      CF_AI_API_TOKEN: "rest-token",
      PROXY_API_KEY: "test",
      AI: { run: () => { throw new Error("edge binding must not run"); } },
      JEV: mockJev(async (request) => {
        doCalls += 1;
        assert.deepEqual(await request.json(), input);
        return Response.json({ state: "Completed", result });
      }),
    };
    const response = await worker.fetch(req(payload, "test", { cf: { colo: "LHR" } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.equal(doCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Durable Object runner prefers binding then REST", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, result });
  try {
    const okBinding = new JevInference({}, {
      AI: { run: async () => result },
      CF_AI_API_TOKEN: "rest-token",
    });
    assert.deepEqual(await (await okBinding.fetch(new Request("https://do/run", {
      method: "POST", body: JSON.stringify(input),
    }))).json(), result);

    const viaRest = new JevInference({}, {
      AI: { run: async () => { throw Object.assign(new Error("2002: Error"), { name: "AiGatewayError" }); } },
      CF_AI_API_TOKEN: "rest-token",
    });
    assert.deepEqual(await (await viaRest.fetch(new Request("https://do/run", {
      method: "POST", body: JSON.stringify(input),
    }))).json(), result);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runRest logs status without leaking the token on failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    errors: [{ code: 10000, message: "Authentication error" }],
  }), { status: 401 });
  try {
    await assert.rejects(() => runRest({ CF_AI_API_TOKEN: "super-secret-token" }, input), /Authentication error/);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], "Jev REST failed");
    assert.equal(logs[0][1].restStatus, 401);
    assert.equal(logs[0][1].restError, "Authentication error");
    assert.ok(!JSON.stringify(logs).includes("super-secret-token"));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
