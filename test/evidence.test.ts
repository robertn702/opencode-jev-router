import { describe, expect, it } from "vitest";
import { buildEvidence, formatDecisionEvent, formatEvidence } from "../src/evidence.js";

describe("local decision telemetry", () => {
  it("records only bounded metadata, not arbitrary request fields", () => {
    const evidence = buildEvidence({
      requestId: "test-id",
      session: "ses_abc123",
      turnId: "57e52d14-5cfa-4db3-a35a-48e9fcb9567d",
      outboundModel: "gpt-6-astra",
      outboundEffort: "high",
      jevLatencyMs: 23,
      fallback: null,
      outcome: "completed",
    });
    const event = JSON.parse(formatDecisionEvent(
      { ...evidence, prompt: "secret", authorization: "Bearer secret" } as typeof evidence,
      new Date("2026-09-23T00:00:00Z"),
    ));
    expect(event).toEqual({
      ts: "2026-09-23T00:00:00.000Z",
      event: "JevDecision",
      request_id: "test-id",
      session: "ses_abc123",
      turn_id: "57e52d14-5cfa-4db3-a35a-48e9fcb9567d",
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      previous_effort: null,
      lineage_status: null,
      history_updates_replayed: 0,
      model: "gpt-6-astra",
      effort: "high",
      jev_latency_ms: 23,
      fallback: null,
      jev_error_category: null,
      outcome: "completed",
    });
  });

  it("allows only fixed Jev error categories", () => {
    const base = {
      requestId: "test-id", outboundModel: "gpt-6-sol", outboundEffort: "medium",
      jevLatencyMs: 12, fallback: "jev_error", outcome: "completed",
    };
    expect(buildEvidence({ ...base, jevErrorCategory: "http_5xx" }).jev_error_category).toBe("http_5xx");
    expect(buildEvidence({ ...base, jevErrorCategory: "secret from server" }).jev_error_category).toBeNull();
    expect(buildEvidence({ ...base, fallback: null, jevErrorCategory: "http_5xx" }).jev_error_category).toBeNull();
  });

  it("adds Anthropic cache creation usage only when supplied", () => {
    const base = {
      requestId: "test-id", outboundModel: "claude-opus-5-5", outboundEffort: "medium",
      jevLatencyMs: 1, fallback: null, outcome: "completed",
    };
    const openai = buildEvidence({ ...base, usage: { input_tokens: 4, cached_input_tokens: null, output_tokens: 2 } });
    expect(formatEvidence(openai)).not.toContain("cache_creation_input_tokens");
    expect(formatDecisionEvent(openai)).not.toContain("cache_creation_input_tokens");
    const anthropic = buildEvidence({ ...base, usage: { input_tokens: 4, cached_input_tokens: null, output_tokens: 2, cache_creation_input_tokens: null } });
    expect(JSON.parse(formatEvidence(anthropic)).cache_creation_input_tokens).toBeNull();
    expect(JSON.parse(formatDecisionEvent(anthropic)).cache_creation_input_tokens).toBeNull();
    const created = buildEvidence({ ...base, usage: { input_tokens: 4, cached_input_tokens: null, output_tokens: 2, cache_creation_input_tokens: 3 } });
    expect(JSON.parse(formatDecisionEvent(created)).cache_creation_input_tokens).toBe(3);
  });
});
