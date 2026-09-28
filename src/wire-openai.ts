import { supportsEffort, type Effort, type ModelProfile } from "./models.js";
import { isRecord, UnsupportedInputError, type RewriteOptions, type WireAdapter } from "./wire.js";
import type { JevState } from "./jev.js";

const MESSAGE_ROLES = new Set(["user", "assistant", "system", "developer"]);
const CONFIGURATION_UPDATE = "configuration_update";
const EXCERPT_LIMIT = 1600;

function validateReasoningMode(body: Record<string, unknown>): void {
  const reasoning = body.reasoning;
  if (reasoning === undefined) return;
  if (!isRecord(reasoning)) throw new UnsupportedInputError("request.reasoning must be a JSON object when present");
  const mode = reasoning.mode;
  if (mode !== undefined && mode !== "standard") throw new UnsupportedInputError(
    "request.reasoning.mode is not supported; this proxy serves standard, single-agent mode only",
  );
}

function validateItem(item: unknown, index: number, model: ModelProfile): void {
  if (!isRecord(item)) throw new UnsupportedInputError(`request.input[${index}] must be a JSON object`);
  const { type, role } = item;
  if (type === undefined) {
    if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) throw new UnsupportedInputError(
      `request.input[${index}] must be a message item with a supported role or a typed item`,
    );
    return;
  }
  if (typeof type !== "string" || type.length === 0) throw new UnsupportedInputError(`request.input[${index}].type must be a non-empty string`);
  if (type === "message" && (typeof role !== "string" || !MESSAGE_ROLES.has(role))) throw new UnsupportedInputError(
    `request.input[${index}] message item has unsupported role ${JSON.stringify(role)}`,
  );
  if (type === CONFIGURATION_UPDATE && item.reasoning !== undefined) {
    if (!isRecord(item.reasoning) || Object.keys(item).some((key) => key !== "type" && key !== "reasoning") ||
      Object.keys(item.reasoning).length !== 1 || !supportsEffort(model, item.reasoning.effort)) {
      throw new UnsupportedInputError(`request.input[${index}] configuration_update supports only reasoning.effort valid for request.model`);
    }
  }
  if (type === CONFIGURATION_UPDATE && item.reasoning === undefined) throw new UnsupportedInputError(
    `request.input[${index}] configuration_update requires reasoning.effort valid for request.model`,
  );
}

export function validateResponsesRequest(body: unknown, model: ModelProfile): Record<string, unknown> {
  if (!isRecord(body)) throw new UnsupportedInputError("request body must be a JSON object");
  if (body.model !== model.id) throw new UnsupportedInputError("request.model does not match the resolved model");
  validateReasoningMode(body);
  if (body.truncation === "auto") throw new UnsupportedInputError('request.truncation "auto" is not supported with configuration_update injection');
  if (body.truncation !== undefined && body.truncation !== "disabled") throw new UnsupportedInputError('request.truncation must be "disabled" when present');
  if (!Array.isArray(body.input)) throw new UnsupportedInputError("request.input must be an array of Responses input items");
  body.input.forEach((item, index) => validateItem(item, index, model));
  return body;
}

function defaultInput(input: unknown[], effort: Effort): unknown[] {
  const update = openaiWire.makeUpdate(effort);
  const user = input.findIndex((item) => openaiWire.isUserMessage(item));
  return user < 0 ? [...input, update] : [...input.slice(0, user), update, ...input.slice(user)];
}

export function rewriteResponsesRequest(body: unknown, options: RewriteOptions): Record<string, unknown> {
  const record = validateResponsesRequest(body, options.model);
  if (!options.model.supportsConfigurationUpdate || !supportsEffort(options.model, options.baseEffort) || !supportsEffort(options.model, options.effort)) {
    throw new UnsupportedInputError("unsupported reasoning effort or configuration update");
  }
  return {
    ...record,
    model: options.model.id,
    reasoning: { ...(isRecord(record.reasoning) ? record.reasoning : {}), effort: options.baseEffort },
    input: options.replayedInput ?? defaultInput(record.input as unknown[], options.effort),
  };
}

export function excerpt(text: string, limit = EXCERPT_LIMIT): string {
  if (text.length <= limit) return text;
  const marker = "\n[...]\n";
  const head = Math.ceil((limit - marker.length) / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-(limit - marker.length - head))}`;
}

function partText(content: unknown, allowUntyped = false): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => {
    if (!isRecord(part) || typeof part.text !== "string") return "";
    return part.type === "input_text" || part.type === "output_text" || part.type === "text" || (allowUntyped && part.type === undefined) ? part.text : "";
  }).filter((text) => text.length > 0).join("\n");
  return "";
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return partText(output, true);
  if (output === undefined || output === null) return "";
  try { return JSON.stringify(output); } catch { return ""; }
}

function toolSucceeded(item: Record<string, unknown>): boolean {
  if ("error" in item) return false;
  const status = item.status;
  return !(typeof status === "string" && (status === "failed" || status === "incomplete" || status === "error"));
}

export function buildJevState(input: unknown[]): JevState {
  const names = new Map<string, string>();
  for (const item of input) {
    if (isRecord(item) && (item.type === "function_call" || item.type === "custom_tool_call") && typeof item.call_id === "string" && typeof item.name === "string") names.set(item.call_id, item.name);
  }
  let recentUserText = "";
  let assistantProgress = "";
  const toolResults: JevState["tool_results"] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === "message" || item.type === undefined) {
      const text = partText(item.content);
      if (item.role === "user" && text.length > 0) recentUserText = excerpt(text, 2000);
      else if (item.role === "assistant" && text.length > 0) assistantProgress = excerpt(text, 2000);
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const name = typeof item.call_id === "string" ? (names.get(item.call_id) ?? "unknown") : "unknown";
      toolResults.push({ name, ok: toolSucceeded(item), excerpt: excerpt(outputText(item.output)) });
      if (toolResults.length > 8) toolResults.shift();
    }
  }
  const failures = toolResults.filter((result) => !result.ok);
  const lastFailure = failures.at(-1);
  return { recent_user_text: recentUserText, assistant_progress: assistantProgress, tool_results: toolResults,
    failure_state: { failed_count: failures.length, last_failure_excerpt: lastFailure ? lastFailure.excerpt : "" } };
}

export const openaiWire: WireAdapter = {
  provider: "openai", path: "responses",
  tailUpdate: true,
  items: (body) => body.input as unknown[],
  validate: validateResponsesRequest, rewrite: rewriteResponsesRequest,
  updateEffort(item) {
    if (!isRecord(item) || item.type !== CONFIGURATION_UPDATE || !isRecord(item.reasoning)) return null;
    return typeof item.reasoning.effort === "string" ? item.reasoning.effort as Effort : null;
  },
  makeUpdate: (effort) => ({ type: CONFIGURATION_UPDATE, reasoning: { effort } }),
  isUserMessage: (item) => isRecord(item) && (item.type === "message" || item.type === undefined) && item.role === "user",
  isToolOutput: (item) => isRecord(item) && (item.type === "function_call_output" || item.type === "custom_tool_call_output"),
  cacheKey: (body) => typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim().length > 0 ? body.prompt_cache_key : null,
  lineageKey: (body) => typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0 ? body.prompt_cache_key : null,
  scopeParts: (body) => [body.instructions ?? null, body.tools ?? null],
  jevState: (body) => buildJevState(body.input as unknown[]),
};
