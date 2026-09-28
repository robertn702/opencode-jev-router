# Router behavior

Reference for the wire behavior shared by the OpenCode plugin and the standalone proxy. Start with the [README](../README.md) for setup.

## Scope

- GPT-6 **standard, single-agent mode only** on `/v1/responses`. Requests
  with `reasoning.mode` other than `standard` (pro, multi-agent, etc.), pro model
  slugs, a missing or mismatched `model`, or `truncation: "auto"` are rejected with a local `400` before
  classification or generation. OpenCode reasoning-effort variants are ignored
  for this provider.
- Array-form Responses `input` as emitted by OpenCode is supported, including tool
  continuations (`function_call` / `function_call_output`, `custom_tool_call` /
  `custom_tool_call_output`). Untyped messages require a supported role (`user`,
  `assistant`, `system`, `developer`); typed messages also require one of these
  roles. Non-message typed JSON objects with a non-empty string `type` pass through
  unchanged: known examples include `reasoning`, `item_reference`, computer-use
  call/output, hosted-tool calls (such as web/file search), and future item types.
  Their nested content, metadata, and relative order are preserved; the selected
  upstream remains responsible for accepting their individual schemas, enabled
  tools, model capabilities, and reference IDs. This is a pass-through contract,
  not a claim that every type is executable on every configured upstream.
  String input, non-object items, missing/invalid typed discriminators, and
  unsupported message roles receive a local `400`.
- Anthropic requires array-form `messages` with user, assistant, or system
  roles. Text, thinking, `tool_use`, and `tool_result` content passes through;
  malformed effort-only system updates fail locally before Jev or upstream.
- `configuration_update` is intentionally *not* opaque: only a model-valid
  `reasoning.effort` update with no extra fields is accepted. `reasoning.mode`
  must be `standard` if set; `truncation` must be `disabled` if set (`auto` can
  drop injected history). Conflicting caller updates at an insertion boundary
  receive a local `400`. No item fields are silently stripped to make these
  combinations work.
- Exact registered OpenAI IDs are `gpt-6-astra`, `gpt-6-luna`, and `gpt-6-sol`;
  Anthropic `/v1/messages` accepts `claude-fable-5-1`, `claude-mythos-5-1`,
  `claude-opus-5-5`, and `claude-opus-5` only. Model/route mismatches are local `400`s.
  Missing, malformed, unknown, and pro IDs fail locally before classification.
  All registered models are available without model environment settings.
  `UPSTREAM_MODEL`, `UPSTREAM_MODELS`, and `ALLOWED_MODELS` are rejected at startup
  with value-free diagnostics directing selection through `request.model`.
  There are no aliases or custom-model overrides. Upstream entitlement is separate.
- `/v1/models` remains authenticated upstream passthrough: its inventory is not
  the router capability registry. Independent same-model tool continuations are
  supported; arbitrary cross-model encrypted reasoning or response-ID replay is
  not guaranteed.

## Effort updates and cache lineage

OpenAI execution requests use their resolved model with a stable request-level
`reasoning.effort` (profile default `medium`). Optional `JEV_ROUTER_BASE_EFFORT` must be
supported by every registered profile; fallback is independently configurable and defaults to fixed `high`.
Astra supports `low`, `medium`, `high`, `xhigh`, and `max`; Luna and Sol also
support `none`. Existing
reasoning `configuration_update` items in history are preserved in their original
positions. A new update is inserted when the selected effort differs from the
effective history: before the current user message, or at the tail after tool
results when resuming an assistant without a new user message. Consecutive
same-effort requests do not need another update. For example:

```json
{ "type": "configuration_update", "reasoning": { "effort": "high" } }
```

Other input items keep their order. This follows the
[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation):
preserve updates with `previous_response_id`, or replay them in their original
positions. It aims to preserve an eligible reusable prefix, but cannot promise
upstream cache availability, hits, or savings. The fallback-effort cache is
independent of prompt caching.

On Anthropic, top-level `output_config.effort` stays at the profile base
(`medium` for Opus 5.5, `high` for Fable 5.1, Mythos 5.1, and Opus 5), since
changing it invalidates the message cache. The router pins `thinking.type` to
`adaptive` and preserves a caller string `thinking.display`. With
`anthropic-beta: mid-conversation-output-config-2026-07-01`, a selected effort
change is an effort-only message in `messages`:

```json
{ "role": "system", "content": [], "output_config": { "effort": "low" } }
```

Historical updates retain their positions; the next update goes before the
newest user message, including a user message containing only `tool_result`
blocks. Anthropic supports `low`, `medium`, `high`, `xhigh`, `max` (not `none`).
A request whose new suffix has no user message (an assistant prefill) gets no
update, because an update applies only from the next user turn; its decision
event records `effort_applied: false`, and the field is absent otherwise.

