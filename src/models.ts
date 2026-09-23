export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelProfile {
  readonly id: string;
  readonly supportedEfforts: readonly Effort[];
  readonly defaultBaseEffort: Effort;
  readonly fallbackEffort: Effort;
  readonly supportsConfigurationUpdate: boolean;
}

function profile(id: string, supportedEfforts: Effort[]): ModelProfile {
  return Object.freeze({ id, supportedEfforts: Object.freeze(supportedEfforts),
    defaultBaseEffort: "medium", fallbackEffort: "medium", supportsConfigurationUpdate: true });
}

export const MODELS: readonly ModelProfile[] = Object.freeze([
  profile("gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]),
  profile("gpt-6-luna", ["none", "low", "medium", "high", "xhigh", "max"]),
  profile("gpt-6-sol", ["none", "low", "medium", "high", "xhigh", "max"]),
]);

export function findModel(id: unknown): ModelProfile | undefined {
  return MODELS.find((model) => model.id === id);
}

export function supportsEffort(model: ModelProfile, effort: unknown): effort is Effort {
  return model.supportedEfforts.some((supported) => supported === effort);
}
