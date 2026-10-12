const json = (value, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" },
});
const error = (status, message) => json({ error: { message } }, status);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const description = v => typeof v === "string" || v !== null && typeof v === "object";

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
    try {
      const output = await env.AI.run(
        "typesafe/jev",
        { state: body.state, questions: body.questions },
        { gateway: { id: "default" } },
      );
      const result = output?.answers ? output : output?.result?.answers ? output.result : null;
      if (!result?.usage || typeof result.model !== "string") return error(502, "Unexpected model response");
      return json(result);
    } catch (cause) {
      if (/2021\s*:\s*Insufficient AI Gateway credits/i.test(String(cause?.message ?? "")))
        return json({ error: { message: "Cloudflare AI Gateway has insufficient credits", code: "insufficient_credits" } }, 402);
      console.error("Jev inference failed", {
        errorName: cause instanceof Error ? cause.name : "UnknownError",
        aiGatewayLogId: env.AI.aiGatewayLogId,
      });
      return error(502, "Cloudflare model invocation failed");
    }
  },
};
