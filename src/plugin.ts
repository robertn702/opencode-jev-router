import { createHash, randomUUID } from "node:crypto";

import { resolveJevConnection } from "./config.js";
import { buildPluginUpstreamRequestHeaders, pickFetchResponseHeaders } from "./headers.js";
import { createJevClassifier } from "./jev.js";
import { type Effort } from "./models.js";
import { UnsupportedInputError } from "./rewrite.js";
import { ResponsesRouter, type PreparedRequest } from "./router.js";
import { UsageObserver } from "./usage.js";
import { resolveModel, validateResponsesRequest } from "./validate.js";

type PluginOptions = { jevApiKey?: string; jevBaseUrl?: string; jevModel?: string; baseEffort?: Effort; maxRequestBytes?: number; maxInFlight?: number; upstreamHeaderTimeoutMs?: number; upstreamIdleTimeoutMs?: number };
type ProviderConfig = { npm?: string; name?: string; options?: Record<string, unknown>; models?: Record<string, unknown> };
type OpenCodeConfig = { provider?: Record<string, ProviderConfig> };
type HeaderHook = { sessionID: string; model: { providerID?: string; provider?: string }; provider: { id?: string } };

const SESSION = /^ses_[A-Za-z0-9]{1,128}$/;
const TURN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string | null | undefined): string => createHash("sha256").update(value ?? "").digest("hex");
const valid = (value: string | null, pattern: RegExp): string | null => value && pattern.test(value) ? value : null;
const error = (message: string, status = 400, code = "invalid_request"): Response => new Response(JSON.stringify({ error: code, message }), { status, headers: { "content-type": "application/json" } });
const positive = (value: number | undefined, fallback: number, name: string): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function boundedBody(request: Request, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new RangeError("request_too_large");
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new RangeError("request_too_large");
      chunks.push(next.value);
    }
  } finally { if (signal.aborted || size > maxBytes) await reader.cancel().catch(() => undefined); }
  const output = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { output.set(chunk, at); at += chunk.byteLength; }
  return output;
}

