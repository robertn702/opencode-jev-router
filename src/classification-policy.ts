import { MODELS, supportsEffort, type Effort } from "./models.js";

export interface ClassificationPolicyOptions {
  maxRetries?: number;
  fallbackMode?: "fixed" | "previous" | "error";
  fallbackEffort?: Effort;
}

export function classificationPolicy(options: ClassificationPolicyOptions) {
  const maxRetries = options.maxRetries ?? 1;
  const fallbackMode = options.fallbackMode ?? "fixed";
  const fallbackEffort = options.fallbackEffort ?? "high";
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error("maxRetries must be an integer from 0 to 10");
  if (!["fixed", "previous", "error"].includes(fallbackMode)) throw new Error("fallbackMode must be fixed, previous, or error");
  if (!MODELS.every((model) => supportsEffort(model, fallbackEffort))) throw new Error("fallbackEffort must be supported by every model");
  return { maxRetries, fallbackMode, fallbackEffort };
}

export class ClassificationFailedError extends Error {
  constructor(readonly reason: string, readonly attempts: number, readonly latencyMs: number) {
    super("jev_classification_failed");
  }
}
