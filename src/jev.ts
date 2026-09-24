import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  choice,
  TypeSafeClient,
  type Fetch,
} from "@typesafe-ai/sdk";

import type { Effort } from "./rewrite.js";
import type { EffortDecision, EffortSelector } from "./server.js";
import { EffortCache } from "./effort-cache.js";
import { supportsEffort, type ModelProfile } from "./models.js";
import { classificationPolicy, ClassificationFailedError, type ClassificationPolicyOptions } from "./classification-policy.js";
import { setTimeout as delay } from "node:timers/promises";

const EXCERPT_LIMIT = 1600;
const USER_TEXT_LIMIT = 2000;
const ASSISTANT_TEXT_LIMIT = 2000;
const MAX_TOOL_RESULTS = 8;

function errorCategory(error: unknown): NonNullable<EffortDecision["jevErrorCategory"]> {
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) return "http_auth";
    if (error.status === 429) return "http_rate_limit";
    if (error.status >= 400 && error.status < 500) return "http_4xx";
    if (error.status >= 500 && error.status < 600) return "http_5xx";
    return "http_other";
  }
  if (error instanceof APITimeoutError) return "sdk_timeout";
  if (error instanceof APIConnectionError) return "connection";
  if (error instanceof APIUserAbortError) return "sdk_abort";
  return "unknown";
}

const DESCRIPTIONS: Record<Effort, string> = {
  none: "Mechanical work that does not benefit from reasoning.",
  low: "Simple, mechanical, or well-understood work.",
  medium: "Routine engineering work needing some reasoning.",
  high: "Hard problems, debugging, or multi-step reasoning.",
  xhigh: "Deeply complex or ambiguous work.",
  max: "The hardest work where extra thinking clearly helps.",
};

export class ClassificationCancelledError extends Error {
  constructor() {
    super("effort classification cancelled");
    this.name = "ClassificationCancelledError";
  }
}

export type JevState = {
  recent_user_text: string;
  assistant_progress: string;
  tool_results: Array<{ name: string; ok: boolean; excerpt: string }>;
  failure_state: { failed_count: number; last_failure_excerpt: string };
};

export interface JevClassifierOptions extends ClassificationPolicyOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  fetch?: Fetch;
  cacheEntries?: number;
  cacheTtlMs?: number;
}

export interface JevClassifier {
  select: EffortSelector;
  client: TypeSafeClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excerpt(text: string, limit = EXCERPT_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  const marker = "\n[...]\n";
  const head = Math.ceil((limit - marker.length) / 2);
  const tail = limit - marker.length - head;
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

function partText(content: unknown, allowUntyped = false): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part) || typeof part.text !== "string") return "";
        return part.type === "input_text" || part.type === "output_text" || part.type === "text" || (allowUntyped && part.type === undefined)
          ? part.text : "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

function outputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return partText(output, true);
  }
  if (output === undefined || output === null) {
    return "";
  }
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

function toolSucceeded(item: Record<string, unknown>): boolean {
  if ("error" in item) {
    return false;
  }
  const status = item.status;
  return !(
    typeof status === "string" &&
    (status === "failed" || status === "incomplete" || status === "error")
  );
}

export function buildJevState(input: unknown[]): JevState {
  const names = new Map<string, string>();
  for (const item of input) {
    if (
      isRecord(item) &&
      (item.type === "function_call" || item.type === "custom_tool_call") &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      names.set(item.call_id, item.name);
    }
  }

  let recentUserText = "";
  let assistantProgress = "";
  const toolResults: JevState["tool_results"] = [];

  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }
    // A typed tool/extension item is opaque even if it carries a role or
    // content field. Only genuine messages contribute user/assistant text.
    if (item.type === "message" || item.type === undefined) {
      const text = partText(item.content);
      if (item.role === "user" && text.length > 0) {
        recentUserText = excerpt(text, USER_TEXT_LIMIT);
      } else if (item.role === "assistant" && text.length > 0) {
        assistantProgress = excerpt(text, ASSISTANT_TEXT_LIMIT);
      }
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const name =
        typeof item.call_id === "string"
          ? (names.get(item.call_id) ?? "unknown")
          : "unknown";
      toolResults.push({
        name,
        ok: toolSucceeded(item),
        excerpt: excerpt(outputText(item.output)),
      });
      if (toolResults.length > MAX_TOOL_RESULTS) {
        toolResults.shift();
      }
    }
  }

  const failures = toolResults.filter((result) => !result.ok);
  const lastFailure = failures.at(-1);

  return {
    recent_user_text: recentUserText,
    assistant_progress: assistantProgress,
    tool_results: toolResults,
    failure_state: {
      failed_count: failures.length,
      last_failure_excerpt: lastFailure ? lastFailure.excerpt : "",
    },
  };
}

