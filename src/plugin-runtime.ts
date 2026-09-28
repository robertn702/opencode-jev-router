import { createHash } from "node:crypto";

import { resolveJevConnection, upstreamHostname } from "./config.js";
import { createDecisionLogger } from "./decision-log.js";
import { buildPluginUpstreamRequestHeaders, pickFetchResponseHeaders } from "./headers.js";
import { createJevClassifier } from "./jev.js";
import type { ClassificationPolicyOptions } from "./classification-policy.js";
import { MODELS, supportsEffort, type Effort, type Provider } from "./models.js";
import { ResponsesRouter, type PreparedRequest } from "./router.js";
import { UsageObserver } from "./usage.js";
import { resolveModel, validateRequest, wireFor, UnsupportedInputError } from "./wire.js";
import { ANTHROPIC_VERSION, mergeAnthropicBeta } from "./wire-anthropic.js";

/** Options shared by the OpenCode V1 and V2 plugin entrypoints. */
export type PluginOptions = ClassificationPolicyOptions & { jevTimeoutMs?: number; jevApiKey?: string; jevBaseUrl?: string; jevModel?: string; baseEffort?: Effort; fixedEffort?: Effort; maxRequestBytes?: number; maxInFlight?: number; upstreamHeaderTimeoutMs?: number; upstreamIdleTimeoutMs?: number; upstreamBaseURL?: string; upstreamApiKey?: string; anthropicUpstreamBaseURL?: string; anthropicUpstreamApiKey?: string; decisionsLogPath?: string };

/** A local rejection with the status the V1 fetch adapter returns to the SDK. */
export class PluginRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PluginRequestError";
  }
}

export interface Correlation { session: string | null; turnId: string | null }

/**
 * One routed Responses exchange. After `start` resolves the caller owns it and
 * must settle it with `respond`, `fail`, or `cancel`; the header timeout also
 * settles it when no response ever arrives.
 */
export interface Exchange {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
  /** Aborts on caller cancellation, disposal, header timeout, or idle timeout. */
  readonly signal: AbortSignal;
  /** Wrap upstream response bytes for usage observation without buffering. */
  respond(upstream: Response): Response;
  /** Settle a transport failure before response headers. */
  fail(cause: unknown): PluginRequestError;
  /** Settle a caller cancellation before response headers. */
  cancel(): void;
}

export interface PluginRuntime {
  start(request: Request, correlation: Correlation): Promise<Exchange>;
  dispose(): void;
}

export const SESSION = /^ses_[A-Za-z0-9]{1,128}$/;
export const TURN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const valid = (value: string | null | undefined, pattern: RegExp): string | null => value && pattern.test(value) ? value : null;
const hash = (value: string | null | undefined): string => createHash("sha256").update(value ?? "").digest("hex");
const positive = (value: number | undefined, fallback: number, name: string): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
};
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
};
const HTTP_URL = "must be an HTTP(S) URL without credentials, query, or fragment";
const checkUpstreamURL = (url: URL, name: string): void => {
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error(`${name} ${HTTP_URL}`);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(upstreamHostname(url));
  if (url.protocol !== "https:" && !loopback) throw new Error(`${name} requires HTTPS except for loopback endpoints`);
};
export const upstreamBaseURL = (value: unknown, name = "upstreamBaseURL or provider.options.baseURL"): string => {
  const baseURL = requiredString(value, name);
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error("upstreamBaseURL must be an HTTP(S) URL"); }
  checkUpstreamURL(url, "upstreamBaseURL");
  return baseURL;
};

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