/** OpenCode loader entrypoint. All state and fetch interception are per plugin instance. */
export default async function jevRouterPlugin(_input: unknown, options: PluginOptions = {}) {
  const connection = resolveJevConnection(options.jevApiKey ?? process.env.JEV_API_KEY ?? "", options.jevBaseUrl);
  if (options.jevModel !== undefined && options.jevModel !== connection.model) throw new Error("jevModel must match the configured Jev endpoint");
  if (options.baseEffort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(options.baseEffort)) throw new Error("baseEffort is unsupported");
  const maxBytes = positive(options.maxRequestBytes, 1_048_576, "maxRequestBytes");
  const maxInFlight = positive(options.maxInFlight, 32, "maxInFlight");
  const headerTimeoutMs = positive(options.upstreamHeaderTimeoutMs, 10_000, "upstreamHeaderTimeoutMs");
  const idleTimeoutMs = positive(options.upstreamIdleTimeoutMs, 60_000, "upstreamIdleTimeoutMs");
  const classifier = createJevClassifier({ ...connection, timeoutMs: 4_000 });
  const router = new ResponsesRouter({ baseEffort: options.baseEffort, selectEffort: classifier.select });
  const controllers = new Set<AbortController>();
  const releases = new Set<() => void>();
  let inFlight = 0; let disposed = false;

  const adapter = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (disposed) return error("jev-router plugin is disposed", 503, "unavailable");
    let request: Request;
    try { request = new Request(input, init); } catch { return error("unsupported fetch input"); }
    const url = new URL(request.url);
    if (url.pathname.endsWith("/chat/completions") || !url.pathname.endsWith("/responses") || request.method !== "POST") return error("jev-router supports POST /v1/responses only");
    if (inFlight >= maxInFlight) return error("router overloaded", 503, "overloaded");
    inFlight += 1;
    const controller = new AbortController(); controllers.add(controller);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let releaseDone = false; let prepared: PreparedRequest | null = null; let handedOff = false; let timedOut = false;
    const release = (): void => { if (!releaseDone) { releaseDone = true; controllers.delete(controller); releases.delete(release); inFlight -= 1; } };
    releases.add(release);
    const discard = (outcome: string): void => prepared?.finish(outcome, 0, false);
    try {
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(await boundedBody(request, maxBytes, signal))); } catch (cause) {
        if (cause instanceof RangeError) return error("request_too_large", 413, "request_too_large");
        if (signal.aborted) return error("request cancelled", 499, "cancelled");
        return error("request body must be valid JSON");
      }
      // Validate before reading optional fields or calling Jev.
      const model = resolveModel(body);
      validateResponsesRequest(body, model);
      const record = body as Record<string, unknown>;
      const headers = new Headers(request.headers);
      const session = valid(headers.get("x-jev-session-id"), SESSION);
      const turnId = valid(headers.get("x-jev-turn-id"), TURN);
      const cacheKey = typeof record.prompt_cache_key === "string" && record.prompt_cache_key ? record.prompt_cache_key : null;
      prepared = await router.prepare(body, { signal, session, turnId, cacheScope: hash(headers.get("authorization")), scope: session || cacheKey ? [`${url.origin}${url.pathname.replace(/\/responses$/, "")}`, model.id, options.baseEffort ?? model.defaultBaseEffort, hash(headers.get("authorization")), session ?? "", cacheKey ?? "", record.instructions ?? null, record.tools ?? null] : null });
      if (prepared === null) return error("request cancelled", 499, "cancelled");
      const encoded = JSON.stringify(prepared.body);
      const upstreamHeaders = buildPluginUpstreamRequestHeaders(headers, encoded);
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, headerTimeoutMs);
      let upstream: Response;
      try { upstream = await fetch(request.url, { method: "POST", headers: upstreamHeaders, body: encoded, signal }); } finally { clearTimeout(timer); }
      const observer = new UsageObserver((upstream.headers.get("content-type") ?? "").includes("text/event-stream"));
      if (upstream.body === null) { prepared.finish("completed", upstream.status, false); release(); return new Response(null, { status: upstream.status, headers: pickFetchResponseHeaders(upstream.headers) }); }
      const reader = upstream.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          const idle = setTimeout(() => controller.abort(), idleTimeoutMs);
          try { const next = await reader.read(); if (next.done) { observer.finish(); prepared!.finish("completed", upstream.status, observer.completed, observer.usage); output.close(); release(); } else { observer.push(next.value); output.enqueue(next.value); } }
          catch (cause) { discard("failed"); output.error(cause); release(); } finally { clearTimeout(idle); }
        },
        async cancel() { controller.abort(); try { await reader.cancel(); } finally { discard("cancelled"); release(); } },
      });
      handedOff = true;
      return new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers: pickFetchResponseHeaders(upstream.headers) });
    } catch (cause) {
      discard("failed");
      if (cause instanceof UnsupportedInputError) return error(cause.message);
      if (timedOut) return error("upstream_timeout", 504, "upstream_timeout");
      if (signal.aborted) return error("request cancelled", 499, "cancelled");
      return error("upstream_unavailable", 502, "upstream_unavailable");
    } finally { if (!handedOff) { discard("failed"); release(); } }
  };

  return {
    config(config: OpenCodeConfig) {
      config.provider ??= {};
      const provider = config.provider["jev-router"] ??= { options: {}, models: {} };
      if (provider.npm !== undefined && provider.npm !== "@ai-sdk/openai") throw new Error("jev-router requires npm: @ai-sdk/openai");
      for (const model of Object.values(provider.models ?? {})) {
        if (isRecord(model) && isRecord(model.options) && model.options.useResponses === false) throw new Error("jev-router models require useResponses: true");
      }
      provider.npm = "@ai-sdk/openai"; provider.name ??= "Jev Router"; provider.options ??= {}; provider.options.fetch = adapter;
    },
    async "chat.headers"(input: HeaderHook, output: { headers: Record<string, string> }) {
      if (input.model.providerID !== "jev-router" && input.model.provider !== "jev-router" && input.provider.id !== "jev-router") return;
      output.headers["x-jev-session-id"] ??= input.sessionID;
      if (!valid(output.headers["x-jev-turn-id"] ?? null, TURN)) output.headers["x-jev-turn-id"] = randomUUID();
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); for (const release of [...releases]) release(); router.reset(); },
  };
}
