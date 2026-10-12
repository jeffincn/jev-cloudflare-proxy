const ACCOUNT_ID = "5b6c981ebeb77b3e3566ffc9ba8be751";
/** Ingress colos where env.AI.run(typesafe/jev) fails (even with remote-SIN placement). */
const BINDING_UNRELIABLE_COLOS = new Set(["LHR"]);

const json = (value, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" },
});
const error = (status, message) => json({ error: { message } }, status);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const description = v => typeof v === "string" || v !== null && typeof v === "object";

/** Accept binding output, `{ result }`, or REST `{ state:"Completed", result:{ model, answers, usage } }`. */
export const unwrap = output => {
  let cur = output;
  for (let i = 0; i < 4 && cur && typeof cur === "object" && !cur.answers; i++) {
    cur = cur.result ?? null;
  }
  return cur?.answers && cur?.usage && typeof cur.model === "string" ? cur : null;
};

const insufficientCredits = detail => /2021\s*:\s*Insufficient AI Gateway credits/i.test(detail);

const runBinding = (env, input) => env.AI.run("typesafe/jev", input);

export async function runRest(env, input) {
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
    const message = payload?.errors?.[0]?.message ?? `AI REST HTTP ${response.status}`;
    console.error("Jev REST failed", {
      restStatus: response.status,
      restError: message,
      restCode: payload?.errors?.[0]?.code ?? null,
    });
    const err = new Error(message);
    err.name = "AiGatewayError";
    err.restStatus = response.status;
    throw err;
  }
  // Cloudflare may return the model payload directly or nest it under result / Completed.
  return payload?.result ?? payload;
}

/** Run inference inside an APAC Durable Object (no LHR eyeball colo on AI Gateway). */
export async function runDurable(env, input) {
  if (!env.JEV?.idFromName) {
    const err = new Error("JEV Durable Object binding is not configured");
    err.name = "AiGatewayError";
    throw err;
  }
  const stub = env.JEV.get(env.JEV.idFromName("jev"), { locationHint: "apac" });
  const response = await stub.fetch(new Request("https://jev-do/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? `durable hop HTTP ${response.status}`;
    console.error("Jev Durable Object failed", {
      restStatus: response.status,
      restError: message,
    });
    const err = new Error(message);
    err.name = "AiGatewayError";
    err.restStatus = response.status;
    throw err;
  }
  return payload;
}

/**
 * Inference order when CF_AI_API_TOKEN is set (production):
 *   1) Account AI REST (verified working outside CF)
 *   2) APAC Durable Object (binding and/or REST away from LHR ingress)
 * Without a token: binding on healthy ingress, else Durable Object.
 */
export async function runJev(env, input, { colo = null } = {}) {
  const unreliable = Boolean(colo && BINDING_UNRELIABLE_COLOS.has(colo));
  let lastError = null;

  if (env.CF_AI_API_TOKEN) {
    try {
      return await runRest(env, input);
    } catch (cause) {
      lastError = cause;
    }
  }

  if (env.JEV?.idFromName && (env.CF_AI_API_TOKEN || unreliable || lastError)) {
    try {
      return await runDurable(env, input);
    } catch (cause) {
      lastError = cause;
    }
  }

  if (!unreliable && !env.CF_AI_API_TOKEN) {
    try {
      return await runBinding(env, input);
    } catch (cause) {
      lastError = cause;
      if (env.JEV?.idFromName) return runDurable(env, input);
      throw cause;
    }
  }

  if (lastError) throw lastError;
  const err = new Error("2002: Error");
  err.name = "AiGatewayError";
  throw err;
}

/** APAC-placed isolate for typesafe/jev when the edge Worker is on a bad AI Gateway path. */
export class JevInference {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const input = await request.json();
    try {
      try {
        return Response.json(await runBinding(this.env, input));
      } catch (bindingError) {
        if (!this.env.CF_AI_API_TOKEN) throw bindingError;
        return Response.json(await runRest(this.env, input));
      }
    } catch (cause) {
      const detail = String(cause?.message ?? "");
      return Response.json(
        { error: { message: detail || "Durable inference failed" } },
        { status: 502 },
      );
    }
  }
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
    try {
      const output = await runJev(env, { state: body.state, questions: body.questions }, { colo });
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
        upstreamStatus: env.AI?.lastRequestHttpStatusCode ?? cause?.restStatus ?? null,
        aiGatewayLogId: env.AI?.aiGatewayLogId ?? null,
        colo,
        detail: detail.slice(0, 200),
      });
      return error(502, "Cloudflare model invocation failed");
    }
  },
};
