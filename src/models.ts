export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type Provider = "openai" | "anthropic";

export interface ModelProfile {
  readonly provider: Provider;
  readonly id: string;
  readonly name: string;
  readonly supportedEfforts: readonly Effort[];
  readonly defaultBaseEffort: Effort;
  readonly fallbackEffort: Effort;
  readonly supportsConfigurationUpdate: boolean;
}

function profile(id: string, name: string, supportedEfforts: Effort[], provider: Provider = "openai", defaultBaseEffort: Effort = "medium"): ModelProfile {
  return Object.freeze({ id, name, provider, supportedEfforts: Object.freeze(supportedEfforts),
    defaultBaseEffort, fallbackEffort: "medium", supportsConfigurationUpdate: true });
}

export const MODELS: readonly ModelProfile[] = Object.freeze([
  profile("gpt-6-astra", "GPT-6 Astra", ["low", "medium", "high", "xhigh", "max"]),
  profile("gpt-6-luna", "GPT-6 Luna", ["none", "low", "medium", "high", "xhigh", "max"]),
  profile("gpt-6-sol", "GPT-6 Sol", ["none", "low", "medium", "high", "xhigh", "max"]),
  profile("claude-fable-5-1", "Claude Fable 5.1", ["low", "medium", "high", "xhigh", "max"], "anthropic", "high"),
  profile("claude-mythos-5-1", "Claude Mythos 5.1", ["low", "medium", "high", "xhigh", "max"], "anthropic", "high"),
  profile("claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high", "xhigh", "max"], "anthropic"),
  profile("claude-opus-5", "Claude Opus 5", ["low", "medium", "high", "xhigh", "max"], "anthropic", "high"),
  profile("claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high", "xhigh", "max"], "anthropic"),
]);

export function modelsFor(provider: Provider): readonly ModelProfile[] {
  return MODELS.filter((model) => model.provider === provider);
}

export function findModel(id: unknown): ModelProfile | undefined {
  return MODELS.find((model) => model.id === id);
}

export function supportsEffort(model: ModelProfile, effort: unknown): effort is Effort {
  return model.supportedEfforts.some((supported) => supported === effort);
}
