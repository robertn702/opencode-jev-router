import { describe, it, expect } from "vitest";
import { MODELS } from "../src/models.js";
import { resolveModel } from "../src/validate.js";
import { rewriteResponsesRequest } from "../src/rewrite.js";
import { createJevClassifier } from "../src/jev.js";

describe("registered model isolation", () => {
  it("rejects absent, malformed, unknown and pro IDs", () => {
    for (const model of [undefined, null, 1, {}, "", "gpt-6-astra-pro", "custom", " gpt-6-sol"]) {
      expect(() => resolveModel({ model })).toThrow("exact registered model");
    }
  });
  it("freezes profiles and pins independent rewrites", () => {
    for (const model of MODELS) {
      expect(Object.isFrozen(model)).toBe(true);
      expect(Object.isFrozen(model.supportedEfforts)).toBe(true);
      const items = [{ role: "user", content: "test" }, { type: "function_call_output", call_id: "c", output: "ok" }];
      const body = { model: model.id, prompt_cache_key: "unchanged", input: [items[0], { type: "configuration_update", reasoning: { effort: "low" } }, items[1]] };
      const result = rewriteResponsesRequest(body, { model, baseEffort: "medium", effort: "high" });
      expect(result).toMatchObject({ model: model.id, prompt_cache_key: "unchanged", reasoning: { effort: "medium" }, input: [...items, { type: "configuration_update", reasoning: { effort: "high" } }] });
    }
  });
  it("uses model-specific choices and globally bounded model-local fallback history", async () => {
    let answer = "high";
    const requests: any[] = [];
    const classifier = createJevClassifier({ apiKey: "test", timeoutMs: 1000, cacheEntries: 2,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ model: "jev-latest", answers: { effort: { type: "choice", choice: answer, confidence: 1, probabilities: {} } }, usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });
      } });
    const run = (index: number, key: unknown = "shared") => classifier.select({ model: MODELS[index]!, body: { prompt_cache_key: key, input: [] }, signal: new AbortController().signal });
    expect((await run(0)).effort).toBe("high");
    answer = "invalid";
    expect((await run(1)).effort).toBe("medium");
    expect((await run(0)).effort).toBe("high");
    answer = "none";
    expect((await run(1)).effort).toBe("none");
    expect((await run(0)).fallback).toBe("jev_invalid_output");
    expect(JSON.stringify(requests[0])).not.toContain('"none"');
    expect(JSON.stringify(requests[1])).toContain('"none"');
    expect(JSON.stringify(requests[1])).toContain("gpt-6-luna");
    answer = "max";
    await run(2);
    answer = "invalid";
    expect((await run(1)).effort).toBe("medium");
    expect((await run(0)).effort).toBe("high");
    expect((await classifier.select({ model: MODELS[0]!, body: { input: [] }, signal: new AbortController().signal })).effort).toBe("medium");
    expect((await run(0, "")).effort).toBe("medium");
  });
});
