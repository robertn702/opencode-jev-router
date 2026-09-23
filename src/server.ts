import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { buildEvidence, type Evidence } from "./evidence.js";
import { forwardUpstream, type UpstreamOutcome } from "./forward.js";
import {
  rewriteResponsesRequest,
  UnsupportedInputError,
  type Effort,
} from "./rewrite.js";
import { validateResponsesRequest } from "./validate.js";

export interface EffortDecision {
  effort: Effort;
  jevLatencyMs: number;
  fallback: "jev_timeout" | "jev_error" | "jev_invalid_output" | null;
}

export type EffortSelector = (args: {
  body: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<EffortDecision>;

export interface AppServerOptions {
  upstreamBaseUrl: string;
  upstreamModel: string;
  baseEffort: Effort;
  selectEffort?: EffortSelector;
  onEvidence?: (evidence: Evidence) => void;
  maxRequestBytes?: number;
  maxInFlight?: number;
  upstreamHeaderTimeoutMs?: number;
  upstreamIdleTimeoutMs?: number;
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

export function createAppServer(options: AppServerOptions): Server {
  let inFlight = 0;
  const selectEffort: EffortSelector =
    options.selectEffort ??
    (async () => ({
      effort: options.baseEffort,
      jevLatencyMs: 0,
      fallback: null,
    }));

  return createServer((request, response) => {
    const clientAbort = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) {
        clientAbort.abort();
      }
    };
    response.on("close", onClose);

    const proxied = (request.method === "POST" && request.url === "/v1/responses") ||
      (request.method === "GET" && request.url === "/v1/models");
    if (proxied && inFlight >= (options.maxInFlight ?? 32)) {
      request.pause();
      response.setHeader("connection", "close");
      options.onEvidence?.(buildEvidence({ requestId: randomUUID(), outboundModel: options.upstreamModel,
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

    void handle(request, response, clientAbort, selectEffort, options).finally(release);
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  clientAbort: AbortController,
  selectEffort: EffortSelector,
  options: AppServerOptions,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && request.url === "/v1/models") {
      const outcome = await forwardUpstream(response, {
        method: "GET",
        url: upstreamUrl(options.upstreamBaseUrl, "models"),
        authorization: request.headers.authorization,
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
        options.onEvidence?.(buildEvidence({ requestId: randomUUID(), outboundModel: options.upstreamModel,
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
        options.onEvidence?.(buildEvidence({ requestId: randomUUID(), outboundModel: options.upstreamModel,
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

      try {
        validateResponsesRequest(parsed);
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

      let decision: EffortDecision;
      try {
        decision = await selectEffort({
          body: parsed as Record<string, unknown>,
          signal: clientAbort.signal,
        });
      } catch {
        if (clientAbort.signal.aborted) {
          return;
        }
        throw new Error("effort selection must resolve");
      }

      if (clientAbort.signal.aborted) {
        return;
      }

      const rewritten = rewriteResponsesRequest(parsed, {
        upstreamModel: options.upstreamModel,
        baseEffort: options.baseEffort,
        effort: decision.effort,
      });

      const outboundInput = Array.isArray(rewritten.input) ? rewritten.input : [];
      const outboundUpdate = outboundInput.at(-1);
      let outboundEffort: unknown = null;
      if (typeof outboundUpdate === "object" && outboundUpdate !== null) {
        const reasoning = (outboundUpdate as { reasoning?: unknown }).reasoning;
        if (typeof reasoning === "object" && reasoning !== null) {
          outboundEffort = (reasoning as { effort?: unknown }).effort ?? null;
        }
      }

      const onEvidence = options.onEvidence;
      const emit = (outcome: string): void => {
        if (onEvidence === undefined) {
          return;
        }
        onEvidence(
          buildEvidence({
            requestId: randomUUID(),
            outboundModel: rewritten.model,
            outboundEffort,
            jevLatencyMs: decision.jevLatencyMs,
            fallback: decision.fallback,
            outcome,
          }),
        );
      };

      const forwardOutcome: UpstreamOutcome = await forwardUpstream(response, {
        method: "POST",
        url: upstreamUrl(options.upstreamBaseUrl, "responses"),
        authorization: request.headers.authorization,
        body: JSON.stringify(rewritten),
        signal: clientAbort.signal,
        headerTimeoutMs: options.upstreamHeaderTimeoutMs ?? 10_000,
        idleTimeoutMs: options.upstreamIdleTimeoutMs ?? 60_000,
      });
      emit(forwardOutcome === "forwarded" ? "completed" : forwardOutcome === "upstream_timeout" ? "upstream_timeout" : "failed");
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
