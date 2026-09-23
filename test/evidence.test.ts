import { describe, expect, it } from "vitest";
import { buildEvidence, formatDecisionEvent } from "../src/evidence.js";

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
});
