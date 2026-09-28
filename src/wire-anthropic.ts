import { supportsEffort, type Effort, type ModelProfile } from "./models.js";
import { excerpt } from "./wire-openai.js";
import { isRecord, UnsupportedInputError, type RewriteOptions, type WireAdapter } from "./wire.js";
import type { JevState } from "./jev.js";

export const ANTHROPIC_EFFORT_BETA = "mid-conversation-output-config-2026-07-01";
export const ANTHROPIC_VERSION = "2023-06-01";

export function anthropicVersion(value: string | null | undefined): string {
  return value?.trim() || ANTHROPIC_VERSION;
}

export function mergeAnthropicBeta(value: string | null | undefined): string {
  return [...new Set([...(value ?? "").split(",").map((part) => part.trim()).filter(Boolean), ANTHROPIC_EFFORT_BETA])].join(",");
}

function updateEffort(item: unknown): Effort | null {
  if (!isRecord(item) || item.role !== "system" || !isRecord(item.output_config) || !Array.isArray(item.content) || item.content.length !== 0 ||
    Object.keys(item).length !== 3 || Object.keys(item.output_config).length !== 1 || typeof item.output_config.effort !== "string") return null;
  return item.output_config.effort as Effort;
}

export function validateAnthropicRequest(body: unknown, model: ModelProfile): Record<string, unknown> {
  if (!isRecord(body)) throw new UnsupportedInputError("request body must be a JSON object");
  if (body.model !== model.id) throw new UnsupportedInputError("request.model does not match the resolved model");
  if (!Array.isArray(body.messages)) throw new UnsupportedInputError("request.messages must be an array");
  if (body.output_config !== undefined && !isRecord(body.output_config)) throw new UnsupportedInputError("request.output_config must be a JSON object");
  body.messages.forEach((item, index) => {
    if (!isRecord(item) || (item.role !== "user" && item.role !== "assistant" && item.role !== "system")) {
      throw new UnsupportedInputError(`request.messages[${index}] must be a user, assistant, or system message`);
    }
    if (item.role === "system" && ("output_config" in item) && !supportsEffort(model, updateEffort(item))) {
      throw new UnsupportedInputError(`request.messages[${index}] system output_config must contain only an effort valid for request.model`);
    }
  });
  return body;
}

export function rewriteAnthropicRequest(body: unknown, options: RewriteOptions): Record<string, unknown> {
  const record = validateAnthropicRequest(body, options.model);
  if (!options.model.supportsConfigurationUpdate || !supportsEffort(options.model, options.baseEffort) || !supportsEffort(options.model, options.effort)) {
    throw new UnsupportedInputError("unsupported reasoning effort or configuration update");
  }
  const input = record.messages as unknown[];
  let user = -1;
  for (let index = 0; index < input.length; index++) if (anthropicWire.isUserMessage(input[index])) user = index;
  const messages = options.replayedInput ?? (user < 0 ? input :
    [...input.slice(0, user), anthropicWire.makeUpdate(options.effort), ...input.slice(user)]);
  const thinking = isRecord(record.thinking) && typeof record.thinking.display === "string" ? { type: "adaptive", display: record.thinking.display } : { type: "adaptive" };
  return { ...record, model: options.model.id, output_config: { ...(isRecord(record.output_config) ? record.output_config : {}), effort: options.baseEffort }, thinking, messages };
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => (block as Record<string, unknown>).text as string).join("\n");
}

export function buildAnthropicJevState(messages: unknown[]): JevState {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") names.set(block.id, block.name);
    }
  }
  let recentUserText = "";
  let assistantProgress = "";
  const toolResults: JevState["tool_results"] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const messageText = text(message.content);
    if (message.role === "user" && messageText.length > 0) recentUserText = excerpt(messageText, 2000);
    if (message.role === "assistant" && messageText.length > 0) assistantProgress = excerpt(messageText, 2000);
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      toolResults.push({ name: typeof block.tool_use_id === "string" ? names.get(block.tool_use_id) ?? "unknown" : "unknown",
        ok: block.is_error !== true, excerpt: excerpt(text(block.content)) });
      if (toolResults.length > 8) toolResults.shift();
    }
  }
  const failures = toolResults.filter((result) => !result.ok);
  return { recent_user_text: recentUserText, assistant_progress: assistantProgress, tool_results: toolResults,
    failure_state: { failed_count: failures.length, last_failure_excerpt: failures.at(-1)?.excerpt ?? "" } };
}

export const anthropicWire: WireAdapter = {
  provider: "anthropic", path: "messages",
  tailUpdate: false,
  items: (body) => body.messages as unknown[],
  validate: validateAnthropicRequest, rewrite: rewriteAnthropicRequest,
  updateEffort,
  makeUpdate: (effort) => ({ role: "system", content: [], output_config: { effort } }),
  isUserMessage: (item) => isRecord(item) && item.role === "user",
  isToolOutput: () => false,
  cacheKey: () => null,
  lineageKey: () => null,
  scopeParts: (body) => [body.system ?? null, body.tools ?? null, body.tool_choice ?? null, body.speed ?? null,
    isRecord(body.thinking) && typeof body.thinking.display === "string" ? body.thinking.display : null,
    isRecord(body.output_config) && Object.keys(body.output_config).some((key) => key !== "effort")
      ? Object.fromEntries(Object.entries(body.output_config).filter(([key]) => key !== "effort")) : null,
    body.mcp_servers ?? null],
  jevState: (body) => buildAnthropicJevState(body.messages as unknown[]),
};