The in-memory lineage store reconstructs router-inserted updates when the client
does not send them back. It matches the longest known input ancestor using item
hashes and update positions, scoped by upstream, model, base effort, authorization,
session/cache identity, instructions, and tools. Anthropic has no
`prompt_cache_key`: its lineage is scoped to session plus top-level `system`,
`tools`, `tool_choice`, `speed`, `thinking.display`, and the beta/version headers
actually sent upstream. Anthropic message hashes ignore `cache_control` on
messages and their content blocks, since clients such as OpenCode move the
cache breakpoint to the newest message on every request; the breakpoints are
still sent unchanged. It retains up to 256 snapshots
for 10 minutes and does not store histories over 20,000 content items. These
limits are independent of the configurable fallback-effort cache below.

Exact retries retain their original update boundary. Caller-supplied updates
remain intact; a conflicting update at the selected boundary returns a local
`400` after classification instead of inserting an adjacent update. Edited or
compacted histories, expiry, eviction, ambiguous branches/concurrent attempts,
and process restarts can lose lineage. Without a usable session ID or cache key,
requests are untracked. Replaying history preserves cache eligibility, not a
guaranteed cache hit.

**Unverified Anthropic limitations:** Fable 5.1 and Opus 5.5 may reject a
replayed thinking block (`Invalid signature in thinking block`) if restart,
expiry, or eviction loses an earlier injected effort message. Effort-only
messages reportedly render nothing at their position, but whether that avoids
the signature failure is unverified. It is also unverified whether an update
before a tool-result-only user turn governs the resumed generation. Use the
opt-in [live check](verification.md#anthropic-live-check) before relying on either.

Run the repeatable metadata-only comparison before drawing a cache conclusion;
see [Cache validation](cache-validation.md). Prefix byte/item measurements
are eligibility measurements, not rendered-token counts or cache-hit claims.

Decision telemetry includes `input_tokens`, `cached_input_tokens`, and
`output_tokens` from upstream JSON or SSE usage, plus `previous_effort`,
`lineage_status`, and `history_updates_replayed`. Missing or oversized usage
events yield null counts, not zero. These are request-level counters, not
OpenCode's turn aggregates. The observer never logs response content.
For Anthropic, normalized `input_tokens` includes uncached input, cache reads,
and cache creation; `cached_input_tokens` is cache reads, and
`cache_creation_input_tokens` records cache writes (Anthropic only).

## Classification

- Bounded Jev state (recent user text, assistant progress, up to 8 tool results
  with names and error flags, failure summary) with excerpt caps. Only untyped or
  `message` user/assistant text parts and function/custom tool outputs are
  classified. Opaque typed items, including hosted-tool and computer-use payloads,
  are not copied into Jev state even if they contain `role`, `content`, or `output`.
- One Jev question limited to the resolved model's supported efforts; bounded
  classifier state includes that model's registered ID.
- `@typesafe-ai/sdk` is configured with `retry: { maxRetries: 0 }` and
  `logLevel: "off"` explicitly (SDK logging is suppressed even when
  `TYPESAFE_LOG_LEVEL` is inherited as `debug`).
- One aborting total deadline (`JEV_ROUTER_CLASSIFICATION_TIMEOUT_MS`, default `4000` ms) covers the
  whole classifier operation, including bounded retries and backoff. The router
  defaults to one retry for transient failures; SDK retries remain disabled.
- On timeout (`jev_timeout`), error (`jev_error`), or invalid output
  (`jev_invalid_output`), fallback defaults to fixed high. Optional `previous`
  mode reuses the previous validated effort for the same credential/model/cache
  context, otherwise the configured fallback effort. `error` mode disables
  fallback and returns a classification error without generating upstream.
  See [retry and fallback configuration](classification-policy.md).
  Missing/blank keys disable history. Only successful classifications write or
  renew TTL; fallback does not. The globally shared in-memory previous-effort
  cache is limited to 256 entries and 10 minutes by default, with LRU eviction
  and lazy expiry across all models. This is fallback-effort state, not prompt/KV
  caching or cache lineage.
- Client cancellation is separate from classifier failure: a disconnect aborts
  classification and any upstream request and never fails open into generation,
  including at the timeout-to-fallback boundary. Late classifier results cannot
  change a settled fallback or start duplicate generation.

## Evidence

Per prepared execution request the standalone proxy emits a metadata record to
stdout; when configured, the CLI or plugin also appends a `JevDecision` event containing:

- `request_id`, `session`, and `turn_id` for correlation.
- `model`, `effort`, `jev_latency_ms`, `fallback`, `jev_error_category`, and
  `outcome` for routing. The category is a fixed label for `jev_error` (HTTP
  authentication, rate limit, other 4xx/5xx, connection, SDK timeout/abort, or
  unknown); it is null for other decisions. No error messages or response bodies
  are recorded.
- `input_tokens`, `cached_input_tokens`, and `output_tokens` from upstream usage.
- `cache_creation_input_tokens` for Anthropic usage only.
- `previous_effort`, `lineage_status`, and `history_updates_replayed` for lineage.

Prompt content, tool content, credentials, cache keys, raw SDK errors, and bodies
are never logged.
Set CLI `JEV_ROUTER_DECISIONS_LOG_PATH` or plugin `decisionsLogPath` to an absolute
path to enable JSONL (`ts`, `event`, and the fields above). The directory is
created if needed; writes are asynchronous and limited to 256 pending records
per instance (excess records are dropped). A write failure reports only
`decision_log_failed` and does not interrupt generation. This records the
selected effort, not a measure of the model's internally applied
reasoning effort. Requests rejected before classification/rewrite have no
decision event; a prepared request can record upstream failure or cancellation
as `failed`.
When OpenCode supplies `x-jev-session-id` and `x-jev-turn-id` headers, validated
IDs appear as `session` and `turn_id` in the event. A turn can contain multiple
router requests; requests without these headers have null IDs. These headers
are not forwarded to the upstream. The V2 plugin instead takes `session` from the
native HTTP hook's session ID and assigns each request a new `turn_id`.
Local request-size, overload, and upstream deadline failures use the fixed
`request_too_large`, `overloaded`, and `upstream_timeout` outcome codes.

## Resource limits

All limits are positive integers configured through environment variables:

| Variable | Default | Behavior |
| --- | ---: | --- |
| `JEV_ROUTER_MAX_REQUEST_BYTES` | 1048576 (1 MiB) | Maximum JSON request-body bytes; larger `POST /v1/responses` returns `413` with `{"error":"request_too_large"}`. Counts bytes, including chunked uploads. |
| `JEV_ROUTER_MAX_IN_FLIGHT` | 32 | Concurrent `/v1/responses` and `/v1/models` requests, including body reading, classification and forwarding; excess returns `503` with `{"error":"overloaded"}` before Jev/upstream work. |
| `JEV_ROUTER_UPSTREAM_HEADER_TIMEOUT_MS` | 10000 | Deadline from upstream request start until response headers. |
| `JEV_ROUTER_UPSTREAM_IDLE_TIMEOUT_MS` | 60000 | Maximum gap between upstream response chunks after headers; resets on each chunk and pauses while downstream backpressure pauses upstream reads. No total stream deadline is imposed. |
| `JEV_ROUTER_EFFORT_CACHE_ENTRIES` | 256 | Maximum stored previous efforts (LRU). |
| `JEV_ROUTER_EFFORT_CACHE_TTL_MS` | 600000 (10 min) | Previous-effort expiry from the last successful selection for the key. |
| `JEV_ROUTER_SHUTDOWN_GRACE_MS` | 30000 (30 sec) | Time for active requests and SSE streams to finish after SIGINT/SIGTERM before remaining classifier and upstream work is aborted. |

An upstream deadline before headers returns `504` with
`{"error":"upstream_timeout"}`. After headers, the client stream closes
without injecting a replacement response.

## Shutdown and probes

`SIGINT` and `SIGTERM` start the same idempotent drain: readiness turns false,
new connections stop, idle keep-alive connections close, and accepted requests
and streams can finish until `JEV_ROUTER_SHUTDOWN_GRACE_MS` expires. At the deadline,
remaining work is aborted and connections close. A completed intentional
shutdown exits cleanly; invalid configuration and listener startup failures exit
non-zero. Fixed lifecycle events (`shutdown_started`, `shutdown_deadline`,
`shutdown_complete`, `shutdown_failed`, `startup_failed`) contain no request data.

`GET /health` returns `200 {"status":"ok"}` while the HTTP loop responds, without
checking dependencies. `GET /ready` returns `200 {"status":"ready"}` only while
listening, configured, not draining, and the upstream TCP port is reachable.
Otherwise it returns `503 {"status":"not_ready","reason":"..."}` with one of
`starting`, `missing_configuration`, `draining`, or `dependency_unavailable`.
The upstream probe is bounded to 500 ms and cached for two seconds; it sends no
model or Jev requests. The CLI validates configuration (including the required
Jev key) before listening, so missing configuration normally prevents startup
rather than serving an endpoint. The TCP check verifies connectivity, not
upstream authentication or model availability.

For a container orchestrator, use `/health` for liveness and `/ready` for
readiness, for example:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 4320 }
readinessProbe:
  httpGet: { path: /ready, port: 4320 }
