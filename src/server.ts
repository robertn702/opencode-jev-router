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
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function upstreamUrl(base: string, path: string): URL {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\//, ""), normalizedBase);
}

export function createAppServer(options: AppServerOptions): Server {
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

    void handle(request, response, clientAbort, selectEffort, options);
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
      });
      void outcome;
      return;
    }

    if (request.method === "POST" && request.url === "/v1/responses") {
      const raw = await readBody(request);
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
      });
      emit(forwardOutcome === "forwarded" ? "completed" : "failed");
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
