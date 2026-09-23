export class UnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}

const MESSAGE_ROLES = new Set(["user", "assistant", "system", "developer"]);

const ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "configuration_update",
  "item_reference",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateReasoningMode(body: Record<string, unknown>): void {
  const reasoning = body.reasoning;
  if (reasoning === undefined) {
    return;
  }
  if (!isRecord(reasoning)) {
    throw new UnsupportedInputError("request.reasoning must be a JSON object when present");
  }
  const mode = reasoning.mode;
  if (mode === undefined) {
    return;
  }
  if (mode !== "standard") {
    throw new UnsupportedInputError(
      `request.reasoning.mode ${JSON.stringify(mode)} is not supported; this proxy serves Astra standard, single-agent mode only`,
    );
  }
}

export function isUnsupportedProModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("astra-pro") || normalized.endsWith("-pro");
}

function validateModel(model: unknown, expectedModel?: string): void {
  if (model === undefined && expectedModel === undefined) return;
  if (typeof model !== "string") {
    throw new UnsupportedInputError("request.model must be a string matching the configured execution model");
  }
  if (isUnsupportedProModel(model)) {
    throw new UnsupportedInputError(
      `model ${JSON.stringify(model)} requests pro execution which is not supported; this proxy serves Astra standard, single-agent mode only`,
    );
  }
  if (expectedModel !== undefined && model !== expectedModel) {
    throw new UnsupportedInputError("request.model does not match the configured execution model");
  }
}

function validateItem(item: unknown, index: number): void {
  if (!isRecord(item)) {
    throw new UnsupportedInputError(`request.input[${index}] must be a JSON object`);
  }
  const { type, role } = item;
  if (type === undefined) {
    if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) {
      throw new UnsupportedInputError(
        `request.input[${index}] must be a message item with a supported role or a typed item`,
      );
    }
    return;
  }
  if (typeof type !== "string" || !ITEM_TYPES.has(type)) {
    throw new UnsupportedInputError(
      `request.input[${index}] has unsupported item type ${JSON.stringify(type)}`,
    );
  }
  if (type === "message" && (typeof role !== "string" || !MESSAGE_ROLES.has(role))) {
    throw new UnsupportedInputError(
      `request.input[${index}] message item has unsupported role ${JSON.stringify(role)}`,
    );
  }
}

export function validateResponsesRequest(body: unknown, expectedModel?: string): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new UnsupportedInputError("request body must be a JSON object");
  }
  validateModel(body.model, expectedModel);
  validateReasoningMode(body);
  if (body.truncation === "auto") {
    throw new UnsupportedInputError(
      'request.truncation "auto" is not supported with configuration_update injection',
    );
  }
  const input = body.input;
  if (!Array.isArray(input)) {
    throw new UnsupportedInputError(
      "request.input must be an array of Responses input items",
    );
  }
  input.forEach(validateItem);
  return body;
}
