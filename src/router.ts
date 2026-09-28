import { randomUUID } from "node:crypto";
import { ClassificationFailedError } from "./classification-policy.js";

import { buildEvidence, type Evidence } from "./evidence.js";
import { LineageStore } from "./lineage.js";
import type { ModelProfile, Provider, Effort } from "./models.js";
import { resolveModel, validateRequest, wireFor, UnsupportedInputError } from "./wire.js";
import type { Usage } from "./usage.js";

export interface EffortDecision {
  effort: Effort;
  jevLatencyMs: number;
  fallback: "jev_timeout" | "jev_error" | "jev_invalid_output" | null;
  jevAttempts?: number;
  fallbackSource?: "fixed" | "previous";
  jevErrorCategory?: "http_auth" | "http_rate_limit" | "http_4xx" | "http_5xx" | "http_other" | "connection" | "sdk_timeout" | "sdk_abort" | "unknown";
}

export type EffortSelector = (args: { model: ModelProfile; body: Record<string, unknown>; signal: AbortSignal; cacheScope?: string; cacheKey?: string | null }) => Promise<EffortDecision>;

export interface RouterOptions {
  baseEffort?: Effort;
  selectEffort: EffortSelector;
  onEvidence?: (evidence: Evidence) => void;
}

export interface RouterRequest {
  provider?: Provider;
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
    const body = validateRequest(value, model, request.provider);
    const adapter = wireFor(model.provider);
    let decision: EffortDecision;
    try {
      decision = await this.options.selectEffort({ model, body, signal: request.signal, cacheScope: request.cacheScope,
        cacheKey: adapter.cacheKey(body) ?? (model.provider === "anthropic" ? request.session ?? null : null) });
    } catch (error) {
      if (request.signal.aborted) return null;
      if (error instanceof ClassificationFailedError) {
        this.options.onEvidence?.(buildEvidence({ requestId: randomUUID(), outboundModel: model.id, outboundEffort: "", jevLatencyMs: error.latencyMs, jevAttempts: error.attempts, fallback: null, outcome: "classification_failed" }));
        throw error;
      }
      throw new Error("effort selection must resolve");
    }
    if (request.signal.aborted) return null;

    const history = this.lineage.prepare(adapter.items(body), request.scope, decision.effort, adapter);
    if (history.unsafe) {
      history.discard();
      throw new UnsupportedInputError("request history has a conflicting reasoning configuration update at the selected boundary");
    }
    const rewritten = adapter.rewrite(value, {
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
          jevAttempts: decision.jevAttempts, fallbackSource: decision.fallbackSource,
        }));
      },
    };
  }
}
