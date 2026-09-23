import { describe, expect, it } from "vitest";

import {
  UnsupportedInputError,
  validateResponsesRequest as validate,
} from "../src/validate.js";
import { findModel } from "../src/models.js";

function validateResponsesRequest(body: unknown) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (record.model === undefined) record.model = "gpt-6-astra";
  }
  return validate(body, findModel("gpt-6-astra")!);
}

describe("validateResponsesRequest", () => {
  it("accepts the array-form input OpenCode emits, including tool continuations", () => {
    const body = {
      model: "gpt-6-astra",
      stream: true,
      input: [
        { role: "developer", content: "instructions" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        {
          type: "function_call",
          call_id: "c1",
          name: "read",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        { type: "configuration_update", reasoning: { effort: "low" } },
      ],
    };
    expect(validateResponsesRequest(body)).toBe(body);
  });

  it("accepts typed message, reasoning, and custom tool items", () => {
    expect(() =>
      validateResponsesRequest({
        input: [
          { type: "message", role: "assistant", content: [] },
          { type: "reasoning", id: "r1", summary: [] },
          { type: "custom_tool_call", call_id: "c1", name: "t", input: "{}" },
          {
            type: "custom_tool_call_output",
            call_id: "c1",
            output: "ok",
          },
          { type: "item_reference", id: "i1" },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts an omitted reasoning object and a standard mode", () => {
    expect(() =>
      validateResponsesRequest({ input: [{ role: "user", content: "x" }] }),
    ).not.toThrow();
    expect(() =>
      validateResponsesRequest({
        reasoning: { mode: "standard", effort: "low" },
        input: [{ role: "user", content: "x" }],
      }),
    ).not.toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => validateResponsesRequest(null)).toThrow(UnsupportedInputError);
    expect(() => validateResponsesRequest([])).toThrow(UnsupportedInputError);
    expect(() => validateResponsesRequest("hi")).toThrow(UnsupportedInputError);
  });

  it("rejects a non-array input, including string input", () => {
    expect(() => validateResponsesRequest({ input: "hello" })).toThrow(
      UnsupportedInputError,
    );
    expect(() => validateResponsesRequest({})).toThrow(UnsupportedInputError);
  });

  it("rejects non-object input items", () => {
    expect(() =>
      validateResponsesRequest({ input: [{ role: "user", content: "x" }, "str"] }),
    ).toThrow(UnsupportedInputError);
  });

  it("rejects unsupported item types", () => {
    expect(() =>
      validateResponsesRequest({ input: [{ type: "mystery_item" }] }),
    ).toThrow(UnsupportedInputError);
  });

  it("rejects message items with unsupported roles", () => {
    expect(() =>
      validateResponsesRequest({ input: [{ role: "tool", content: "x" }] }),
    ).toThrow(UnsupportedInputError);
    expect(() =>
      validateResponsesRequest({
        input: [{ type: "message", role: "narrator", content: [] }],
      }),
    ).toThrow(UnsupportedInputError);
  });

  it("rejects pro and multi-agent reasoning modes before anything else", () => {
    for (const mode of ["pro", "multi-agent", "multi_agent", "tournament"]) {
      expect(() =>
        validateResponsesRequest({
          reasoning: { mode },
          input: [{ role: "user", content: "x" }],
        }),
      ).toThrow(UnsupportedInputError);
    }
  });

  it("rejects pro model slugs", () => {
    for (const model of ["gpt-6-astra-pro", "openai/gpt-6-astra-pro"]) {
      expect(() =>
        validateResponsesRequest({
          model,
          input: [{ role: "user", content: "x" }],
        }),
      ).toThrow(UnsupportedInputError);
    }
  });

  it("rejects automatic truncation, which is incompatible with updates", () => {
    expect(() =>
      validateResponsesRequest({
        truncation: "auto",
        input: [{ role: "user", content: "x" }],
      }),
    ).toThrow(UnsupportedInputError);
  });

  it("rejects a non-object reasoning value", () => {
    expect(() =>
      validateResponsesRequest({
        reasoning: "low",
        input: [{ role: "user", content: "x" }],
      }),
    ).toThrow(UnsupportedInputError);
  });
});
