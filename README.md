# opencode-jev-router

Adaptive reasoning effort for OpenCode with request-local GPT-6 model selection.

```text
OpenCode selects Astra/Luna/Sol -> one opencode-jev-router -> one Responses upstream
```

`opencode-jev-router` is a small Responses API proxy. For each `POST /v1/responses`
it asks [Jev](https://typesafe.ai/) how much reasoning the next step needs, pins
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
- A TypeSafe API key for Jev (`TYPESAFE_API_KEY`)

## Install and run

The npm package is `@robertn702/opencode-jev-router`; the command is
`opencode-jev-router`. Install Node.js 24.x and configure an upstream below.

Choose one installation method:

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

Set `TYPESAFE_API_KEY` in the environment or put it in a `.env` file in the
working directory before starting the proxy. Choose one upstream:

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
cp .env.example .env   # then fill in TYPESAFE_API_KEY
npm run check          # typecheck + tests
npm run build          # compile the CLI to dist/
npm start              # http://127.0.0.1:4320
curl http://127.0.0.1:4320/health
```

`.env` is git-ignored; the proxy loads it at startup via `process.loadEnvFile()`.
See [`.env.example`](.env.example) for all limits and connection settings.

### OpenCode configuration

Add the provider below (also in [`examples/opencode.jsonc`](examples/opencode.jsonc))
and select `jev-router/gpt-6-astra`, `jev-router/gpt-6-luna`, or
`jev-router/gpt-6-sol`. Restart OpenCode after changing its configuration.
With `UPSTREAM_AUTH=forward`,
`CLIPROXY_KEY` must be set in the OpenCode process; the proxy forwards that
bearer credential to CLIProxyAPI. With `UPSTREAM_AUTH=bearer`, set
`CLIPROXY_KEY` to a non-secret placeholder such as
`local-router` in the OpenCode process; OpenCode sends it locally, but the router
ignores it and substitutes its own `UPSTREAM_API_KEY` upstream. Never put
`UPSTREAM_API_KEY` in the OpenCode provider configuration. OpenCode does not
currently provide a declarative cross-provider alias that can point this model
at another provider's model while performing per-request Jev classification and
`configuration_update` insertion; the router is the wire-level rewrite boundary.

```jsonc
{
  "provider": {
    "jev-router": {
      "npm": "@ai-sdk/openai",
      "name": "Jev Router",
      "options": {
        "apiKey": "{env:CLIPROXY_KEY}",
        "baseURL": "http://127.0.0.1:4320/v1"
      },
      "models": {
        "gpt-6-astra": {
          "name": "GPT-6 Astra",
          "reasoning": true,
          "options": { "useResponses": true }
        },
        "gpt-6-luna": { "name": "GPT-6 Luna", "reasoning": true, "options": { "useResponses": true } },
        "gpt-6-sol": { "name": "GPT-6 Sol", "reasoning": true, "options": { "useResponses": true } }
      }
    }
  }
}
```

## Behavior

### Scope

- GPT-6 **standard, single-agent mode only** with either upstream connection. Requests
  with `reasoning.mode` other than `standard` (pro, multi-agent, etc.), pro model
  slugs, a missing or mismatched `model`, or `truncation: "auto"` are rejected with a local `400` before
  classification or generation. OpenCode reasoning-effort variants are ignored
  for this provider.
- Array-form Responses `input` as emitted by OpenCode is supported, including tool
  continuations (`function_call` / `function_call_output`). Other input shapes are
  rejected with a local `400`.
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
  with names and error flags, failure summary) with excerpt caps.
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

Per forwarded execution request the proxy emits one metadata record containing:

- `request_id`, `session`, and `turn_id` for correlation.
- `model`, `effort`, `jev_latency_ms`, `fallback`, and `outcome` for routing.
- `input_tokens`, `cached_input_tokens`, and `output_tokens` from upstream usage.
- `previous_effort`, `lineage_status`, and `history_updates_replayed` for lineage.

Prompt content, tool content, credentials, cache keys, raw SDK errors, and bodies
are never logged.
Set `JEV_DECISIONS_LOG_PATH` to an absolute path to also append these metadata
records as timestamped `JevDecision` JSONL events (`ts`, `event`, and the fields
above). The directory is created if needed; a write failure reports only
`decision_log_failed` and does not interrupt generation. This records the
selected effort, not a measure of the model's internally applied
reasoning effort. Requests rejected before forwarding have no decision event.
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

Version tags drive publishing. CI checks pull requests and pushes to `main` on
Node 24. The publish workflow checks the tag against `package.json`, runs the
same checks, packs once, tests the **exact tarball**, then publishes that tarball
with npm provenance. Dependency update PRs are opened weekly by Dependabot.

For each release, add user-facing changes to `CHANGELOG.md`, update the version
with `npm version patch|minor|major --no-git-tag-version`, review the lockfile,
and merge the version/changelog change to `main`. Then create and push the
matching tag on that commit, for example `git tag v0.1.0` followed by
`git push origin v0.1.0`. The tag workflow validates, dry-runs, and publishes;
do not publish an unreviewed tag.

## Prior art

The design is informed by:

- [0xNatoshi/jev-codex-router](https://github.com/0xNatoshi/jev-codex-router)
- [mejiasd3v/pi-jev-router](https://github.com/mejiasd3v/pi-jev-router)

No code has been copied from either project.

## License

MIT
