# opencode-jev-router

[![CI](https://github.com/robertn702/opencode-jev-router/actions/workflows/ci.yml/badge.svg)](https://github.com/robertn702/opencode-jev-router/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40robertn702%2Fopencode-jev-router)](https://www.npmjs.com/package/@robertn702/opencode-jev-router)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Adaptive reasoning effort for OpenCode with request-local GPT-6 model selection.

```text
OpenCode selects Astra/Luna/Sol -> one opencode-jev-router -> one Responses upstream
```

`opencode-jev-router` is an OpenCode plugin with an optional standalone Responses
API proxy. For each `POST /v1/responses`, it asks [Jev](https://typesafe.ai/)
how much reasoning the next step needs, pins
execution to the resolved request model, and preserves historical effort updates.
When needed, a `configuration_update` carries the selected effort before the
current user message or after the tool results of a continuation. The request-level
`reasoning.effort` stays at a stable base (`medium` by default), so the response's reported effort is the base
setting, not the update-selected value.

## Status

Supports Astra, Luna, and Sol through a shared Responses upstream, with bounded
classification, streaming passthrough, cache-lineage replay, and request-level
usage telemetry. Offline tests and live checks cover protocol compatibility;
controlled live cache trials found no systematic additional adaptive cache loss
in the limited sample. See [Verified behavior](#verified-behavior) for the evidence
and remaining validation gaps.

The goal is faster **successful task completion**, not higher tokens per second.
Lower effort can reduce unnecessary reasoning; higher effort may avoid failed
attempts or extra tool calls. Whether adaptive effort improves end-to-end time
and correctness over fixed effort has not yet been established by a task benchmark.

## Requirements

- Node.js 24.x (runtime and development)
- Either [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) with Codex OAuth
  or an OpenAI API key with access to the selected GPT-6 model
- A Jev classifier key. For direct TypeSafe access, use a TypeSafe key. For
  Vercel, use an AI Gateway key and select Vercel's TypeSafe-compatible endpoint
  as shown below.

## Quick start: OpenCode plugin

Use Node.js 24.x and an OpenCode setup with a working GPT-6 Responses upstream.
This uses the published `@robertn702/opencode-jev-router@0.2.0` plugin; the
source-compatibility smoke test targets OpenCode 1.18.32 (see
[compatibility](#plugin-compatibility-and-telemetry)). You need separate
credentials for classification and generation:

```text
OpenCode -> Jev Router plugin -> CLIProxyAPI (Codex OAuth) or OpenAI Responses API
                 |                  CLIPROXY_KEY         OPENAI_API_KEY
                 +-> Jev: direct TypeSafe or Vercel AI Gateway
                          JEV_API_KEY (key for the chosen endpoint)
```

1. Make the keys available in the environment that starts OpenCode (for
   example, via your shell or secret manager). Choose one Jev endpoint. This
   example uses a [Vercel AI Gateway key](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
   for `JEV_API_KEY` and CLIProxyAPI on `127.0.0.1:8317` with `CLIPROXY_KEY`
   for generation. Add this to your OpenCode configuration, replacing the log
   path with a writable absolute path:

```jsonc
{
  "plugin": [["@robertn702/opencode-jev-router@0.2.0", {
    "jevApiKey": "{env:JEV_API_KEY}",
    "jevBaseUrl": "https://ai-gateway.vercel.sh/typesafe",
    "upstreamBaseURL": "http://127.0.0.1:8317/v1",
    "upstreamApiKey": "{env:CLIPROXY_KEY}",
    "decisionsLogPath": "/absolute/path/to/jev-plugin-decisions.jsonl"
  }]],
  "model": "jev-router/gpt-6-astra"
}
```

   For **direct TypeSafe** classification instead, use a TypeSafe key for
   `JEV_API_KEY` and remove the `jevBaseUrl` line. The default endpoint is
   `https://api.typesafe.ai` with model identifier `jev-latest`. With Vercel,
   the plugin uses `typesafe-ai/jev` automatically. Keys for the two endpoints
   are not interchangeable.

   For **direct OpenAI** generation instead of CLIProxyAPI, replace the two
   upstream lines with `"upstreamBaseURL": "https://api.openai.com/v1"` and
   `"upstreamApiKey": "{env:OPENAI_API_KEY}"`. That key needs access to the
   selected GPT-6 model. Direct API usage is billed independently of a Codex
   subscription. Keep the Jev settings you chose above.

2. Restart OpenCode, select `jev-router/gpt-6-astra` (or `...-luna` / `...-sol`),
   and ask **“Reply with exactly OK.”** Wait for the response to complete.
   The plugin installs through OpenCode; no separate router process is needed.

3. Open the JSONL file at `decisionsLogPath` and find the latest line with
   `"event":"JevDecision"`. Check `model`, `effort`, `fallback`, and `outcome`.
   A successful classified request has the selected model, `"fallback":null`,
   and `"outcome":"completed"`; `effort` is Jev's selected effort. A non-null
   `fallback` means that effort was a fallback, not a Jev selection. The log
   contains metadata, not prompts or credentials. The response's reported
   `reasoning.effort` is the stable base, **not** Jev's selection. If no event
   appears, check the absolute log path, write permissions, and provider
   selection; writes are asynchronous, so allow a moment after completion.

OpenCode expands `{env:NAME}` and `{file:path}` in plugin options. If you
prefer a key file, replace `"{env:JEV_API_KEY}"` with a file reference such
as `"{file:~/.config/jev-router/api-key}"`; create the file yourself and
restrict its permissions. The path is an example, not a router requirement.

The plugin registers the `jev-router` provider and its Astra/Luna/Sol model
catalog. `jevApiKey` is used only for classification. `upstreamBaseURL`
points to the Responses upstream, while `upstreamApiKey` authenticates to
that upstream; it may be omitted if OpenCode supplies the provider credential
through its normal auth handling.

See [`examples/opencode.jsonc`](examples/opencode.jsonc) for the copyable
Vercel/CLIProxyAPI configuration.

### Plugin compatibility and telemetry

| OpenCode path | Documented verification |
| --- | --- |
| 1.18.32, local-file plugin | `scripts/plugin-smoke.mjs`: plugin load, configuration hook, rewritten fake Responses SSE, and independent `./server` import resolution. |
| npm-registry plugin with real services | No versioned reproduction recorded here yet. |
| OpenCode v2 | Not verified; do not assume this v1-style `plugin` config applies to v2. |

The source-compatibility smoke is pinned to OpenCode 1.18.32's plugin and
provider-fetch behavior; it does not exercise a registry installation or
real services. Record the OpenCode version, upstream, classification endpoint,
and completed-request outcome when reproducing a clean install.

Set the optional plugin `decisionsLogPath` to an **absolute** local path
to append timestamped, metadata-only `JevDecision` JSONL events. Omit it to
disable plugin logging.

OpenCode's `chat.headers` hook supplies the session ID and a request UUID,
which appear as `session` and `turn_id`. The session can be used to associate
decisions with OpenCode turns; `turn_id` identifies a routed request and is not
guaranteed to equal an `LLMTurn` identifier. A turn may have multiple
requests/decisions. Invalid or missing headers yield null IDs.
`JEV_DECISIONS_LOG_PATH` configures the **standalone CLI** only; the plugin
does not read it. The plugin does not print per-request evidence to stdout,
whereas the standalone CLI does so even without its optional JSONL path.
Provider `jev-router` or the response's reported effort alone does not reveal
the selected effort or fallback.

Select `jev-router/gpt-6-astra`, `jev-router/gpt-6-luna`, or
`jev-router/gpt-6-sol`, then restart OpenCode after changing its configuration.
The plugin-generated model metadata marks all three models as reasoning-capable
and enables `useResponses: true`.

Existing `provider["jev-router"]` and model entries remain supported for
advanced customization. Explicit provider `options.baseURL` / `options.apiKey`
override plugin `upstreamBaseURL` / `upstreamApiKey`; explicit provider name and
model metadata override generated defaults. Missing values are generated or
filled from plugin options. An upstream API key is optional to preserve
OpenCode's normal provider credential resolution. The plugin always supplies
`npm: "@ai-sdk/openai"`, the fetch adapter, and `useResponses: true`:
conflicting provider SDK, provider/model fetch, model `provider.npm`, or
`useResponses: false` configuration fails startup rather than bypassing Jev
routing.

To migrate, move the old provider `options.baseURL` and `options.apiKey` to the
plugin tuple and delete the provider block. Keep a provider/model block only
for intentional metadata overrides; do not use it to select another SDK,
endpoint adapter, or Chat Completions mode. See
[`examples/opencode.jsonc`](examples/opencode.jsonc) for the minimal setup.

## Standalone proxy (optional)

The npm package is `@robertn702/opencode-jev-router`; the standalone command is
`opencode-jev-router`. Choose one installation method:

```bash
npm install -g @robertn702/opencode-jev-router
opencode-jev-router --help
opencode-jev-router
```

```bash
npx --yes @robertn702/opencode-jev-router --help
npx --yes @robertn702/opencode-jev-router
```

```bash
npm install @robertn702/opencode-jev-router
npx opencode-jev-router
```

Set `JEV_API_KEY` in the environment or put it in a `.env` file in the
working directory before starting the proxy. For direct TypeSafe, no other Jev
setting is needed. The standalone proxy uses `JEV_BASE_URL`, while the plugin
uses `jevBaseUrl` in OpenCode configuration.

To classify through [Vercel AI Gateway's TypeSafe-compatible endpoint](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe),
use its AI Gateway key and set:

```dotenv
JEV_API_KEY=your-ai-gateway-key
JEV_BASE_URL=https://ai-gateway.vercel.sh/typesafe
```

The router uses Vercel's `typesafe-ai/jev` identifier automatically. Only these
two Jev endpoints are supported. `TYPESAFE_API_KEY` is no longer accepted;
rename it to `JEV_API_KEY` for direct TypeSafe access. The Jev key is used only
for classification; it is never reused as `UPSTREAM_API_KEY` or OpenCode's
`CLIPROXY_KEY`.

Choose one Responses upstream independently:

```dotenv
# CLIProxyAPI (default)
UPSTREAM_BASE_URL=http://127.0.0.1:8317/v1
UPSTREAM_AUTH=forward
```

```dotenv
# Direct OpenAI (billed to your API account, independent of a Codex subscription)
UPSTREAM_BASE_URL=https://api.openai.com/v1
UPSTREAM_AUTH=bearer
UPSTREAM_API_KEY=sk-...
```

The upstream contract is `UPSTREAM_BASE_URL` and `UPSTREAM_AUTH`, shared by all
three registered models. The default `forward` policy passes the
client Authorization header to a **loopback-only** upstream. The `bearer` policy
replaces it with `Bearer UPSTREAM_API_KEY`, regardless of the client credential;
it permits HTTPS upstreams (including direct OpenAI or an external gateway) and
loopback HTTP for local testing. An external gateway can own account or provider
selection; the router only chooses effort and rewrites Responses requests.
Unknown policies, stale `UPSTREAM_MODE`/`OPENAI_API_KEY` settings, missing or
misplaced keys, and unsafe endpoint/policy pairs fail at startup. Migrate old
`openai` settings to `UPSTREAM_AUTH=bearer` and `UPSTREAM_API_KEY`; old
`cliproxyapi` settings to `UPSTREAM_AUTH=forward` (or omit it). The CLI listens on
`http://127.0.0.1:4320` by default; check `curl http://127.0.0.1:4320/health`.
Use `curl --fail http://127.0.0.1:4320/ready` to check readiness.
Run `opencode-jev-router --help` for environment options.

### Develop from source

```bash
npm ci
cp .env.example .env   # then fill in JEV_API_KEY
npm run check          # typecheck + tests
npm run build          # compile the CLI to dist/
npm start              # http://127.0.0.1:4320
curl http://127.0.0.1:4320/health
```

`.env` is git-ignored; the proxy loads it at startup via `process.loadEnvFile()`.
See [`.env.example`](.env.example) for all limits and connection settings.

## Behavior

### Scope

- GPT-6 **standard, single-agent mode only** with either upstream connection. Requests
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
- `configuration_update` is intentionally *not* opaque: only a model-valid
  `reasoning.effort` update with no extra fields is accepted. `reasoning.mode`
  must be `standard` if set; `truncation` must be `disabled` if set (`auto` can
  drop injected history). Conflicting caller updates at an insertion boundary
  receive a local `400`. No item fields are silently stripped to make these
  combinations work.
- Exact registered IDs are `gpt-6-astra`, `gpt-6-luna`, and `gpt-6-sol`.
  Missing, malformed, unknown, and pro IDs fail locally before classification.
  All registered models are available without model environment settings.
  `UPSTREAM_MODEL`, `UPSTREAM_MODELS`, and `ALLOWED_MODELS` are rejected at startup
  with value-free diagnostics directing selection through `request.model`.
  There are no aliases or custom-model overrides. Upstream entitlement is separate.
- `/v1/models` remains authenticated upstream passthrough: its inventory is not
  the router capability registry. Independent same-model tool continuations are
  supported; arbitrary cross-model encrypted reasoning or response-ID replay is
  not guaranteed.

### Effort updates and cache lineage

Every execution request uses its resolved model with a stable request-level
`reasoning.effort` (profile default `medium`). Optional `BASE_EFFORT` must be
supported by every registered profile; fallback remains independently `medium`.
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
[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation): preserve updates with `previous_response_id`, or replay them in their original positions. It aims to preserve an eligible reusable prefix, but cannot promise upstream cache availability, hits, or savings. The fallback-effort cache is independent of prompt caching.

The in-memory lineage store reconstructs router-inserted updates when the client
does not send them back. It matches the longest known input ancestor using item
hashes and update positions, scoped by upstream, model, base effort, authorization,
session/cache identity, instructions, and tools. It retains up to 256 snapshots
for 10 minutes and does not store histories over 20,000 content items. These
limits are independent of the configurable fallback-effort cache below.

Exact retries retain their original update boundary. Caller-supplied updates
remain intact; a conflicting update at the selected boundary returns a local
`400` after classification instead of inserting an adjacent update. Edited or
compacted histories, expiry, eviction, ambiguous branches/concurrent attempts,
and process restarts can lose lineage. Without a usable session ID or cache key,
requests are untracked. Replaying history preserves cache eligibility, not a
guaranteed cache hit.

Run the repeatable metadata-only comparison before drawing a cache conclusion;
see [Cache validation](docs/cache-validation.md). Prefix byte/item measurements
are eligibility measurements, not rendered-token counts or cache-hit claims.

Decision telemetry includes `input_tokens`, `cached_input_tokens`, and
`output_tokens` from upstream JSON or SSE usage, plus `previous_effort`,
`lineage_status`, and `history_updates_replayed`. Missing or oversized usage
events yield null counts, not zero. These are request-level counters, not
OpenCode's turn aggregates. The observer never logs response content.

### Classification

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
- One aborting total deadline (`JEV_TIMEOUT_MS`, default `4000` ms) covers the
  whole classifier call through body consumption. There is no promise race that
  leaves the request running and no retry loop.
- On timeout (`jev_timeout`), error (`jev_error`), or invalid output
  (`jev_invalid_output`), the previous validated effort for the same usable
  tuple `[resolved model ID, prompt_cache_key]` is reused; otherwise the profile
  fallback. Tuple encoding is collision-safe; the upstream key is unchanged.
  Missing/blank keys disable history. Only successful classifications write or
  renew TTL; fallback does not. The globally shared in-memory previous-effort
  cache is limited to 256 entries and 10 minutes by default, with LRU eviction
  and lazy expiry across all models. This is fallback-effort state, not prompt/KV
  caching or cache lineage.
- Client cancellation is separate from classifier failure: a disconnect aborts
  classification and any upstream request and never fails open into generation,
  including at the timeout-to-fallback boundary. Late classifier results cannot
  change a settled fallback or start duplicate generation.

### Evidence

Per prepared execution request the standalone proxy emits a metadata record to
stdout; when configured, the CLI or plugin also appends a `JevDecision` event containing:

- `request_id`, `session`, and `turn_id` for correlation.
- `model`, `effort`, `jev_latency_ms`, `fallback`, `jev_error_category`, and
  `outcome` for routing. The category is a fixed label for `jev_error` (HTTP
  authentication, rate limit, other 4xx/5xx, connection, SDK timeout/abort, or
  unknown); it is null for other decisions. No error messages or response bodies
  are recorded.
- `input_tokens`, `cached_input_tokens`, and `output_tokens` from upstream usage.
- `previous_effort`, `lineage_status`, and `history_updates_replayed` for lineage.

Prompt content, tool content, credentials, cache keys, raw SDK errors, and bodies
are never logged.
Set CLI `JEV_DECISIONS_LOG_PATH` or plugin `decisionsLogPath` to an absolute
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
are not forwarded to the upstream.
Local request-size, overload, and upstream deadline failures use the fixed
`request_too_large`, `overloaded`, and `upstream_timeout` outcome codes.

### Resource limits

All limits are positive integers configured through environment variables:

| Variable | Default | Behavior |
| --- | ---: | --- |
| `MAX_REQUEST_BYTES` | 1048576 (1 MiB) | Maximum JSON request-body bytes; larger `POST /v1/responses` returns `413` with `{"error":"request_too_large"}`. Counts bytes, including chunked uploads. |
| `MAX_IN_FLIGHT` | 32 | Concurrent `/v1/responses` and `/v1/models` requests, including body reading, classification and forwarding; excess returns `503` with `{"error":"overloaded"}` before Jev/upstream work. |
| `UPSTREAM_HEADER_TIMEOUT_MS` | 10000 | Deadline from upstream request start until response headers. |
| `UPSTREAM_IDLE_TIMEOUT_MS` | 60000 | Maximum gap between upstream response chunks after headers; resets on each chunk and pauses while downstream backpressure pauses upstream reads. No total stream deadline is imposed. |
| `EFFORT_CACHE_ENTRIES` | 256 | Maximum stored previous efforts (LRU). |
| `EFFORT_CACHE_TTL_MS` | 600000 (10 min) | Previous-effort expiry from the last successful selection for the key. |
| `SHUTDOWN_GRACE_MS` | 30000 (30 sec) | Time for active requests and SSE streams to finish after SIGINT/SIGTERM before remaining classifier and upstream work is aborted. |

An upstream deadline before headers returns `504` with
`{"error":"upstream_timeout"}`. After headers, the client stream closes
without injecting a replacement response.

### Shutdown and probes

`SIGINT` and `SIGTERM` start the same idempotent drain: readiness turns false,
new connections stop, idle keep-alive connections close, and accepted requests
and streams can finish until `SHUTDOWN_GRACE_MS` expires. At the deadline,
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
terminationGracePeriodSeconds: 35 # longer than SHUTDOWN_GRACE_MS
```

For a systemd service, use `ExecStartPost=/usr/bin/curl --fail
http://127.0.0.1:4320/ready` as a startup check, `Restart=on-failure`, and
`TimeoutStopSec=35` (longer than the configured drain deadline). Monitor
`/health` separately for liveness; systemd sends SIGTERM on stop by default.

### Forwarding

- `POST /v1/responses` and `GET /v1/models` on localhost; the client's bearer
  credential is forwarded only under `UPSTREAM_AUTH=forward`. Under
  `UPSTREAM_AUTH=bearer`, the router sends its own API key instead. Neither
  credential is logged.
- Upstream HTTP statuses and bodies pass through unchanged, including errors.
- SSE streams incrementally with write/drain backpressure: a slow client pauses
  upstream reads instead of buffering the completed response.
- Pre-header connection failures return a fixed local `502`
  (`{"error":"upstream_unavailable"}`); after headers are forwarded, a mid-stream
  failure destroys the stream without appended output or a replacement status.
- Response headers are limited to `content-type`, `cache-control`, `retry-after`,
  and `x-request-id`, minus anything nominated by the upstream `Connection`
  header. Hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`,
  `te`, `trailer`, `upgrade`) and stale framing headers (`content-length`,
  `content-encoding`, `etag`) are omitted; Node generates framing for the body
  actually sent. Upstream request framing is rebuilt for the rewritten JSON body
  (`Content-Length`/`Transfer-Encoding` from the incoming request are never
  reused).
- Native Node HTTP/fetch and stream primitives only — no proxy framework, no
  upstream retries.

## Verified behavior

### Cache preservation

The 2026-09-23 controlled comparison on Node 24.21.0 made 42 live requests through
the configured loopback upstream, using two alternating fixed/adaptive trials
and a tool-continuation pilot. All returned HTTP 200; placement, effective-effort,
exact-retry, and tool checks passed. Both arms averaged 2,765 cached input tokens;
cached/input ratios were 0.869 fixed and 0.868 adaptive. Each arm had one isolated
zero-cache request. The limited sample showed no systematic additional adaptive
cache loss.

This exercised the checked-out implementation with a deterministic injected
selector and an in-process server. It did not verify the running deployment's
revision or real Jev's adaptive choices. A separate real-Jev smoke completed
with `low` effort and no fallback. See [Cache validation](docs/cache-validation.md)
for reproduction, trial conditions, historical pilot results, and limitations.

### Model and client compatibility

The official [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and
[Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) pages document the
supported effort sets. The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)
documents configuration updates for the GPT-6 family in standard, single-agent mode.

Multi-model verification on Node 24.21.0 passed 90 offline tests and the build.
Live checks through the configured loopback upstream at `http://127.0.0.1:8317`
with forwarded credentials returned HTTP 200 and completed for non-streaming,
SSE completion, and independent same-model tool continuations on all three models.
These checks used `scripts/verify-models.mjs`; incremental SSE is tested offline.
Actual OpenCode-client acceptance of all three selections and additional explicit
multi-model edge-case assertions remain pending. Direct bearer-auth live checks
were not run for this change.

The following results are historical Astra checks, not new Luna/Sol evidence.

Ran on Node 24.x (`npm run check`: 51 tests) with **OpenCode 1.18.32** and
**CLIProxyAPI 7.2.151**:

1. The actual OpenCode client emits array-form `POST /v1/responses` input and
   performs tool continuations through the proxy (shape-verified against a capture
   upstream, no prompts or credentials retained).
2. A live CLIProxyAPI/Codex request in Astra standard, single-agent mode accepted
   the historical strip/append placement and completed a real tool continuation.
3. A full-path OpenCode -> proxy -> CLIProxyAPI -> Codex tool task completed with
   Jev enabled (tool executed, task finished).
4. Two live requests selected **different** Jev efforts (`low` and `high`) while
   the outbound model stayed `gpt-6-astra` and the top-level effort stayed
   `medium` in both.

What this proves: historical protocol compatibility, outbound model/effort
selection, and completed tool-using tasks. An effort update is needed when the
selected effort changes, before the next user message or tail tool continuation;
consecutive same-effort turns do not need another update. Cache-preservation
evidence under the current replay placement is measured in
[`docs/cache-validation.md`](docs/cache-validation.md).
The response's
`reasoning.effort` reports the stable request-level setting, **not** the
update-selected effort; there is no visibility into the model's internally applied
effort.

The direct OpenAI connection is covered by offline fake-upstream tests for non-streaming,
streaming SSE, tool continuations, and authorization routing. A live direct
OpenAI request through the router with Jev classification completed on
`gpt-6-astra` (HTTP 200, response status `completed`, one output item). This
verifies the non-streaming direct path; live SSE and tool continuations in direct
connection have only fake-upstream test coverage.

## Development

```bash
npm run typecheck
npm test
npm run check   # both, on Node 24.x
npm run cache:validate # offline prefix/retry/usage comparison
```

Tests use fake upstreams and a mocked Jev fetch — no API keys or paid requests.
`npm run smoke:package` packs the package, installs it with production dependencies
in a clean temporary directory, and starts the installed executable.

### Releasing to npm

Version tags drive subsequent publishing. CI checks pull requests and pushes to
`main` on Node 24. The tag workflow checks the version, runs the same checks,
packs once, tests the **exact tarball**, and publishes it with npm provenance.
Dependency update PRs are opened weekly by Dependabot.

For each release, add user-facing changes to `CHANGELOG.md`, update the version
in `package.json`, `package-lock.json`, and the plugin example above, and merge
the reviewed release change to `main`. Create and push the matching `v<version>`
tag on that commit. The tag workflow validates, smoke-tests, and publishes the
artifact with npm provenance using trusted publishing.

## Prior art

The design is informed by:

- [0xNatoshi/jev-codex-router](https://github.com/0xNatoshi/jev-codex-router)
- [mejiasd3v/pi-jev-router](https://github.com/mejiasd3v/pi-jev-router)

No code has been copied from either project.

## License

MIT
