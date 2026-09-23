import { createHash, randomUUID } from "node:crypto";
import type { UpstreamAuth } from "./config.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { buildEvidence, type Evidence } from "./evidence.js";
import { forwardUpstream, type UpstreamOutcome } from "./forward.js";
import { UnsupportedInputError, type Effort } from "./rewrite.js";
import { ResponsesRouter, type EffortDecision, type EffortSelector } from "./router.js";
import { resolveModel, validateResponsesRequest } from "./validate.js";
export type { EffortDecision, EffortSelector } from "./router.js";

export interface AppServerOptions {
  upstreamBaseUrl: string;
  upstreamAuth: UpstreamAuth;
  baseEffort?: Effort;
  selectEffort?: EffortSelector;
  onEvidence?: (evidence: Evidence) => void;
  maxRequestBytes?: number;
  maxInFlight?: number;
  upstreamHeaderTimeoutMs?: number;
  upstreamIdleTimeoutMs?: number;
  configurationValid?: boolean;
  probeDependency?: (signal: AbortSignal) => Promise<boolean>;
}

interface Lifecycle {
  draining: boolean;
  controllers: Set<AbortController>;
  responses: Set<ServerResponse>;
  shutdown?: Promise<void>;
}

const lifecycles = new WeakMap<Server, Lifecycle>();

export function shutdownAppServer(server: Server, graceMs: number, onDeadline?: () => void): Promise<void> {
  const state = lifecycles.get(server);
  if (!state) throw new Error("unknown app server");
  if (state.shutdown) return state.shutdown;
  state.draining = true;
  state.shutdown = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      onDeadline?.();
      for (const controller of state.controllers) controller.abort();
      for (const response of state.responses) response.destroy();
      server.closeAllConnections();
    }, graceMs);
    server.close((error) => {
      clearTimeout(deadline);
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
  return state.shutdown;
}

class BodyTooLargeError extends Error {}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        request.pause();
        cleanup();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error("request closed")); };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("close", onClose);
  });
}

function upstreamUrl(base: string, path: string): URL {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\//, ""), normalizedBase);
}

function upstreamAuthorization(
  options: AppServerOptions,
  clientAuthorization: string | undefined,
): string | undefined {
  return options.upstreamAuth.policy === "bearer"
    ? `Bearer ${options.upstreamAuth.apiKey}`
    : clientAuthorization;
}

