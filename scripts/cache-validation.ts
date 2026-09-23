/**
 * Metadata-only prompt-cache comparison.  It intentionally defaults to a local
 * fake upstream; set CACHE_LIVE=1 only after reviewing docs/cache-validation.md.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { once } from "node:events";

import { loadConfig } from "../src/config.js";
import { createAppServer, type EffortDecision } from "../src/server.js";

try {
  process.loadEnvFile(".env");
} catch {
  // Ambient environment is also supported; no configuration value is printed.
}

type Effort = "low" | "high";
type Arm = "fixed" | "adaptive";
type Captured = { input: unknown[]; status: number; usage: Usage | null };
type Usage = { input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null };
type CacheRecord = {
  arm: Arm;
  trial: number;
  step: number;
  status: number;
  effort: Effort | null;
  request_id: string | null;
  session: string | null;
  turn_id: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  previous_effort: string | null;
  lineage_status: string | null;
  history_updates_replayed: number | null;
  fallback: string | null;
  outcome: string | null;
  update_positions: number[];
  expected_update_efforts: Effort[];
  effective_update_efforts: string[];
  warm_exact_request_eligible: boolean;
  prefix_fully_stable: boolean | null;
  reusable_prefix_items: number;
  reusable_prefix_bytes: number;
};

const LIVE = process.env.CACHE_LIVE === "1";
const trials = bounded("CACHE_TRIALS", 2, 1, 3);
const maxRequests = bounded("CACHE_MAX_REQUESTS", 48, 23, 60);
const resultsPath = process.env.CACHE_RESULTS_PATH;
if (resultsPath && !isAbsolute(resultsPath)) throw new Error("CACHE_RESULTS_PATH must be an absolute path");

function bounded(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function stableText(label: string): string {
  // Long enough to be cache-eligible without making the run unbounded. This is
  // never emitted or written; only its structural measurements are retained.
  return `${label}: ${"stable cache comparison context ".repeat(700)}`;
}

function userItem(step: number): globalThis.Record<string, unknown> {
  return { role: "user", content: `Return exactly OK. Step ${step}.` };
}

function requestBody(history: unknown[], cacheKey: string, step: number | null, requireTool = false): globalThis.Record<string, unknown> {
  // The current user item is deliberately appended for every request. Previous
  // assistant/tool items originate in the immediately preceding upstream reply.
  const input = step === null ? history : [...history, userItem(step)];
  return {
    model: "gpt-6-astra",
    reasoning: { effort: "medium", mode: "standard" },
    instructions: stableText("top-level instructions"),
    tools: [{ type: "function", name: "stable_lookup", description: "Stable validation tool.", parameters: { type: "object", properties: {} } }],
    ...(requireTool ? { tool_choice: { type: "function", name: "stable_lookup" } } : {}),
    prompt_cache_key: cacheKey,
    input,
  };
}

function outputItems(value: unknown): unknown[] {
  return typeof value === "object" && value !== null && Array.isArray((value as { output?: unknown }).output)
    ? (value as { output: unknown[] }).output
    : [];
}

function toolOutputs(output: unknown[]): unknown[] {
  return output.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const call = item as { type?: unknown; call_id?: unknown };
    return call.type === "function_call" && typeof call.call_id === "string"
      ? [{ type: "function_call_output", call_id: call.call_id, output: "stable_lookup_result" }]
      : [];
  });
}

function updatePositions(input: unknown[]): number[] {
  return input.flatMap((item, index) => (
    typeof item === "object" && item !== null && (item as { type?: unknown }).type === "configuration_update" ? [index] : []
  ));
}

function updateEfforts(input: unknown[]): string[] {
  return input.flatMap((item) => {
    if (typeof item !== "object" || item === null || (item as { type?: unknown }).type !== "configuration_update") return [];
    const effort = (item as { reasoning?: { effort?: unknown } }).reasoning?.effort;
    return typeof effort === "string" ? [effort] : [];
  });
}

function expectedTransitions(sequence: Effort[], step: number): Effort[] {
  return sequence.slice(0, step + 1).filter((effort, index, selected) => index === 0 || effort !== selected[index - 1]);
}

function updatesArePlaced(input: unknown[], expected: Effort[]): boolean {
  const positions = updatePositions(input);
  const actual = updateEfforts(input);
  return JSON.stringify(actual) === JSON.stringify(expected) && positions.every((position) => {
    const next = input[position + 1];
    return next !== undefined && typeof next === "object" && next !== null &&
      (next as { role?: unknown }).role === "user" &&
      !(typeof input[position + 1] === "object" && input[position + 1] !== null &&
        (input[position + 1] as { type?: unknown }).type === "configuration_update");
  });
}

function reusablePrefix(previous: unknown[] | undefined, current: unknown[]): { items: number; bytes: number } {
  if (!previous) return { items: 0, bytes: 0 };
  let items = 0;
  let bytes = 0;
  while (items < previous.length && items < current.length) {
    const prior = JSON.stringify(previous[items]);
    const next = JSON.stringify(current[items]);
    if (prior !== next) break;
    bytes += Buffer.byteLength(next);
    items += 1;
  }
  return { items, bytes };
}

function fakeUsage(input: unknown[]): Usage {
  const bytes = Buffer.byteLength(JSON.stringify(input));
  const tokens = Math.ceil(bytes / 4);
  return { input_tokens: tokens, cached_input_tokens: Math.floor(tokens * 0.8), output_tokens: 1 };
}

async function readJson(request: IncomingMessage): Promise<globalThis.Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as globalThis.Record<string, unknown>;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

async function main(): Promise<void> {
  const captured: Captured[] = [];
  const evidence: globalThis.Record<string, unknown>[] = [];
  let omitNextFakeUsage = false;
  // Match the live smoke: model choice belongs to each request, not a legacy
  // singleton environment setting retained in a local .env.
  const configEnv = { ...process.env };
  const legacyUpstreamModelIgnored = configEnv.UPSTREAM_MODEL !== undefined;
  delete configEnv.UPSTREAM_MODEL;
  const actual = LIVE ? loadConfig(configEnv) : undefined;
  const upstreamTimeoutMs = bounded("CACHE_UPSTREAM_TIMEOUT_MS", 120_000, 1_000, 120_000);
  const clientAuthorization = process.env.CACHE_CLIENT_AUTHORIZATION?.trim() ||
    (process.env.CLIPROXY_KEY?.trim() ? `Bearer ${process.env.CLIPROXY_KEY.trim()}` : undefined);
  if (LIVE && !clientAuthorization) {
    throw new Error("CACHE_CLIENT_AUTHORIZATION or CLIPROXY_KEY is required for a live run and is never recorded");
  }

  const relay = createServer(async (incoming, outgoing) => {
    let input: unknown[] = [];
    let capturedRequest = false;
    try {
      const body = await readJson(incoming);
      input = Array.isArray(body.input) ? body.input : [];
      if (!LIVE) {
        const usage = fakeUsage(input);
        captured.push({ input, status: 200, usage });
        capturedRequest = true;
        outgoing.writeHead(200, { "content-type": "application/json" });
        const forcedTool = typeof body.tool_choice === "object" && body.tool_choice !== null;
        outgoing.end(JSON.stringify({
          status: "completed",
          output: forcedTool
            ? [{ type: "function_call", call_id: `call_${captured.length}`, name: "stable_lookup", arguments: "{}" }]
            : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
          ...(omitNextFakeUsage ? {} : { usage: {
            input_tokens: usage.input_tokens,
            input_tokens_details: { cached_tokens: usage.cached_input_tokens },
            output_tokens: usage.output_tokens,
          } }),
        }));
        omitNextFakeUsage = false;
        return;
      }
      const target = new URL("responses", actual!.upstreamBaseUrl.endsWith("/") ? actual!.upstreamBaseUrl : `${actual!.upstreamBaseUrl}/`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
      try {
        const upstream = await fetch(target, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: actual!.upstreamAuth.policy === "bearer"
              ? `Bearer ${actual!.upstreamAuth.apiKey}`
              : incoming.headers.authorization ?? "",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        captured.push({ input, status: upstream.status, usage: null });
        capturedRequest = true;
        const headers = Object.fromEntries(["content-type", "cache-control", "retry-after", "x-request-id"].flatMap((name) => {
          const value = upstream.headers.get(name);
          return value === null ? [] : [[name, value] as const];
        }));
        outgoing.writeHead(upstream.status, headers);
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            if (!outgoing.write(chunk)) await once(outgoing, "drain");
          }
        }
        outgoing.end();
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Do not expose or retain raw upstream errors.
      if (!capturedRequest) captured.push({ input, status: 502, usage: null });
      outgoing.writeHead(502, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "upstream_unavailable" }));
    }
  });
  const relayPort = await listen(relay);
  let cursor = 0;
  let currentEffort: Effort = "low";
  const proxy = createAppServer({
    upstreamBaseUrl: `http://127.0.0.1:${relayPort}/v1`,
    upstreamAuth: { policy: "forward" },
    selectEffort: async (): Promise<EffortDecision> => ({ effort: currentEffort, jevLatencyMs: 0, fallback: null }),
    onEvidence: (item) => evidence.push(item as unknown as globalThis.Record<string, unknown>),
  });
  const proxyPort = await listen(proxy);
  const records: CacheRecord[] = [];
  const placementChecks: boolean[] = [];
  const currentUserChecks: boolean[] = [];
  const retryChecks: boolean[] = [];
  const toolRecords: { initial_status: number; continuation_status: number | null; initial_effort: Effort; continuation_effort: Effort; function_call_observed: boolean; update_positions: number[] }[] = [];
  let missingUsageIsNull: boolean | null = null;
  let requestsStarted = 0;
  const reserveRequest = (): void => {
    if (requestsStarted >= maxRequests) throw new Error("CACHE_MAX_REQUESTS exhausted");
    requestsStarted += 1;
  };
  const sequence: globalThis.Record<Arm, Effort[]> = { fixed: ["low", "low", "low", "low", "low"], adaptive: ["low", "low", "high", "high", "low"] };

  try {
    for (let trial = 0; trial < trials; trial += 1) {
      const arms: Arm[] = trial % 2 === 0 ? ["fixed", "adaptive"] : ["adaptive", "fixed"];
      for (const arm of arms) {
        const cacheKey = createHash("sha256").update(`${randomUUID()}:${trial}:${arm}`).digest("hex");
        const sessionId = `ses_${randomUUID().replaceAll("-", "")}`;
        let previous: unknown[] | undefined;
        const warmOutbound: unknown[][] = [];
        const warmHistories: unknown[][] = [];
        // A complete warm pass uses the same history shape and isolated key as measurement.
        for (const phase of ["warm", "measure"] as const) {
          let history: unknown[] = [];
          for (let step = 0; step < sequence[arm].length; step += 1) {
            if (phase === "warm") warmHistories[step] = history;
            else history = warmHistories[step] ?? [];
            reserveRequest();
            currentEffort = sequence[arm][step]!;
            const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: clientAuthorization ?? "Bearer local-cache-validation",
                "x-jev-session-id": sessionId,
                "x-jev-turn-id": randomUUID(),
              },
              body: JSON.stringify(requestBody(history, cacheKey, step + 1)),
              signal: AbortSignal.timeout(120_000),
            });
            const responseBody: unknown = await response.json();
            const output = outputItems(responseBody);
            const outbound = captured[cursor++];
            if (!outbound) throw new Error("relay did not capture the outbound request");
            if (phase === "measure") {
              const event = evidence.at(-1) ?? {};
              const prefix = reusablePrefix(previous, outbound.input);
              const warmExact = JSON.stringify(warmOutbound[step]) === JSON.stringify(outbound.input);
              records.push({
                arm, trial: trial + 1, step: step + 1, status: response.status,
                effort: typeof event.effort === "string" && (event.effort === "low" || event.effort === "high") ? event.effort : null,
                request_id: typeof event.request_id === "string" ? event.request_id : null,
                session: typeof event.session === "string" ? event.session : null,
                turn_id: typeof event.turn_id === "string" ? event.turn_id : null,
                input_tokens: typeof event.input_tokens === "number" ? event.input_tokens : null,
                cached_input_tokens: typeof event.cached_input_tokens === "number" ? event.cached_input_tokens : null,
                output_tokens: typeof event.output_tokens === "number" ? event.output_tokens : null,
                previous_effort: typeof event.previous_effort === "string" ? event.previous_effort : null,
                lineage_status: typeof event.lineage_status === "string" ? event.lineage_status : null,
                history_updates_replayed: typeof event.history_updates_replayed === "number" ? event.history_updates_replayed : null,
                fallback: typeof event.fallback === "string" ? event.fallback : null,
                outcome: typeof event.outcome === "string" ? event.outcome : null,
                update_positions: updatePositions(outbound.input),
                expected_update_efforts: expectedTransitions(sequence[arm], step),
                effective_update_efforts: updateEfforts(outbound.input),
                warm_exact_request_eligible: warmExact,
                prefix_fully_stable: previous === undefined ? null : prefix.items === previous.length,
                reusable_prefix_items: prefix.items, reusable_prefix_bytes: prefix.bytes,
              });
              placementChecks.push(updatesArePlaced(outbound.input, expectedTransitions(sequence[arm], step)));
              const last = outbound.input.at(-1);
              currentUserChecks.push(typeof last === "object" && last !== null && (last as { role?: unknown }).role === "user");
              previous = outbound.input;
            } else {
              warmOutbound[step] = outbound.input;
            }
            if (phase === "measure") retryChecks.push(JSON.stringify(warmOutbound[step]) === JSON.stringify(outbound.input));
            // Preserve warm upstream output only in memory. The measured pass
            // replays that exact history, making each request a true retry.
            if (phase === "warm") history = [...history, userItem(step + 1), ...output];
          }
        }

        // Separate from the user-followup arm: this is the actual tool-call /
        // function_call_output continuation shape, which has no new user item.
        if (trial === 0 && arm === "fixed") {
          const toolKey = createHash("sha256").update(randomUUID()).digest("hex");
          const toolSession = `ses_${randomUUID().replaceAll("-", "")}`;
          currentEffort = "low";
          reserveRequest();
          const headers = {
            "content-type": "application/json",
            authorization: clientAuthorization ?? "Bearer local-cache-validation",
            "x-jev-session-id": toolSession,
            "x-jev-turn-id": randomUUID(),
          };
          const first = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
            method: "POST", headers, body: JSON.stringify(requestBody([], toolKey, 1, true)), signal: AbortSignal.timeout(120_000),
          });
          const firstBody: unknown = await first.json();
          const firstOutput = outputItems(firstBody);
          const continuation = toolOutputs(firstOutput);
          cursor += 1; // tool-call request is metadata-free pilot setup
          let continuationStatus: number | null = null;
          let positions: number[] = [];
          if (continuation.length > 0) {
            currentEffort = "high";
            reserveRequest();
            const second = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
              method: "POST", headers: { ...headers, "x-jev-turn-id": randomUUID() },
              body: JSON.stringify(requestBody([userItem(1), ...firstOutput, ...continuation], toolKey, null)), signal: AbortSignal.timeout(120_000),
            });
            await second.arrayBuffer();
            continuationStatus = second.status;
            const toolOutbound = captured[cursor++];
            positions = toolOutbound ? updatePositions(toolOutbound.input) : [];
          }
          toolRecords.push({ initial_status: first.status, continuation_status: continuationStatus, initial_effort: "low", continuation_effort: "high", function_call_observed: continuation.length > 0, update_positions: positions });
        }
      }
    }
    if (!LIVE) {
      omitNextFakeUsage = true;
      currentEffort = "low";
      reserveRequest();
      const probe = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: clientAuthorization ?? "Bearer local-cache-validation" },
        body: JSON.stringify(requestBody([], createHash("sha256").update(randomUUID()).digest("hex"), 1)), signal: AbortSignal.timeout(120_000),
      });
      await probe.arrayBuffer();
      cursor += 1;
      const event = evidence.at(-1) ?? {};
      missingUsageIsNull = event.input_tokens === null && event.cached_input_tokens === null && event.output_tokens === null;
    }
  } finally {
    await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => relay.close(() => resolve()))]);
  }
  const summary = {
    mode: LIVE ? "live" : "fake-upstream",
    classifier: "injected_deterministic",
    deployment: "in-process_createAppServer",
    legacy_upstream_model_ignored: legacyUpstreamModelIgnored,
    trials,
    requests: records.length,
    requests_started: requestsStarted,
    records,
    // Cache bytes/items are structural eligibility measurements, not token counts.
    protocol_checks: {
      statuses_ok: records.every((record) => record.status >= 200 && record.status < 300),
      updates_before_next_user: placementChecks.every(Boolean),
      current_user_present: currentUserChecks.every(Boolean),
      tool_continuations_observed: toolRecords.every((record) => record.function_call_observed && record.continuation_status !== null && record.continuation_status >= 200 && record.continuation_status < 300),
      missing_usage_is_null: missingUsageIsNull,
      exact_retries_idempotent: retryChecks.every(Boolean),
      effective_efforts_match: records.every((record) => JSON.stringify(record.expected_update_efforts) === JSON.stringify(record.effective_update_efforts)),
    },
    comparison: Object.fromEntries((["fixed", "adaptive"] as Arm[]).map((arm) => [arm, {
      records: records.filter((record) => record.arm === arm).length,
      mean_cached_input_tokens: mean(records.filter((record) => record.arm === arm).map((record) => record.cached_input_tokens)),
      mean_cached_to_input_ratio: meanRatio(records.filter((record) => record.arm === arm)),
      mean_reusable_prefix_bytes: mean(records.filter((record) => record.arm === arm).map((record) => record.reusable_prefix_bytes)),
    }])),
    tool_continuations: toolRecords,
  };
  if (resultsPath) {
    await mkdir(dirname(resultsPath), { recursive: true, mode: 0o700 });
    await writeFile(resultsPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify(summary));
  if (!summary.protocol_checks.statuses_ok || !summary.protocol_checks.updates_before_next_user ||
      !summary.protocol_checks.current_user_present || !summary.protocol_checks.tool_continuations_observed ||
      !summary.protocol_checks.exact_retries_idempotent || !summary.protocol_checks.effective_efforts_match ||
      summary.protocol_checks.missing_usage_is_null === false) {
    process.exitCode = 1;
  }
}

function mean(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.round(present.reduce((total, value) => total + value, 0) / present.length);
}

function meanRatio(records: CacheRecord[]): number | null {
  const ratios = records.flatMap((record) => (
    record.input_tokens !== null && record.input_tokens > 0 && record.cached_input_tokens !== null
      ? [record.cached_input_tokens / record.input_tokens]
      : []
  ));
  return ratios.length === 0 ? null : Math.round((ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length) * 1_000) / 1_000;
}

void main().catch((error: unknown) => {
  // Fixed error only: do not print credentials, bodies, or upstream errors.
  console.error(JSON.stringify({ error: error instanceof Error && error.message.startsWith("CACHE_") ? error.message : "cache_validation_failed" }));
  process.exitCode = 1;
});