/** Per-plugin-instance state, validation, Jev selection, rewrite, and usage observation. */
export function createPluginRuntime(options: PluginOptions): PluginRuntime {
  const env = process.env;
  const connection = options.fixedEffort === undefined ? resolveJevConnection(options.jevApiKey ?? env.JEV_ROUTER_API_KEY ?? "", options.jevBaseUrl ?? env.JEV_ROUTER_BASE_URL) : undefined;
  if (options.jevModel !== undefined && options.jevModel !== connection?.model) throw new Error("jevModel must match the configured Jev endpoint");
  if (options.baseEffort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(options.baseEffort)) throw new Error("baseEffort is unsupported");
  if (options.fixedEffort !== undefined && !MODELS.every((model) => supportsEffort(model, options.fixedEffort))) throw new Error("fixedEffort must be supported by every model");
  const maxBytes = positive(options.maxRequestBytes, 1_048_576, "maxRequestBytes");
  const maxInFlight = positive(options.maxInFlight, 32, "maxInFlight");
  const headerTimeoutMs = positive(options.upstreamHeaderTimeoutMs, 10_000, "upstreamHeaderTimeoutMs");
  const idleTimeoutMs = positive(options.upstreamIdleTimeoutMs, 60_000, "upstreamIdleTimeoutMs");
  const selectEffort = connection ? createJevClassifier({ ...connection, maxRetries: options.maxRetries, fallbackMode: options.fallbackMode, fallbackEffort: options.fallbackEffort, timeoutMs: options.jevTimeoutMs ?? 4_000 }).select : async () => ({ effort: options.fixedEffort!, jevLatencyMs: 0, fallback: null });
  const onEvidence = options.decisionsLogPath === undefined ? undefined : createDecisionLogger(options.decisionsLogPath);
  const router = new ResponsesRouter({ baseEffort: options.baseEffort, selectEffort, onEvidence });
  const controllers = new Set<AbortController>();
  // Disposal settles every open exchange: V2 never sees a response for an aborted fetch.
  const abandons = new Set<() => void>();
  let inFlight = 0; let disposed = false;

  async function start(request: Request, correlation: Correlation): Promise<Exchange> {
    if (disposed) throw new PluginRequestError(503, "unavailable", "jev-router plugin is disposed");
    const url = new URL(request.url);
    const provider: Provider | null = url.pathname.endsWith("/responses") ? "openai" : url.pathname.endsWith("/messages") ? "anthropic" : null;
    if (provider === null || request.method !== "POST") throw new PluginRequestError(400, "invalid_request", "jev-router supports POST /v1/responses or /v1/messages only");
    try { checkUpstreamURL(new URL(url.origin), "upstream URL"); } catch (cause) { throw new PluginRequestError(400, "invalid_request", (cause as Error).message); }
    if (inFlight >= maxInFlight) throw new PluginRequestError(503, "overloaded", "router overloaded");
    inFlight += 1;
    const controller = new AbortController(); controllers.add(controller);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let releaseDone = false; let prepared: PreparedRequest | null = null; let handedOff = false; let timedOut = false; let responded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = (): void => { if (!releaseDone) { releaseDone = true; clearTimeout(timer); controllers.delete(controller); abandons.delete(abandon); inFlight -= 1; } };
    const discard = (outcome: string): void => prepared?.finish(outcome, 0, false);
    const abandon = (): void => { discard("failed"); release(); };
    abandons.add(abandon);
    const settle = (outcome: string): void => { if (!responded) { discard(outcome); release(); } };
    try {
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(await boundedBody(request, maxBytes, signal))); } catch (cause) {
        if (cause instanceof RangeError) throw new PluginRequestError(413, "request_too_large", "request_too_large");
        if (signal.aborted) throw new PluginRequestError(499, "cancelled", "request cancelled");
        throw new PluginRequestError(400, "invalid_request", "request body must be valid JSON");
      }
      // Validate before reading optional fields or calling Jev.
      const model = resolveModel(body);
      validateRequest(body, model, provider);
      const record = body as Record<string, unknown>;
      const credential = provider === "anthropic" ? request.headers.get("x-api-key") ?? request.headers.get("authorization") : request.headers.get("authorization");
      const cacheKey = wireFor(provider).cacheKey(record);
      const { session, turnId } = correlation;
      prepared = await router.prepare(body, { provider, signal, session, turnId, cacheScope: hash(credential), scope: session || cacheKey ? [`${url.origin}${url.pathname.replace(/\/(responses|messages)$/, "")}`, model.id, options.baseEffort ?? model.defaultBaseEffort, hash(credential), session ?? "", cacheKey ?? "", ...wireFor(provider).scopeParts(record)] : null });
      if (prepared === null) throw new PluginRequestError(499, "cancelled", "request cancelled");
      const encoded = JSON.stringify(prepared.body);
      const headers = buildPluginUpstreamRequestHeaders(request.headers, encoded);
      if (provider === "anthropic") {
        headers.set("anthropic-beta", mergeAnthropicBeta(headers.get("anthropic-beta")));
        if (!headers.has("anthropic-version")) headers.set("anthropic-version", ANTHROPIC_VERSION);
      }
      timer = setTimeout(() => { timedOut = true; controller.abort(); settle("failed"); }, headerTimeoutMs);
      const exchange: Exchange = {
        url: request.url, headers, body: encoded, signal,
        respond(upstream) {
          clearTimeout(timer);
          if (responded) throw new Error("exchange already responded");
          if (releaseDone) {
            // Headers arrived after the deadline or disposal already settled this exchange.
            void upstream.body?.cancel().catch(() => undefined);
            throw timedOut ? new PluginRequestError(504, "upstream_timeout", "upstream_timeout") : disposed ? new PluginRequestError(503, "unavailable", "jev-router plugin is disposed") : new PluginRequestError(499, "cancelled", "request cancelled");
          }
          responded = true;
          const current = prepared!;
          const observer = new UsageObserver((upstream.headers.get("content-type") ?? "").includes("text/event-stream"), provider);
          if (upstream.body === null) { current.finish("completed", upstream.status, false); release(); return new Response(null, { status: upstream.status, headers: pickFetchResponseHeaders(upstream.headers) }); }
          const reader = upstream.body.getReader();
          const stream = new ReadableStream<Uint8Array>({
            async pull(output) {
              const idle = setTimeout(() => controller.abort(), idleTimeoutMs);
              try { const next = await reader.read(); if (next.done) { observer.finish(); current.finish("completed", upstream.status, observer.completed, observer.usage); output.close(); release(); } else { observer.push(next.value); output.enqueue(next.value); } }
              catch (cause) { current.finish("failed", 0, false); output.error(cause); release(); } finally { clearTimeout(idle); }
            },
            // OpenCode V2 cancels the body once it parses `response.completed`,
            // before EOF. A terminal event already forwarded still completes.
            async cancel() { controller.abort(); try { await reader.cancel(); } finally { if (observer.completed) current.finish("completed", upstream.status, true, observer.usage); else current.finish("cancelled", 0, false); release(); } },
          });
          return new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers: pickFetchResponseHeaders(upstream.headers) });
        },
        fail() {
          settle("failed");
          if (timedOut) return new PluginRequestError(504, "upstream_timeout", "upstream_timeout");
          if (signal.aborted) return new PluginRequestError(499, "cancelled", "request cancelled");
          return new PluginRequestError(502, "upstream_unavailable", "upstream_unavailable");
        },
        cancel() { settle("cancelled"); },
      };
      handedOff = true;
      return exchange;
    } catch (cause) {
      discard("failed");
      if (cause instanceof PluginRequestError) throw cause;
      if (cause instanceof Error && cause.message === "jev_classification_failed") throw new PluginRequestError(502, "jev_classification_failed", "jev_classification_failed");
      if (cause instanceof UnsupportedInputError) throw new PluginRequestError(400, "invalid_request", cause.message);
      if (signal.aborted) throw new PluginRequestError(499, "cancelled", "request cancelled");
      throw new PluginRequestError(502, "upstream_unavailable", "upstream_unavailable");
    } finally { if (!handedOff) { discard("failed"); release(); } }
  }

  return {
    start,
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); for (const abandon of [...abandons]) abandon(); router.reset(); },
  };
}
