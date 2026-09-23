import { findModel, supportsEffort, type ModelProfile } from "./models.js";

export function resolveModel(body: unknown): ModelProfile {
  const model = isRecord(body) ? findModel(body.model) : undefined;
  if (!model) throw new UnsupportedInputError("request.model must name an exact registered model");
  return model;
}

export class UnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}

const MESSAGE_ROLES = new Set(["user", "assistant", "system", "developer"]);

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
      "request.reasoning.mode is not supported; this proxy serves standard, single-agent mode only",
    );
  }
}

function validateItem(item: unknown, index: number, model: ModelProfile): void {
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
  // The upstream owns typed-item schemas. A fixed local list would reject new
  // hosted tools and response items even when the selected upstream accepts them.
  if (typeof type !== "string" || type.length === 0) {
    throw new UnsupportedInputError(
      `request.input[${index}].type must be a non-empty string`,
    );
  }
  if (type === "message" && (typeof role !== "string" || !MESSAGE_ROLES.has(role))) {
    throw new UnsupportedInputError(
      `request.input[${index}] message item has unsupported role ${JSON.stringify(role)}`,
    );
  }
  if (type === "configuration_update" && item.reasoning !== undefined) {
    if (!isRecord(item.reasoning) || Object.keys(item).some((key) => key !== "type" && key !== "reasoning") ||
      Object.keys(item.reasoning).length !== 1 || !supportsEffort(model, item.reasoning.effort)) {
      throw new UnsupportedInputError(`request.input[${index}] configuration_update supports only reasoning.effort valid for request.model`);
    }
  }
  if (type === "configuration_update" && item.reasoning === undefined) {
    throw new UnsupportedInputError(`request.input[${index}] configuration_update requires reasoning.effort valid for request.model`);
  }
}

export function validateResponsesRequest(body: unknown, model: ModelProfile): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new UnsupportedInputError("request body must be a JSON object");
  }
  if (body.model !== model.id) throw new UnsupportedInputError("request.model does not match the resolved model");
  validateReasoningMode(body);
  if (body.truncation === "auto") {
    throw new UnsupportedInputError(
      'request.truncation "auto" is not supported with configuration_update injection',
    );
  }
  if (body.truncation !== undefined && body.truncation !== "disabled") {
    throw new UnsupportedInputError('request.truncation must be "disabled" when present');
  }
  const input = body.input;
  if (!Array.isArray(input)) {
    throw new UnsupportedInputError(
      "request.input must be an array of Responses input items",
    );
  }
  input.forEach((item, index) => validateItem(item, index, model));
  return body;
}
