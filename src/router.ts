import { randomUUID } from "node:crypto";

import { buildEvidence, type Evidence } from "./evidence.js";
import { LineageStore } from "./lineage.js";
import type { ModelProfile } from "./models.js";
import { rewriteResponsesRequest, UnsupportedInputError, type Effort } from "./rewrite.js";
import { resolveModel, validateResponsesRequest } from "./validate.js";
import type { Usage } from "./usage.js";

export interface EffortDecision {
  effort: Effort;
  jevLatencyMs: number;
  fallback: "jev_timeout" | "jev_error" | "jev_invalid_output" | null;
  jevErrorCategory?: "http_auth" | "http_rate_limit" | "http_4xx" | "http_5xx" | "http_other" | "connection" | "sdk_timeout" | "sdk_abort" | "unknown";
}

export type EffortSelector = (args: { model: ModelProfile; body: Record<string, unknown>; signal: AbortSignal; cacheScope?: string }) => Promise<EffortDecision>;

export interface RouterOptions {
  baseEffort?: Effort;
  selectEffort: EffortSelector;
  onEvidence?: (evidence: Evidence) => void;
}

export interface RouterRequest {
  signal: AbortSignal;
  scope: unknown[] | null;
  session?: string | null;
  turnId?: string | null;
  cacheScope?: string;
}

export interface PreparedRequest {
  body: Record<string, unknown>;
  finish: (outcome: string, status: number, terminal: boolean, usage?: Usage) => void;
}

/** Transport-independent Responses orchestration shared by the HTTP proxy and plugin. */
export class ResponsesRouter {
  private lineage = new LineageStore();
  constructor(private readonly options: RouterOptions) {}

  reset(): void { this.lineage = new LineageStore(); }

  async prepare(value: unknown, request: RouterRequest): Promise<PreparedRequest | null> {
    const model = resolveModel(value);
    validateResponsesRequest(value, model);
    const body = value as Record<string, unknown>;
    let decision: EffortDecision;
    try {
      decision = await this.options.selectEffort({ model, body, signal: request.signal, cacheScope: request.cacheScope });
    } catch {
      if (request.signal.aborted) return null;
      throw new Error("effort selection must resolve");
    }
    if (request.signal.aborted) return null;

    const history = this.lineage.prepare(body.input as unknown[], request.scope, decision.effort);
    if (history.unsafe) {
      history.discard();
      throw new UnsupportedInputError("request history has a conflicting reasoning configuration update at the selected boundary");
    }
    const rewritten = rewriteResponsesRequest(value, {
      model,
      baseEffort: this.options.baseEffort ?? model.defaultBaseEffort,
      effort: decision.effort,
      replayedInput: history.input,
    });
    let finished = false;
    return {
      body: rewritten,
      finish: (outcome, status, terminal, usage) => {
        if (finished) return;
        finished = true;
        if (outcome === "completed" && status >= 200 && status < 300 && terminal) history.commit();
        else history.discard();
        this.options.onEvidence?.(buildEvidence({
          requestId: randomUUID(), usage, previousEffort: history.previousEffort,
          lineageStatus: history.status, historyUpdatesReplayed: history.replayed,
          session: request.session ?? null, turnId: request.turnId ?? null,
          outboundModel: rewritten.model, outboundEffort: decision.effort,
          jevLatencyMs: decision.jevLatencyMs, fallback: decision.fallback,
          jevErrorCategory: decision.jevErrorCategory, outcome,
        }));
      },
    };
  }
}
