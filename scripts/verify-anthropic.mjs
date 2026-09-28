// Manual, billed upstream experiment. Never invoke from CI.
const models = new Set(["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-opus-5"]);
if (process.env.VERIFY_ANTHROPIC_LIVE !== "1" || !process.env.ANTHROPIC_API_KEY) {
  console.log("Usage: VERIFY_ANTHROPIC_LIVE=1 ANTHROPIC_API_KEY=… [VERIFY_ANTHROPIC_MODEL=claude-opus-5-5] npm run verify:anthropic (billed live requests; never CI)");
  process.exit(0);
}
const model = process.env.VERIFY_ANTHROPIC_MODEL || "claude-opus-5-5";
if (!models.has(model)) throw new Error("VERIFY_ANTHROPIC_MODEL must be one of the four registered Claude models");
if (process.env.CI) throw new Error("Live Anthropic verification must not run in CI");

const baseEffort = model === "claude-opus-5-5" ? "medium" : "high";
const system = [{ type: "text", text: Array.from({ length: 480 }, (_, i) =>
  `Ledger entry ${i}: cedar amber basalt quartz harbor lantern.\n`).join("") }];
const update = (effort) => ({ role: "system", content: [], output_config: { effort } });
const user = (text) => ({ role: "user", content: text });
const first = user("Give a short acknowledgement.");
const common = { model, system, cache_control: { type: "ephemeral" }, thinking: { type: "adaptive" },
  output_config: { effort: baseEffort }, max_tokens: 128 };
let count = 0;

async function request(label, body, expected400 = false) {
  if (++count > 12) throw new Error("12-request hard budget exceeded");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01", "anthropic-beta": "mid-conversation-output-config-2026-07-01" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.log(JSON.stringify({ check: label, status: response.status, error_type: data?.error?.type ?? null }));
    if (expected400 && response.status === 400) return null;
    throw new Error(`Unexpected HTTP ${response.status} in ${label} (error.type: ${data?.error?.type ?? "unknown"})`);
  }
  console.log(JSON.stringify({ check: label, status: response.status,
    input_tokens: data.usage?.input_tokens ?? null,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? null,
    output_tokens: data.usage?.output_tokens ?? null,
    thinking_present: data.content?.some((block) => block.type === "thinking" || block.type === "redacted_thinking") ?? false }));
  return data;
}

const assistant = (data) => ({ role: "assistant", content: data.content });
function assert(condition, message) {
  console.log(JSON.stringify({ check: message, pass: Boolean(condition) }));
  if (!condition) throw new Error(message);
}

const warm = await request("warm_prefix", { ...common, messages: [first] });
const warmTokens = (warm.usage?.input_tokens ?? 0) + (warm.usage?.cache_creation_input_tokens ?? 0) +
  (warm.usage?.cache_read_input_tokens ?? 0);
assert(warmTokens >= 2000, "warm prefix >= 2000 billed input tokens");
const history = [first, assistant(warm)];
const lowMessages = [...history, update("low"), user("Acknowledge this follow-up briefly.")];
const low = await request("cached_low", { ...common, messages: lowMessages });
assert((low.usage?.cache_read_input_tokens ?? 0) >= 2000, "low reuses prior prefix");
const highMessages = [...lowMessages, assistant(low), update("high"), user("Acknowledge once more briefly.")];
const high = await request("cached_high", { ...common, messages: highMessages });
assert((high.usage?.cache_read_input_tokens ?? 0) >= 2000, "high reuses prior prefix");
const controlEffort = baseEffort === "high" ? "medium" : "high";
const control = await request("top_level_effort_control", { ...common,
  output_config: { effort: controlEffort }, messages: [...history, user("Control follow-up.")] });
assert((control.usage?.cache_read_input_tokens ?? 0) === 0, "top-level effort change misses cache");

const tool = { name: "stable_lookup", description: "Return a short acknowledgement", input_schema: {
  type: "object", properties: {}, additionalProperties: false } };
const toolStart = await request("forced_tool_use", { ...common, tools: [tool],
  tool_choice: { type: "tool", name: tool.name }, messages: [user("Call stable_lookup.")] });
const call = toolStart.content?.find((block) => block.type === "tool_use");
assert(typeof call?.id === "string", "forced tool_use observed");
const toolHistory = [user("Call stable_lookup."), assistant(toolStart)];
for (const effort of ["low", "max"]) {
  const result = await request(`tool_result_${effort}`, { ...common, tools: [tool],
    messages: [...toolHistory, update(effort), { role: "user", content: [
      { type: "tool_result", tool_use_id: call.id, content: "ok" }] }] });
  assert(result.type === "message" && result.stop_reason !== null, `tool continuation ${effort} succeeds`);
}

const replay = await request("lineage_loss_replay", { ...common,
  messages: [...history, lowMessages.at(-1), assistant(low), user("Acknowledge after the missing earlier effort update.")] }, true);
console.log(JSON.stringify({ check: "lineage loss returned 400", observed: replay === null, requests: count }));
