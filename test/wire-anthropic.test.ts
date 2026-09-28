import { describe, expect, it } from "vitest";
import { findModel } from "../src/models.js";
import { LineageStore } from "../src/lineage.js";
import { ResponsesRouter } from "../src/router.js";
import { UnsupportedInputError, validateRequest, wireFor } from "../src/wire.js";
import { ANTHROPIC_EFFORT_BETA, ANTHROPIC_VERSION, anthropicVersion, anthropicWire, buildAnthropicJevState, mergeAnthropicBeta, rewriteAnthropicRequest } from "../src/wire-anthropic.js";

const model = findModel("claude-fable-5-1")!;
const user = (content: unknown) => ({ role: "user", content });
const assistant = (content: unknown) => ({ role: "assistant", content });
const update = (effort: string) => ({ role: "system", content: [], output_config: { effort } });
const body = (messages: unknown[] = [user("hi")]) => ({ model: model.id, max_tokens: 1024, messages });
const options = { model, baseEffort: "high" as const, effort: "low" as const };
const scope = ["anthropic", "session"];

describe("Anthropic Messages wire", () => {
  it("validates request shapes and caller updates before selection", () => {
    expect(validateRequest(body([user("hi"), assistant([{ type: "thinking", thinking: "private" }]), update("max")]), model, "anthropic")).toBeTruthy();
    expect(validateRequest(body([{ role: "system", content: "system text" }, user("hi")]), model)).toBeTruthy();
    for (const invalid of [null, [], body() && { ...body(), model: "claude-opus-5" }, { ...body(), messages: null },
      body([null]), body([{ role: "developer", content: "hi" }]),
      body([update("none")]), body([{ ...update("low"), extra: 1 }]),
      body([{ role: "system", content: "text", output_config: { effort: "low" } }]),
      body([{ role: "system", content: [], output_config: { effort: "low", extra: 1 } }]),
      { ...body(), output_config: null }, { ...body(), output_config: [] }]) {
      expect(() => validateRequest(invalid, model)).toThrow(UnsupportedInputError);
    }
    expect(() => rewriteAnthropicRequest(body(), { ...options, effort: "none" })).toThrow(UnsupportedInputError);
    expect(() => rewriteAnthropicRequest(body(), { ...options, baseEffort: "none" })).toThrow(UnsupportedInputError);
  });

  it("pins model, base effort and adaptive thinking without changing other fields", () => {
    const messages = [user([{ type: "text", text: "hi" }]), assistant([{ type: "thinking", thinking: "secret" }])];
    const request = { ...body(messages), output_config: { format: { type: "json_schema" }, effort: "max" },
      thinking: { type: "enabled", budget_tokens: 8192, display: "omitted" } };
    const result = rewriteAnthropicRequest(request, options);
    expect(result).toMatchObject({ model: model.id, max_tokens: 1024, output_config: { format: { type: "json_schema" }, effort: "high" },
      thinking: { type: "adaptive", display: "omitted" }, messages: [update("low"), ...messages] });
    expect(result.thinking).not.toHaveProperty("budget_tokens");
    expect(request.thinking.budget_tokens).toBe(8192);
    expect(rewriteAnthropicRequest({ ...body(), thinking: { type: "disabled", display: 123 } }, options).thinking).toEqual({ type: "adaptive" });
    expect(anthropicWire.scopeParts({ system: "rules", tools: [], tool_choice: "auto", speed: "fast", thinking: { display: "omitted" } }))
      .toEqual(["rules", [], "auto", "fast", "omitted", null, null]);
    expect(anthropicWire.scopeParts({ output_config: { effort: "max", format: { type: "json" } }, mcp_servers: [{ name: "server" }] }))
      .toEqual([null, null, null, null, null, { format: { type: "json" } }, [{ name: "server" }]]);
    expect(anthropicWire.scopeParts({ output_config: { effort: "low" } })[5]).toBeNull();
    expect(anthropicWire.cacheKey(body())).toBeNull();
    expect(anthropicWire.lineageKey(body())).toBeNull();
    expect(anthropicWire.path).toBe("messages");
    expect(wireFor("openai").scopeParts({ instructions: "a", tools: [] })).toEqual(["a", []]);
  });

  it("inserts at new user turns including tool results, and replays absent historical updates", () => {
    const store = new LineageStore();
    const firstInput = [user("one")];
    const first = store.prepare(firstInput, scope, "low", anthropicWire);
    expect(first.input).toEqual([update("low"), user("one")]);
    first.commit();
    const secondInput = [...firstInput, assistant("done"), user("two")];
    const second = store.prepare(secondInput, scope, "high", anthropicWire);
    expect(second.input).toEqual([update("low"), user("one"), assistant("done"), update("high"), user("two")]);
    expect(second.replayed).toBe(1);
    second.commit();
    const retry = store.prepare(secondInput, scope, "high", anthropicWire);
    expect(retry.input).toEqual(second.input);
    retry.discard();
    const tool = user([{ type: "tool_result", tool_use_id: "t", content: "done" }]);
    const next = store.prepare([...secondInput, assistant([{ type: "tool_use", id: "t", name: "read" }]), tool], scope, "max", anthropicWire);
    expect(next.input.at(-2)).toEqual(update("max"));
    expect(next.input.at(-1)).toEqual(tool);
  });

  it("honors caller updates and refuses conflicting updates at the selected boundary", () => {
    const store = new LineageStore();
    const supplied = store.prepare([update("low"), user("one")], scope, "low", anthropicWire);
    expect(supplied.input).toEqual([update("low"), user("one")]);
    expect(supplied.unsafe).toBe(false);
    supplied.commit();
    const followup = store.prepare([update("low"), user("one"), assistant("done"), update("high"), user("two")], scope, "high", anthropicWire);
    expect(followup.input).toEqual([update("low"), user("one"), assistant("done"), update("high"), user("two")]);
    expect(followup.unsafe).toBe(false);
    followup.discard();
    const conflict = store.prepare([update("low"), user("one"), assistant("done"), update("medium"), user("two")], scope, "high", anthropicWire);
    expect(conflict.unsafe).toBe(true);
    expect(conflict.input.filter((item) => anthropicWire.updateEffort(item) !== null)).toHaveLength(2);
  });

  it("extracts only message text and tool results, never thinking or tool inputs", () => {
    const state = buildAnthropicJevState([
      user("question"),
      assistant([{ type: "thinking", thinking: "private reasoning" }, { type: "redacted_thinking", data: "private data" },
        { type: "text", text: "working" }, { type: "tool_use", id: "t", name: "read", input: { secret: "private input" } }]),
      user([{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "failed" }, { type: "image", text: "private image" }], is_error: true }]),
      user([{ type: "text", text: "try again" }, { type: "tool_result", tool_use_id: "missing", content: "ok" }]),
    ]);
    expect(state).toEqual({ recent_user_text: "try again", assistant_progress: "working",
      tool_results: [{ name: "read", ok: false, excerpt: "failed" }, { name: "unknown", ok: true, excerpt: "ok" }],
      failure_state: { failed_count: 1, last_failure_excerpt: "failed" } });
    for (const secret of ["private reasoning", "private data", "private input", "private image"]) expect(JSON.stringify(state)).not.toContain(secret);
    expect(anthropicWire.jevState(body([user("string content")])).recent_user_text).toBe("string content");
    expect(buildAnthropicJevState([user("x".repeat(4000)), assistant("a".repeat(4000)),
      ...Array.from({ length: 10 }, (_, id) => user([{ type: "tool_result", tool_use_id: String(id), content: "o".repeat(4000) }]))])
      .tool_results).toHaveLength(8);
  });

  it("merges beta tokens idempotently", () => {
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
    expect(mergeAnthropicBeta(null)).toBe(ANTHROPIC_EFFORT_BETA);
    expect(mergeAnthropicBeta(undefined)).toBe(ANTHROPIC_EFFORT_BETA);
    expect(mergeAnthropicBeta(" old , , new,old ")).toBe(`old,new,${ANTHROPIC_EFFORT_BETA}`);
    expect(mergeAnthropicBeta(` old , ${ANTHROPIC_EFFORT_BETA}, old, ${ANTHROPIC_EFFORT_BETA} `)).toBe(`old,${ANTHROPIC_EFFORT_BETA}`);
    expect(anthropicVersion(" \t ")).toBe(ANTHROPIC_VERSION);
    expect(anthropicVersion(" 2024-01-01 ")).toBe("2024-01-01");
  });

  it("rejects route mismatch before selection and rewrites Anthropic requests end to end", async () => {
    const args: unknown[] = [];
    const router = new ResponsesRouter({ selectEffort: async (value) => {
      args.push(value);
      return { effort: "low", jevLatencyMs: 1, fallback: null };
    } });
    const request = { signal: new AbortController().signal, scope, provider: "anthropic" as const, session: "session-1" };
    await expect(router.prepare(body(), { ...request, provider: "openai" })).rejects.toThrow(UnsupportedInputError);
    await expect(router.prepare({ model: "gpt-6-sol", input: [user("hi")] }, request)).rejects.toThrow(UnsupportedInputError);
    expect(args).toHaveLength(0);
    const result = await router.prepare(body(), request);
    expect(result?.body).toMatchObject({ model: model.id, thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: [update("low"), user("hi")] });
    expect(args[0]).toMatchObject({ cacheKey: "session-1", model });
    result?.finish("completed", 200, true);
    expect((await router.prepare(body(), request))?.body.messages).toEqual([update("low"), user("hi")]);
    expect(wireFor("openai").cacheKey({ prompt_cache_key: " cache " })).toBe(" cache ");
  });

  it("preserves the entire outbound prefix across un-echoed turns, tool results and retries", async () => {
    const efforts = ["low", "medium", "high", "max", "max"] as const;
    const records: Record<string, unknown>[] = [];
    const router = new ResponsesRouter({ selectEffort: async () => ({ effort: efforts[records.length]!, jevLatencyMs: 0, fallback: null }),
      onEvidence: (item) => records.push({ ...item }) });
    const request = { signal: new AbortController().signal, scope, provider: "anthropic" as const };
    const inputs = [
      [user("one")],
      [user("one"), assistant("a"), user("two")],
      [user("one"), assistant("a"), user("two"), assistant("b"), user("three")],
      [user("one"), assistant("a"), user("two"), assistant("b"), user("three"), assistant([{ type: "tool_use", id: "t", name: "read" }]), user([{ type: "tool_result", tool_use_id: "t", content: "ok" }])],
    ];
    const outbound: unknown[][] = [];
    for (const messages of [...inputs, inputs.at(-1)!]) {
      const prepared = (await router.prepare(body(messages), request))!;
      const sent = prepared.body.messages as unknown[];
      if (outbound.length) expect(sent.slice(0, outbound.at(-1)!.length)).toEqual(outbound.at(-1));
      outbound.push(sent);
      prepared.finish("completed", 200, true);
    }
    expect(JSON.stringify(outbound.at(-1))).toBe(JSON.stringify(outbound.at(-2)));
    expect(outbound[3]!.at(-2)).toEqual(update("max"));
    expect(records.slice(1).map((record) => record.lineage_status)).toEqual(["preserved", "preserved", "preserved", "preserved"]);
  });

  it("does not apply a new effort to an assistant prefill without a new user", async () => {
    const records: Record<string, unknown>[] = [];
    let calls = 0;
    const router = new ResponsesRouter({ selectEffort: async () => ({ effort: calls++ ? "high" : "low", jevLatencyMs: 0, fallback: null }),
      onEvidence: (item) => records.push({ ...item }) });
    const request = { signal: new AbortController().signal, scope, provider: "anthropic" as const };
    const first = (await router.prepare(body([user("one")]), request))!;
    first.finish("completed", 200, true);
    const messages = [user("one"), assistant("partial")];
    const prefill = (await router.prepare(body(messages), request))!;
    expect(prefill.body.messages).toEqual([update("low"), ...messages]);
    prefill.finish("completed", 200, true);
    expect(records[1]).toMatchObject({ effort: "high", effort_applied: false, lineage_status: "preserved" });
    expect(rewriteAnthropicRequest(body([assistant("partial")]), options).messages).toEqual([assistant("partial")]);
    expect(rewriteAnthropicRequest(body([user("one"), assistant("a"), user("two"), assistant("partial")]), options).messages)
      .toEqual([user("one"), assistant("a"), update("low"), user("two"), assistant("partial")]);
  });
});
