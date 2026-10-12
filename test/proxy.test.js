import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const payload = { model: "jev-latest", state: "urgent", questions: { urgent: { type: "noul", instructions: "Urgent?" } } };
const result = { model: "jev-1.13.0", answers: { urgent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 5 } };
const req = (body = payload, key = "test") => new Request("https://example.com/v1/systemone", {
  method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
test("preserves TypeSafe result and invokes only Cloudflare Jev", async () => {
  const response = await worker.fetch(req(), { PROXY_API_KEY: "test", AI: { run: async (model, input, options) => {
    assert.equal(model, "typesafe/jev");
    assert.deepEqual(input, { state: payload.state, questions: payload.questions });
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
