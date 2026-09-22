import { describe, expect, it } from "vitest";

import {
  rewriteResponsesRequest,
  UnsupportedInputError,
  type RewriteOptions,
} from "../src/rewrite.js";

const options: RewriteOptions = {
  upstreamModel: "gpt-6-astra",
  baseEffort: "medium",
  effort: "high",
};

function userMessage(text: string): Record<string, unknown> {
  return { type: "message", role: "user", content: text };
}

describe("rewriteResponsesRequest", () => {
  it("rewrites any incoming model to the pinned upstream model", () => {
    for (const model of ["gpt-5.1", "claude-sonnet-4", undefined]) {
      const result = rewriteResponsesRequest(
        { model, input: [userMessage("hi")] },
        options,
      );
      expect(result.model).toBe("gpt-6-astra");
    }
  });

  it("keeps the top-level reasoning effort constant across selections", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const result = rewriteResponsesRequest(
        { input: [userMessage("hi")] },
        { ...options, effort },
      );
      expect(result.reasoning).toEqual({ effort: "medium" });
    }
  });

  it("appends exactly one configuration update with the selected effort", () => {
    const result = rewriteResponsesRequest(
      { input: [userMessage("hi")] },
      options,
    );
    const input = result.input as Record<string, unknown>[];
    const updates = input.filter(
      (item) => item.type === "configuration_update",
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      type: "configuration_update",
      reasoning: { effort: "high" },
    });
    expect(input.at(-1)).toBe(updates[0]);
  });

  it("removes an incoming reasoning update before appending the current one", () => {
    const result = rewriteResponsesRequest(
      {
        input: [
          userMessage("hi"),
          { type: "configuration_update", reasoning: { effort: "low" } },
        ],
      },
      options,
    );
    const input = result.input as Record<string, unknown>[];

    expect(input).toEqual([
      userMessage("hi"),
      { type: "configuration_update", reasoning: { effort: "high" } },
    ]);
  });

  it("yields exactly one update when several reasoning updates arrive", () => {
    const result = rewriteResponsesRequest(
      {
        input: [
          userMessage("hi"),
          { type: "configuration_update", reasoning: { effort: "low" } },
          userMessage("more"),
          { type: "configuration_update", reasoning: { effort: "max" } },
        ],
      },
      options,
    );
    const input = result.input as Record<string, unknown>[];

    expect(input).toEqual([
      userMessage("hi"),
      userMessage("more"),
      { type: "configuration_update", reasoning: { effort: "high" } },
    ]);
  });

  it("preserves unrelated input items and other configuration updates", () => {
    const tool = { type: "function_call_output", call_id: "c1", output: "ok" };
    const other = { type: "configuration_update", temperature: 0.2 };
    const result = rewriteResponsesRequest(
      { input: [userMessage("hi"), tool, other] },
      options,
    );

    expect(result.input).toEqual([
      userMessage("hi"),
      tool,
      other,
      { type: "configuration_update", reasoning: { effort: "high" } },
    ]);
  });

  it("preserves unrelated top-level fields and reasoning options", () => {
    const result = rewriteResponsesRequest(
      {
        model: "gpt-5.1",
        input: [userMessage("hi")],
        prompt_cache_key: "abc",
        stream: true,
        reasoning: { summary: "auto", effort: "low" },
      },
      options,
    );

    expect(result.prompt_cache_key).toBe("abc");
    expect(result.stream).toBe(true);
    expect(result.reasoning).toEqual({ summary: "auto", effort: "medium" });
  });

  it("rejects a non-array input with a clear error", () => {
    expect(() =>
      rewriteResponsesRequest({ input: "hello" }, options),
    ).toThrow(UnsupportedInputError);
  });

  it("rejects a non-object body", () => {
    expect(() => rewriteResponsesRequest(null, options)).toThrow(
      UnsupportedInputError,
    );
    expect(() => rewriteResponsesRequest([], options)).toThrow(
      UnsupportedInputError,
    );
  });
});
