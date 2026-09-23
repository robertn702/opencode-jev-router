const FALLBACK_CODES = new Set([
  "jev_timeout",
  "jev_error",
  "jev_invalid_output",
]);

const OUTCOMES = new Set(["completed", "failed", "request_too_large", "overloaded", "upstream_timeout"]);

export interface Evidence {
  request_id: string;
  model: string;
  effort: string;
  jev_latency_ms: number;
  fallback: string | null;
  outcome: string;
}

export function buildEvidence(parts: {
  requestId: string;
  outboundModel: unknown;
  outboundEffort: unknown;
  jevLatencyMs: number;
  fallback: string | null;
  outcome: string;
}): Evidence {
  const fallback =
    typeof parts.fallback === "string" && FALLBACK_CODES.has(parts.fallback)
      ? parts.fallback
      : null;
  const outcome = OUTCOMES.has(parts.outcome) ? parts.outcome : "failed";

  return {
    request_id: parts.requestId,
    model: typeof parts.outboundModel === "string" ? parts.outboundModel : "",
    effort: typeof parts.outboundEffort === "string" ? parts.outboundEffort : "",
    jev_latency_ms: Number.isFinite(parts.jevLatencyMs)
      ? Math.max(0, Math.round(parts.jevLatencyMs))
      : 0,
    fallback,
    outcome,
  };
}

export function formatEvidence(evidence: Evidence): string {
  return JSON.stringify(evidence);
}
