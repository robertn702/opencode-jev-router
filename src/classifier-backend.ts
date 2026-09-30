import type { ClassificationPolicyOptions } from "./classification-policy.js";
import type { JevConnection } from "./config.js";
import { createJevClassifier, type JevClassifier, type JevClassifierOptions } from "./jev.js";
import { createLayaClassifier, type LayaClassifier, type LayaInstance } from "./laya.js";
import type { EffortSelector } from "./router.js";

interface CommonOptions extends ClassificationPolicyOptions {
  timeoutMs: number;
  cacheEntries?: number;
  cacheTtlMs?: number;
  createJev?: (options: JevClassifierOptions) => JevClassifier;
}

type BackendOptions = CommonOptions & (
  | { backend: "jev"; jev: JevConnection }
  | { backend: "laya"; modelDir?: string; cacheDir?: string; load?: () => Promise<LayaInstance> }
);

export interface ClassifierBackend {
  select: EffortSelector;
  close(): Promise<void>;
}

export function createClassifierBackend(options: BackendOptions): ClassifierBackend {
  if (options.backend === "jev") {
    const classifier = (options.createJev ?? createJevClassifier)({
      ...options.jev,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      fallbackMode: options.fallbackMode,
      fallbackEffort: options.fallbackEffort,
      cacheEntries: options.cacheEntries,
      cacheTtlMs: options.cacheTtlMs,
    });
    return { select: classifier.select, close: async () => undefined };
  }
  const classifier: LayaClassifier = createLayaClassifier({
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    fallbackMode: options.fallbackMode,
    fallbackEffort: options.fallbackEffort,
    cacheEntries: options.cacheEntries,
    cacheTtlMs: options.cacheTtlMs,
    modelDir: options.modelDir,
    cacheDir: options.cacheDir,
    load: options.load,
  });
  return classifier;
}
