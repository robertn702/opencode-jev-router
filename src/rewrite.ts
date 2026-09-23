import {
  UnsupportedInputError,
  validateResponsesRequest,
} from "./validate.js";

export { UnsupportedInputError };

import { supportsEffort, type ModelProfile, type Effort } from "./models.js";
export type { Effort } from "./models.js";

const CONFIGURATION_UPDATE = "configuration_update";

export interface RewriteOptions {
  model: ModelProfile;
  baseEffort: Effort;
  effort: Effort;
  replayedInput?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultInput(input: unknown[], effort: Effort): unknown[] {
  const update = { type: CONFIGURATION_UPDATE, reasoning: { effort } };
  const user = input.findIndex((item) => isRecord(item) && (item.type === "message" || item.type === undefined) && item.role === "user");
  return user < 0 ? [...input, update] : [...input.slice(0, user), update, ...input.slice(user)];
}

export function rewriteResponsesRequest(
  body: unknown,
  options: RewriteOptions,
): Record<string, unknown> {
  const record = validateResponsesRequest(body, options.model);
  if (!options.model.supportsConfigurationUpdate || !supportsEffort(options.model, options.baseEffort) || !supportsEffort(options.model, options.effort)) {
    throw new UnsupportedInputError("unsupported reasoning effort or configuration update");
  }

  const input = record.input as unknown[];

  const baseEffort = options.baseEffort;

  return {
    ...record,
    model: options.model.id,
    reasoning: {
      ...(isRecord(record.reasoning) ? record.reasoning : {}),
      effort: baseEffort,
    },
    input: options.replayedInput ?? defaultInput(input, options.effort),
  };
}
