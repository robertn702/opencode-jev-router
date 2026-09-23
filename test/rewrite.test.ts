import { describe, expect, it } from "vitest";

import {
  rewriteResponsesRequest,
  UnsupportedInputError,
  type RewriteOptions,
} from "../src/rewrite.js";

const options: RewriteOptions = {
  model: findModel("gpt-6-astra")!,
  baseEffort: "medium",
  effort: "high",
};

function userMessage(text: string): Record<string, unknown> {
  return { type: "message", role: "user", content: text };
}

describe("rewriteResponsesRequest", () => {
  it("accepts only the configured execution model", () => {
    expect(rewriteResponsesRequest({ model: "gpt-6-astra", input: [userMessage("hi")] }, options).model).toBe("gpt-6-astra");
    for (const model of ["gpt-5.1", "claude-sonnet-4", undefined]) {
      expect(() => rewriteResponsesRequest({ model, input: [userMessage("hi")] }, options)).toThrow(UnsupportedInputError);
    }
  });

  it("keeps the top-level reasoning effort constant across selections", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const result = rewriteResponsesRequest(
        { model: "gpt-6-astra", input: [userMessage("hi")] },
        { ...options, effort },
      );
      expect(result.reasoning).toEqual({ effort: "medium" });
    }
  });

  it("places a new-user update before the user message", () => {
    const result = rewriteResponsesRequest(
      { model: "gpt-6-astra", input: [userMessage("hi")] },
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
    expect(input[0]).toBe(updates[0]);
  });

  it("preserves incoming reasoning updates without moving them", () => {
    const result = rewriteResponsesRequest(
      {
        model: "gpt-6-astra",
        input: [
          userMessage("hi"),
          { type: "configuration_update", reasoning: { effort: "low" } },
        ],
      },
      options,
    );
    const input = result.input as Record<string, unknown>[];

    expect(input).toEqual([
      { type: "configuration_update", reasoning: { effort: "high" } },
      userMessage("hi"),
      { type: "configuration_update", reasoning: { effort: "low" } },
    ]);
  });

  it("preserves several historical updates", () => {
    const result = rewriteResponsesRequest(
      {
        model: "gpt-6-astra",
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
      { type: "configuration_update", reasoning: { effort: "high" } },
      userMessage("hi"),
      { type: "configuration_update", reasoning: { effort: "low" } },
      userMessage("more"),
      { type: "configuration_update", reasoning: { effort: "max" } },
    ]);
  });

  it("rejects unsupported configuration updates", () => {
    const tool = { type: "function_call_output", call_id: "c1", output: "ok" };
    const other = { type: "configuration_update", temperature: 0.2 };
    expect(() => rewriteResponsesRequest(
      { model: "gpt-6-astra", input: [userMessage("hi"), tool, other] },
      options,
    )).toThrow(UnsupportedInputError);
  });

  it("preserves unrelated top-level fields and reasoning options", () => {
    const result = rewriteResponsesRequest(
      {
        model: "gpt-6-astra",
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
import { findModel } from "../src/models.js";
