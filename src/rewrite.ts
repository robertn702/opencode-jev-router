export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const CONFIGURATION_UPDATE = "configuration_update";

export class UnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}

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
  if (!isRecord(body)) {
    throw new UnsupportedInputError("request body must be a JSON object");
  }

  const input = body.input;
  if (!Array.isArray(input)) {
    throw new UnsupportedInputError(
      "request.input must be an array of Responses input items",
    );
  }

  const retained = input.filter((item) => !isReasoningUpdate(item));
  const baseEffort = options.baseEffort;

  return {
    ...body,
    model: options.upstreamModel,
    reasoning: { ...(isRecord(body.reasoning) ? body.reasoning : {}), effort: baseEffort },
    input: [
      ...retained,
      {
        type: CONFIGURATION_UPDATE,
        reasoning: { effort: options.effort },
      },
    ],
  };
}
