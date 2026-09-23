const FALLBACK_CODES = new Set([
  "jev_timeout",
  "jev_error",
  "jev_invalid_output",
]);

const OUTCOMES = new Set(["completed", "failed", "request_too_large", "overloaded", "upstream_timeout"]);
const JEV_ERROR_CATEGORIES = new Set([
  "http_auth", "http_rate_limit", "http_4xx", "http_5xx", "http_other",
  "connection", "sdk_timeout", "sdk_abort", "unknown",
]);

export interface Evidence {
  request_id: string;
  session: string | null;
  turn_id: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  previous_effort: string | null;
  lineage_status: string | null;
  history_updates_replayed: number;
  model: string;
  effort: string;
  jev_latency_ms: number;
  fallback: string | null;
  jev_error_category: string | null;
  outcome: string;
}

export function buildEvidence(parts: {
  requestId: string;
  session?: string | null;
  turnId?: string | null;
  usage?: { input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null };
  previousEffort?: string | null;
  lineageStatus?: string;
  historyUpdatesReplayed?: number;
  outboundModel: unknown;
  outboundEffort: unknown;
  jevLatencyMs: number;
  fallback: string | null;
  jevErrorCategory?: string;
  outcome: string;
}): Evidence {
  const fallback =
    typeof parts.fallback === "string" && FALLBACK_CODES.has(parts.fallback)
      ? parts.fallback
      : null;
  const outcome = OUTCOMES.has(parts.outcome) ? parts.outcome : "failed";

  return {
    request_id: parts.requestId,
    session: parts.session ?? null,
    turn_id: parts.turnId ?? null,
    input_tokens: parts.usage?.input_tokens ?? null,
    cached_input_tokens: parts.usage?.cached_input_tokens ?? null,
    output_tokens: parts.usage?.output_tokens ?? null,
    previous_effort: parts.previousEffort ?? null,
    lineage_status: parts.lineageStatus ?? null,
    history_updates_replayed: parts.historyUpdatesReplayed ?? 0,
    model: typeof parts.outboundModel === "string" ? parts.outboundModel : "",
    effort: typeof parts.outboundEffort === "string" ? parts.outboundEffort : "",
    jev_latency_ms: Number.isFinite(parts.jevLatencyMs)
      ? Math.max(0, Math.round(parts.jevLatencyMs))
      : 0,
    fallback,
    jev_error_category: fallback === "jev_error" && typeof parts.jevErrorCategory === "string" &&
      JEV_ERROR_CATEGORIES.has(parts.jevErrorCategory) ? parts.jevErrorCategory : null,
    outcome,
  };
}

export function formatEvidence(evidence: Evidence): string {
  return JSON.stringify(evidence);
}

export function formatDecisionEvent(evidence: Evidence, now = new Date()): string {
  return JSON.stringify({
    ts: now.toISOString(),
    event: "JevDecision",
    request_id: evidence.request_id,
    session: evidence.session,
    turn_id: evidence.turn_id,
    input_tokens: evidence.input_tokens,
    cached_input_tokens: evidence.cached_input_tokens,
    output_tokens: evidence.output_tokens,
    previous_effort: evidence.previous_effort,
    lineage_status: evidence.lineage_status,
    history_updates_replayed: evidence.history_updates_replayed,
    model: evidence.model,
    effort: evidence.effort,
    jev_latency_ms: evidence.jev_latency_ms,
    fallback: evidence.fallback,
    jev_error_category: evidence.jev_error_category,
    outcome: evidence.outcome,
  });
}
