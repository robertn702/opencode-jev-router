// Metadata-only live smoke. Run after npm run build with Node 24.
import { once } from "node:events";
import { loadConfig } from "../dist/config.js";
import { createAppServer } from "../dist/server.js";
import { createJevClassifier } from "../dist/jev.js";
import { MODELS } from "../dist/models.js";
try { process.loadEnvFile(".env"); } catch {}
// The smoke selects exact request models; obsolete local singleton settings
// are deliberately excluded without modifying the user's environment file.
const env = { ...process.env };
delete env.UPSTREAM_MODEL;
const config = loadConfig(env);
const classifier = createJevClassifier({ apiKey: env.TYPESAFE_API_KEY, timeoutMs: config.jevTimeoutMs });
const server = createAppServer({ ...config, selectEffort: classifier.select });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const endpoint = `http://127.0.0.1:${server.address().port}/v1/responses`;
const upstream = new URL(config.upstreamBaseUrl).origin;
try {
  for (const model of MODELS) {
    const post = (body) => fetch(endpoint, { method: "POST", signal: AbortSignal.timeout(90000), headers: { "content-type": "application/json", authorization: `Bearer ${env.CLIPROXY_KEY ?? ""}` }, body: JSON.stringify({ model: model.id, store: false, ...body }) });
    for (const type of ["non-streaming", "SSE", "tool-continuation"]) {
      let status;
      let outcome = "failed";
      try {
        const tool = type === "tool-continuation";
        const input = [{ role: "user", content: tool ? "Call the ping function." : "Reply OK." }];
        const response = await post({ input, stream: type === "SSE", ...(tool ? { tools: [{ type: "function", name: "ping", parameters: { type: "object", properties: {}, additionalProperties: false }, strict: true }], tool_choice: { type: "function", name: "ping" } } : {}) });
        status = response.status;
        if (type === "SSE") {
          const text = await response.text();
          outcome = response.ok && text.includes("response.completed") ? "completed" : "failed";
        } else {
          const body = await response.json();
          outcome = response.ok && body.status === "completed" ? "completed" : "failed";
          if (tool && response.ok) {
            const call = body.output?.find((item) => item.type === "function_call");
            outcome = "no_tool_call";
            if (call) {
              const next = await post({ input: [...input, ...body.output, { type: "function_call_output", call_id: call.call_id, output: "ok" }] });
              status = next.status;
              const result = await next.json();
              outcome = next.ok && result.status === "completed" ? "completed" : "failed";
            }
          }
        }
      } catch { outcome = "request_failed_or_timeout"; }
      console.log(JSON.stringify({ model: model.id, upstream, auth: config.upstreamAuth.policy, type, status, outcome }));
    }
  }
} finally { server.closeAllConnections(); server.close(); }