function extractEffort(result: unknown, model: ModelProfile): Effort | null {
  if (!isRecord(result) || !isRecord(result.answers)) {
    return null;
  }
  const answer = result.answers.effort;
  if (!isRecord(answer) || typeof answer.choice !== "string") {
    return null;
  }
  return supportsEffort(model, answer.choice) ? answer.choice : null;
}

function usableCacheKey(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function createJevClassifier(
  options: JevClassifierOptions,
): JevClassifier {
  const policy = classificationPolicy(options);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultModel: options.model,
    retry: { maxRetries: 0 },
    logLevel: "off",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const previousEfforts = new EffortCache(options.cacheEntries ?? 256, options.cacheTtlMs ?? 600_000);

  const select: EffortSelector = async ({ body, signal, model, cacheScope }) => {
    if (signal.aborted) throw new ClassificationCancelledError();
    const startedAt = performance.now();
    const latency = (): number => Math.round(performance.now() - startedAt);

    const key = usableCacheKey(body.prompt_cache_key);
    // A provider instance may serve multiple OpenCode credentials. Keep fallback
    // state tenant-scoped even though prompt text never enters the cache.
    const cacheKey = key === null ? null : JSON.stringify([cacheScope ?? "", model.id, key]);
    const input = Array.isArray(body.input) ? body.input : [];
    const state = { ...buildJevState(input), model: model.id };
    const questions = { effort: choice("Select the reasoning effort for the next model call.",
      Object.fromEntries(model.supportedEfforts.map((effort) => [effort, DESCRIPTIONS[effort]]))) };

    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        deadline.abort();
        resolve("timeout");
      }, options.timeoutMs);
    });
    const combined = AbortSignal.any([signal, deadline.signal]);

    let attempts = 0;
    const call = (async () => {
      for (;;) {
        if (combined.aborted) return { kind: "error" as const, category: "sdk_abort" as const };
        attempts++;
        try {
          return { kind: "result" as const, result: await client.systemOne({ state, questions }, { signal: combined }) };
        } catch (error) {
          const category = errorCategory(error);
          const retryable = ["http_5xx", "http_rate_limit", "connection", "sdk_timeout"].includes(category);
          if (!retryable || attempts > policy.maxRetries || combined.aborted) return { kind: "error" as const, category };
          let waitMs = Math.min(2000, 200 * 2 ** (attempts - 1)) * (0.75 + Math.random() * 0.5);
          if (error instanceof APIError) {
            const retryAfter = error.headers?.get("retry-after");
            if (retryAfter) {
              const seconds = Number(retryAfter);
              const advised = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
              if (Number.isFinite(advised)) waitMs = Math.max(waitMs, advised);
            }
          }
          try { await delay(Math.min(waitMs, options.timeoutMs), undefined, { signal: combined }); }
          catch { return { kind: "error" as const, category: "sdk_abort" as const }; }
        }
      }
    })();

    try {
      const outcome = await Promise.race([call, timeoutPromise]);

      if (signal.aborted) {
        throw new ClassificationCancelledError();
      }

      const fallback = (
        code: "jev_timeout" | "jev_error" | "jev_invalid_output",
      ): EffortDecision => {
        if (policy.fallbackMode === "error") throw new ClassificationFailedError(code, attempts, latency());
        return ({
        effort: (() => {
          const previous = policy.fallbackMode === "previous" && cacheKey ? previousEfforts.get(cacheKey) : undefined;
          return supportsEffort(model, previous) ? previous : policy.fallbackEffort;
        })(),
        jevLatencyMs: latency(),
        jevAttempts: attempts,
        fallbackSource: policy.fallbackMode === "previous" && cacheKey && supportsEffort(model, previousEfforts.get(cacheKey)) ? "previous" : "fixed",
        fallback: code,
      });
      };

      if (outcome === "timeout") {
        return fallback("jev_timeout");
      }
      if (outcome.kind === "error") {
        return { ...fallback("jev_error"), jevErrorCategory: outcome.category };
      }

      const effort = extractEffort(outcome.result, model);
      if (effort === null) {
        return fallback("jev_invalid_output");
      }

      if (cacheKey !== null) {
        previousEfforts.set(cacheKey, effort);
      }
      return { effort, jevLatencyMs: latency(), jevAttempts: attempts, fallback: null };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  return { select, client };
}