terminationGracePeriodSeconds: 35 # longer than JEV_ROUTER_SHUTDOWN_GRACE_MS
```

For a systemd service, use `ExecStartPost=/usr/bin/curl --fail
http://127.0.0.1:4320/ready` as a startup check, `Restart=on-failure`, and
`TimeoutStopSec=35` (longer than the configured drain deadline). Monitor
`/health` separately for liveness; systemd sends SIGTERM on stop by default.

## Forwarding

- `POST /v1/responses`, optional `POST /v1/messages`, and `GET /v1/models` on localhost; the client's bearer
  credential is forwarded only under `JEV_ROUTER_UPSTREAM_AUTH=forward`. Under
  `JEV_ROUTER_UPSTREAM_AUTH=bearer`, the router sends its own API key instead. Neither
  credential is logged.
- `/v1/messages` returns 404 unless `JEV_ROUTER_ANTHROPIC_UPSTREAM_BASE_URL`
  is set. In forward mode a loopback Anthropic endpoint receives the client's
  `x-api-key` and/or `authorization`; bearer mode sends
  `JEV_ROUTER_ANTHROPIC_UPSTREAM_API_KEY` as `x-api-key` over HTTPS or loopback.
  `anthropic-version` defaults to `2023-06-01`, and the mid-conversation beta
  header is merged with caller betas.
