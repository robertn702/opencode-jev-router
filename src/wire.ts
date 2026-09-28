import { findModel, type Effort, type ModelProfile, type Provider } from "./models.js";
import type { JevState } from "./jev.js";
import { openaiWire } from "./wire-openai.js";
import { anthropicWire } from "./wire-anthropic.js";

export class UnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}

export interface RewriteOptions {
  model: ModelProfile;
  baseEffort: Effort;
  effort: Effort;
  replayedInput?: unknown[];
}

export interface HistoryRules {
  updateEffort(item: unknown): Effort | null;
  makeUpdate(effort: Effort): unknown;
  isUserMessage(item: unknown): boolean;
  isToolOutput(item: unknown): boolean;
}

export interface WireAdapter extends HistoryRules {
  readonly provider: Provider;
  readonly path: "responses" | "messages";
  items(body: Record<string, unknown>): unknown[];
  validate(body: unknown, model: ModelProfile): Record<string, unknown>;
  rewrite(body: unknown, options: RewriteOptions): Record<string, unknown>;
  cacheKey(body: Record<string, unknown>): string | null;
  scopeParts(body: Record<string, unknown>): unknown[];
  jevState(body: Record<string, unknown>): JevState;
}

export function wireFor(provider: Provider): WireAdapter {
  return provider === "anthropic" ? anthropicWire : openaiWire;
}

export function resolveModel(body: unknown): ModelProfile {
  const model = isRecord(body) ? findModel(body.model) : undefined;
  if (!model) throw new UnsupportedInputError("request.model must name an exact registered model");
  return model;
}

export function validateRequest(body: unknown, model: ModelProfile, provider?: Provider): Record<string, unknown> {
  if (provider !== undefined && model.provider !== provider) throw new UnsupportedInputError("request.model does not match the route provider");
  return wireFor(model.provider).validate(body, model);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
