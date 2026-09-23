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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReasoningUpdate(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === CONFIGURATION_UPDATE &&
    isRecord(value.reasoning)
  );
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

  const retained = input.filter((item) => !isReasoningUpdate(item));
  const baseEffort = options.baseEffort;

  return {
    ...record,
    model: options.model.id,
    reasoning: {
      ...(isRecord(record.reasoning) ? record.reasoning : {}),
      effort: baseEffort,
    },
    input: [
      ...retained,
      {
        type: CONFIGURATION_UPDATE,
        reasoning: { effort: options.effort },
      },
    ],
  };
}
