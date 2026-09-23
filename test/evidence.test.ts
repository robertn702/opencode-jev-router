import { describe, expect, it } from "vitest";
import { buildEvidence, formatDecisionEvent } from "../src/evidence.js";

describe("local decision telemetry", () => {
  it("records only bounded metadata, not arbitrary request fields", () => {
    const evidence = buildEvidence({
      requestId: "test-id",
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
      model: "gpt-6-astra",
      effort: "high",
      jev_latency_ms: 23,
      fallback: null,
      outcome: "completed",
    });
  });
});
