import {
  UnsupportedInputError,
  validateResponsesRequest,
} from "./validate.js";

export { UnsupportedInputError };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const CONFIGURATION_UPDATE = "configuration_update";

export interface RewriteOptions {
  upstreamModel: string;
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
  const record = validateResponsesRequest(body);

  const input = record.input as unknown[];

  const retained = input.filter((item) => !isReasoningUpdate(item));
  const baseEffort = options.baseEffort;

  return {
    ...record,
    model: options.upstreamModel,
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