function correlationId(value: string | string[] | undefined, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function credentialScope(authorization: string | undefined): string {
  return createHash("sha256").update(authorization ?? "").digest("hex");
}

export function createAppServer(options: AppServerOptions): Server {
  let inFlight = 0;
  const state: Lifecycle = { draining: false, controllers: new Set(), responses: new Set() };
  let dependencyResult: boolean | undefined;
  let dependencyCheckedAt = 0;
  let pendingProbe: Promise<boolean> | undefined;
  const dependencyReady = (): Promise<boolean> => {
    if (!options.probeDependency) return Promise.resolve(true);
    if (dependencyResult !== undefined && Date.now() - dependencyCheckedAt < 2_000) return Promise.resolve(dependencyResult);
    if (pendingProbe) return pendingProbe;
    const controller = new AbortController();
    let timeout: NodeJS.Timeout;
    pendingProbe = Promise.race([
      Promise.resolve().then(() => options.probeDependency!(controller.signal)).then((result) => result === true, () => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => { controller.abort(); resolve(false); }, 500);
      }),
    ])
      .then((result) => {
        dependencyResult = result;
        dependencyCheckedAt = Date.now();
        return result;
      }).finally(() => { clearTimeout(timeout); pendingProbe = undefined; });
    return pendingProbe;
  };
  const selectEffort: EffortSelector =
    options.selectEffort ??
    (async ({ model }) => ({
      effort: model.fallbackEffort,
      jevLatencyMs: 0,
      fallback: null,
    }));
  const router = new ResponsesRouter({ baseEffort: options.baseEffort, selectEffort, onEvidence: options.onEvidence });

  const server = createServer((request, response) => {
    if (state.draining && request.url !== "/health" && request.url !== "/ready") {
      request.pause();
      response.setHeader("connection", "close");
      writeJson(response, 503, { error: "draining" });
      return;
    }
    const clientAbort = new AbortController();
    state.controllers.add(clientAbort);
    state.responses.add(response);
    const onClose = (): void => {
      if (!response.writableEnded) {
        clientAbort.abort();
      }
    };
    response.on("close", onClose);
    response.once("close", () => { state.controllers.delete(clientAbort); state.responses.delete(response); });

    const proxied = (request.method === "POST" && request.url === "/v1/responses") ||
      (request.method === "GET" && request.url === "/v1/models");
    if (proxied && inFlight >= (options.maxInFlight ?? 32)) {
      request.pause();
      response.setHeader("connection", "close");
      options.onEvidence?.(buildEvidence({ requestId: randomUUID(), outboundModel: "",
        outboundEffort: "", jevLatencyMs: 0, fallback: null, outcome: "overloaded" }));
      writeJson(response, 503, { error: "overloaded" });
      return;
    }
    if (proxied) inFlight += 1;
    let released = false;
    const release = (): void => {
      if (released || !proxied) return;
      released = true;
      inFlight -= 1;
    };
    response.once("close", release);

    void handle(request, response, clientAbort, options, async () => {
      if (options.configurationValid === false) return "missing_configuration";
      if (state.draining || !server.listening) return state.draining ? "draining" : "starting";
      const available = await dependencyReady();
      if (state.draining) return "draining";
      return available ? null : "dependency_unavailable";
    }, router).finally(release);
  });
  lifecycles.set(server, state);
  return server;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  clientAbort: AbortController,
  options: AppServerOptions,
  readinessReason: () => Promise<string | null>,
  router: ResponsesRouter,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && request.url === "/ready") {
      const reason = await readinessReason();
      writeJson(response, reason === null ? 200 : 503,
        reason === null ? { status: "ready" } : { status: "not_ready", reason });
      return;
    }

    if (request.method === "GET" && request.url === "/v1/models") {
      const outcome = await forwardUpstream(response, {
        method: "GET",
        url: upstreamUrl(options.upstreamBaseUrl, "models"),
        authorization: upstreamAuthorization(options, request.headers.authorization),
        body: undefined,
        signal: clientAbort.signal,
        headerTimeoutMs: options.upstreamHeaderTimeoutMs ?? 10_000,
        idleTimeoutMs: options.upstreamIdleTimeoutMs ?? 60_000,
      });
      void outcome;
      return;
    }

    if (request.method === "POST" && request.url === "/v1/responses") {
      if (Number(request.headers["content-length"]) > (options.maxRequestBytes ?? 1_048_576)) {
        request.pause();
        response.setHeader("connection", "close");
        writeJson(response, 413, { error: "request_too_large" });
        options.onEvidence?.(buildEvidence({ requestId: randomUUID(), outboundModel: "",
          outboundEffort: "", jevLatencyMs: 0, fallback: null, outcome: "request_too_large" }));
        return;
      }
      let raw: string;
      try {
        raw = await readBody(request, options.maxRequestBytes ?? 1_048_576);
      } catch (error) {
        if (!(error instanceof BodyTooLargeError)) throw error;
        response.setHeader("connection", "close");
        writeJson(response, 413, { error: "request_too_large" });
        options.onEvidence?.(buildEvidence({ requestId: randomUUID(), outboundModel: "",
          outboundEffort: "", jevLatencyMs: 0, fallback: null, outcome: "request_too_large" }));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        writeJson(response, 400, {
          error: "invalid_request",
          message: "request body must be valid JSON",
        });
        return;
      }

      let prepared;
      try {
        const body = parsed as Record<string, unknown>;
        const model = resolveModel(parsed);
        validateResponsesRequest(parsed, model);
        const session = correlationId(request.headers["x-jev-session-id"], /^ses_[A-Za-z0-9]{1,128}$/);
        const cacheKey = typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0 ? body.prompt_cache_key : null;
        const authorization = upstreamAuthorization(options, request.headers.authorization);
        prepared = await router.prepare(parsed, {
          signal: clientAbort.signal, session,
          turnId: correlationId(request.headers["x-jev-turn-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
          cacheScope: credentialScope(authorization),
          scope: session || cacheKey ? [options.upstreamBaseUrl, body.model, options.baseEffort ?? model.defaultBaseEffort, authorization ?? "", session ?? "", cacheKey ?? "", body.instructions ?? null, body.tools ?? null] : null,
        });
      } catch (error) {
        if (error instanceof UnsupportedInputError) {
          writeJson(response, 400, {
            error: "invalid_request",
            message: error.message,
          });
          return;
        }
        throw error;
      }
      if (prepared === null) return;

      let accepted = false;
      let terminal = false;
      let status = 0;
      let usage;
      const forwardOutcome: UpstreamOutcome = await forwardUpstream(response, {
        method: "POST",
        onUsage: (value) => { usage = value; },
        onResponseStatus: (statusCode) => { status = statusCode; accepted = statusCode >= 200 && statusCode < 300; },
        onTerminal: (completed) => { terminal = completed; },
        url: upstreamUrl(options.upstreamBaseUrl, "responses"),
        authorization: upstreamAuthorization(options, request.headers.authorization),
        body: JSON.stringify(prepared.body),
        signal: clientAbort.signal,
        headerTimeoutMs: options.upstreamHeaderTimeoutMs ?? 10_000,
        idleTimeoutMs: options.upstreamIdleTimeoutMs ?? 60_000,
      });
      prepared.finish(forwardOutcome === "forwarded" ? "completed" : forwardOutcome === "upstream_timeout" ? "upstream_timeout" : "failed", status, terminal, usage);
      return;
    }

    writeJson(response, 404, {
      error: "not_found",
      message: "unknown route",
    });
  } catch {
    if (!response.writableEnded) {
      response.destroy();
    }
  }
}
