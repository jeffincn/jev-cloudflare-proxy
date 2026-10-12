const ACCOUNT_ID = "5b6c981ebeb77b3e3566ffc9ba8be751";
const HOP_HEADER = "x-jev-edge-hop";
/** Ingress colos where env.AI.run(typesafe/jev) returns AiGatewayError 2002 even with remote-SIN placement. */
const BINDING_UNRELIABLE_COLOS = new Set(["LHR"]);

const json = (value, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" },
});
const error = (status, message) => json({ error: { message } }, status);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const description = v => typeof v === "string" || v !== null && typeof v === "object";

const unwrap = output => {
  const result = output?.answers ? output : output?.result?.answers ? output.result : null;
  return result?.usage && typeof result.model === "string" ? result : null;
};

const insufficientCredits = detail => /2021\s*:\s*Insufficient AI Gateway credits/i.test(detail);
const gatewayUpstream = detail => /^2002\s*:/i.test(detail);

const runBinding = (env, input) => env.AI.run("typesafe/jev", input, { gateway: { id: "default" } });

async function runRest(env, input) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CF_AI_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "typesafe/jev", input }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.errors?.[0]?.message ?? `AI REST ${response.status}`;
    const err = new Error(message);
    err.name = "AiGatewayError";
    err.restStatus = response.status;
    throw err;
  }
  return payload?.result ?? payload;
}

/** Re-enter via workers.dev so AI binding sees a healthy ingress colo (proven: local-SIN works). */
async function runWorkersDevHop(env, input) {
  const response = await fetch(new URL("/v1/systemone", env.WORKERS_DEV_ORIGIN), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.PROXY_API_KEY}`,
      "content-type": "application/json",
      [HOP_HEADER]: "1",
    },
    body: JSON.stringify({ model: "typesafe/jev", state: input.state, questions: input.questions }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? `workers.dev hop ${response.status}`;
    const err = new Error(message);
    err.name = "AiGatewayError";
    err.restStatus = response.status;
    throw err;
  }
  return payload;
}

/**
 * Run Jev inference.
 * - Binding works when the *ingress* colo is healthy (e.g. workers.dev → SIN).
 * - remote-SIN placement does NOT fix LHR-ingress 2002; AI binding still fails.
 * - Fallbacks: CF_AI_API_TOKEN REST (preferred), else WORKERS_DEV_ORIGIN hop (no new secret).
 */
export async function runJev(env, input, { colo = null, allowHop = true } = {}) {
  const skipBinding = colo && BINDING_UNRELIABLE_COLOS.has(colo);
  let bindingError = null;

  if (!skipBinding) {
    try {
      return await runBinding(env, input);
    } catch (cause) {
      bindingError = cause;
      if (!gatewayUpstream(String(cause?.message ?? ""))) throw cause;
    }
  }

  if (env.CF_AI_API_TOKEN) {
    try {
      return await runRest(env, input);
    } catch (cause) {
      if (!allowHop || !env.WORKERS_DEV_ORIGIN || !env.PROXY_API_KEY) throw cause;
      return runWorkersDevHop(env, input);
    }
  }

  if (allowHop && env.WORKERS_DEV_ORIGIN && env.PROXY_API_KEY) {
    return runWorkersDevHop(env, input);
  }

  if (bindingError) throw bindingError;
  const err = new Error("2002: Error");
  err.name = "AiGatewayError";
  throw err;
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return json({ status: "ok" });
    if (!env.PROXY_API_KEY) return error(503, "Service credentials are not configured");
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return error(401, "Invalid API key");
    const digest = async s => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
    const [a, b] = await Promise.all([digest(token), digest(env.PROXY_API_KEY)]);
    if (a.reduce((diff, byte, i) => diff | (byte ^ b[i]), 0)) return error(401, "Invalid API key");
    if (path !== "/v1/systemone") return error(404, "Not found");
    if (request.method !== "POST") return error(405, "Use POST");
    if (!request.headers.get("content-type")?.includes("application/json")) return error(415, "Use application/json");
    let body;
    try {
      // Bound actual bytes, including requests without Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return error(422, "Missing request body");
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 1024 * 1024) {
          await reader.cancel();
          return error(413, "Request exceeds 1 MiB");
        }
        chunks.push(value);
      }
      body = JSON.parse(await new Blob(chunks).text());
    } catch { return error(422, "Invalid JSON"); }
    if (!object(body) || !description(body.state) || !object(body.questions) || !Object.keys(body.questions).length)
      return error(422, "state and a nonempty questions map are required");
    if (!["jev-latest", "typesafe/jev"].includes(body.model))
      return error(422, "Supported models: jev-latest, typesafe/jev (Cloudflare-managed version)");
    for (const q of Object.values(body.questions)) {
      if (!object(q) || !description(q.instructions) || !["noul", "choice", "score"].includes(q.type))
        return error(422, "Invalid question type or instructions");
      if (q.type === "choice" && (!object(q.criteria) || !Object.keys(q.criteria).length || Object.keys(q.criteria).length > 255))
        return error(422, "Choice requires 1-255 criteria");
      if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10))
        return error(422, "Score requires 2-10 criteria");
    }
    const colo = request.cf?.colo ?? null;
    const allowHop = request.headers.get(HOP_HEADER) !== "1";
    try {
      const output = await runJev(
        env,
        { state: body.state, questions: body.questions },
        { colo, allowHop },
      );
      const result = unwrap(output);
      if (!result) return error(502, "Unexpected model response");
      return json(result);
    } catch (cause) {
      const detail = String(cause?.message ?? "");
      if (insufficientCredits(detail))
        return json({ error: { message: "Cloudflare AI Gateway has insufficient credits", code: "insufficient_credits" } }, 402);
      console.error("Jev inference failed", {
        errorName: cause instanceof Error ? cause.name : "UnknownError",
        upstreamCode: detail.match(/^(\d+)\s*:/)?.[1] ?? null,
        upstreamStatus: env.AI.lastRequestHttpStatusCode ?? cause?.restStatus ?? null,
        aiGatewayLogId: env.AI.aiGatewayLogId,
        colo,
        allowHop,
      });
      return error(502, "Cloudflare model invocation failed");
    }
  },
};
