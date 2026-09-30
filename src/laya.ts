import type { LayaOptions } from "@receptron/laya";

import { classificationPolicy, ClassificationFailedError, type ClassificationPolicyOptions } from "./classification-policy.js";
import { EffortCache } from "./effort-cache.js";
import { supportsEffort, type Effort, type ModelProfile } from "./models.js";
import { ClassificationCancelledError, type JevState } from "./jev.js";
import type { EffortDecision, EffortSelector } from "./router.js";
import { wireFor } from "./wire.js";

const DESCRIPTIONS: Record<Effort, string> = {
  none: "Mechanical work that does not benefit from reasoning.",
  low: "Simple, mechanical, or well-understood work.",
  medium: "Routine engineering work needing some reasoning.",
  high: "Hard problems, debugging, or multi-step reasoning.",
  xhigh: "Deeply complex or ambiguous work.",
  max: "The hardest work where extra thinking clearly helps.",
};

type LayaAnswer =
  | { type: "choice"; choice: unknown }
  | { type: "score"; score: unknown }
  | { type: "noul"; noul: unknown };

export interface LayaInstance {
  systemOne(state: unknown, questions: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface LayaClassifierOptions extends ClassificationPolicyOptions {
  timeoutMs: number;
  cacheEntries?: number;
  cacheTtlMs?: number;
  modelDir?: string;
  cacheDir?: string;
  load?: () => Promise<LayaInstance>;
}

export interface LayaClassifier {
  select: EffortSelector;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapLayaAnswer(answer: unknown, model: ModelProfile): Effort | null {
  if (!isRecord(answer) || typeof answer.type !== "string") return null;
  const typed = answer as unknown as LayaAnswer;
  if (typed.type === "choice") {
    return supportsEffort(model, typed.choice) ? typed.choice : null;
  }
  let position: number;
  if (typed.type === "score") {
    if (typeof typed.score !== "number" || !Number.isFinite(typed.score) || typed.score < 0 || typed.score > model.supportedEfforts.length - 1) return null;
    position = typed.score;
  } else if (typed.type === "noul") {
    if (typeof typed.noul !== "number" || !Number.isFinite(typed.noul) || typed.noul < 0 || typed.noul > 1) return null;
    position = typed.noul * (model.supportedEfforts.length - 1);
  } else {
    return null;
  }
  const index = Math.max(0, Math.min(model.supportedEfforts.length - 1, Math.round(position)));
  return model.supportedEfforts[index] ?? null;
}

function usableCacheKey(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function defaultLoad(options: Pick<LayaClassifierOptions, "modelDir" | "cacheDir">): Promise<LayaInstance> {
  const { Laya } = await import("@receptron/laya");
  const loadOptions: LayaOptions = {
    ...(options.modelDir === undefined ? {} : { modelDir: options.modelDir }),
    ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
  };
  return Laya.load(loadOptions);
}

export function createLayaClassifier(options: LayaClassifierOptions): LayaClassifier {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  const policy = classificationPolicy(options);
  const previousEfforts = new EffortCache(options.cacheEntries ?? 256, options.cacheTtlMs ?? 600_000);
  let loaded: Promise<LayaInstance> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const load = (): Promise<LayaInstance> => {
    if (closed) return Promise.reject(new Error("Laya classifier is closed"));
    if (loaded === undefined) {
      loaded = Promise.resolve().then(() => options.load ? options.load() : defaultLoad(options)).catch((error: unknown) => {
        loaded = undefined;
        throw error;
      });
    }
    return loaded;
  };

  const select: EffortSelector = async ({ body, signal, model, cacheScope, cacheKey: selectedCacheKey }) => {
    if (closed) throw new Error("Laya classifier is closed");
    if (signal.aborted) throw new ClassificationCancelledError();
    const startedAt = performance.now();
    const latency = (): number => Math.round(performance.now() - startedAt);
    const key = selectedCacheKey !== undefined ? selectedCacheKey : usableCacheKey(body.prompt_cache_key);
    const cacheKey = key === null ? null : JSON.stringify([cacheScope ?? "", model.id, key]);
    const state: JevState & { model: string } = { ...wireFor(model.provider).jevState(body), model: model.id };
    const questions = {
      effort: {
        type: "score",
        instructions: "Select the reasoning effort for the next model call.",
        criteria: model.supportedEfforts.map((effort) => `${effort}: ${DESCRIPTIONS[effort]}`),
      },
    } as const;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let cancelListener: (() => void) | undefined;
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => { expired = true; resolve({ kind: "timeout" }); }, options.timeoutMs);
    });
    const cancelled = new Promise<{ kind: "cancelled" }>((resolve) => {
      cancelListener = () => resolve({ kind: "cancelled" });
      signal.addEventListener("abort", cancelListener, { once: true });
    });
    const inference = (async () => {
      try {
        const instance = await load();
        // ONNX inference cannot be interrupted once started. Never launch it for
        // a request that expired, disconnected, or was disposed during loading.
        if (expired || signal.aborted || closed) return { kind: "stale" as const };
        const run = instance.systemOne(state, questions);
        active.add(run);
        try {
          return { kind: "result" as const, result: await run };
        } finally {
          active.delete(run);
        }
      } catch {
        return { kind: "error" as const };
      }
    })();

    try {
      const outcome = await Promise.race([inference, timeout, cancelled]);
      if (outcome.kind === "cancelled" || signal.aborted) throw new ClassificationCancelledError();
      const fallback = (code: "jev_timeout" | "jev_error" | "jev_invalid_output"): EffortDecision => {
        if (policy.fallbackMode === "error") throw new ClassificationFailedError(code, 1, latency());
        const previous = policy.fallbackMode === "previous" && cacheKey ? previousEfforts.get(cacheKey) : undefined;
        const fromPrevious = supportsEffort(model, previous);
        return {
          effort: fromPrevious ? previous : policy.fallbackEffort,
          jevLatencyMs: latency(),
          jevAttempts: 1,
          fallbackSource: fromPrevious ? "previous" : "fixed",
          fallback: code,
        };
      };
      if (outcome.kind === "timeout" || expired) return fallback("jev_timeout");
      if (outcome.kind === "stale") throw new ClassificationCancelledError();
      if (outcome.kind === "error") return { ...fallback("jev_error"), jevErrorCategory: "unknown" };
      const result = outcome.result;
      const effort = isRecord(result) && isRecord(result.answers) ? mapLayaAnswer(result.answers.effort, model) : null;
      if (effort === null) return fallback("jev_invalid_output");
      if (cacheKey !== null) previousEfforts.set(cacheKey, effort);
      return { effort, jevLatencyMs: latency(), jevAttempts: 1, fallback: null };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cancelListener !== undefined) signal.removeEventListener("abort", cancelListener);
    }
  };

  return {
    select,
    async close() {
      if (closing !== undefined) return closing;
      closed = true;
      closing = (async () => {
        // Loading is shared but inference is not abortable. Let it settle, then
        // close the model only after every in-flight ONNX call has finished.
        const instance = await loaded?.catch(() => undefined);
        await Promise.allSettled([...active]);
        await instance?.close();
      })();
      return closing;
    },
  };
}