- Anthropic plugin requests do not follow redirects: a 3xx response, with its
  `Location`, is passed through rather than sending credentials to a redirected
  origin. OpenAI plugin
  redirect behavior is unchanged.
- Upstream HTTP statuses and bodies pass through unchanged, including errors.
- SSE streams incrementally with write/drain backpressure: a slow client pauses
  upstream reads instead of buffering the completed response.
- Pre-header connection failures return a fixed local `502`
  (`{"error":"upstream_unavailable"}`); after headers are forwarded, a mid-stream
  failure destroys the stream without appended output or a replacement status.
- Response headers are limited to `content-type`, `cache-control`, `retry-after`,
  `x-request-id`, and `location`, minus anything nominated by the upstream `Connection`
  header. Hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`,
  `te`, `trailer`, `upgrade`) and stale framing headers (`content-length`,
  `content-encoding`, `etag`) are omitted; Node generates framing for the body
  actually sent. Upstream request framing is rebuilt for the rewritten JSON body
  (`Content-Length`/`Transfer-Encoding` from the incoming request are never
  reused).
- Native Node HTTP/fetch and stream primitives only — no proxy framework, no
  upstream retries.

## OpenCode plugin adapters

The OpenCode V2 plugin uses the shared runtime (validation, Jev selection,
rewrite, lineage, limits, and usage observation):

- Claude models join `jev-router` when `anthropicUpstreamApiKey` or
  `anthropicUpstreamBaseURL` is set. Per-model SDK selection uses
  the native Anthropic Messages package.
  The shared interceptor routes `/messages` to the Anthropic base URL (default
  `https://api.anthropic.com/v1`); `/responses` keeps the OpenAI upstream.
  An explicit Anthropic key replaces `authorization` with `x-api-key`;
  otherwise incoming credentials are forwarded (Bearer is converted if needed),
  and a different Anthropic origin is rejected with a local 400. A different
  origin with an explicit key receives only protocol headers (`anthropic-*`,
  `accept`, `content-type`, `user-agent`, `x-stainless-*`) plus `x-api-key`.
- `id: "jev-router"` and `setup()` register the provider through
  `ctx.provider.transform` on `@opencode/ai/providers/openai/responses` with
  `transport: "http"`, then scopes `http.request` and `http.response` session
  hooks to that provider. OpenCode performs the fetch between them:
  - `http.request` reads and validates the body, calls Jev, and replaces the
    one-shot request with the rewritten body. Its signal follows the session's,
    plus plugin cleanup and the header timeout. A local rejection throws, so
    OpenCode reports the error and never contacts the upstream.
  - `http.response` wraps the body for usage observation without buffering and
    keeps the status, body bytes, and filtered headers. OpenCode cancels the body
    after `response.completed`; a cancellation after the terminal event is
    recorded as `completed` and commits lineage.
  - A transport failure produces no response event. The exchange then settles
    at the header timeout as `failed`, and a session cancellation before headers
    settles it immediately. Plugin cleanup aborts and records every open
    exchange. A response that arrives after its exchange settled is cancelled
    and reported as an error rather than streamed.
