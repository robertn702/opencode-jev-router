# opencode-jev-router

Adaptive reasoning effort for OpenCode with one fixed execution model.

```text
OpenCode -> opencode-jev-router -> CLIProxyAPI (Codex subscription) or OpenAI API (API key)
```

`opencode-jev-router` is a small Responses API proxy. For each `POST /v1/responses`
it asks [Jev](https://typesafe.ai/) how much reasoning the next step needs, pins
execution to `gpt-6-astra`, and appends an Astra `configuration_update` item that
carries the selected effort. The request-level `reasoning.effort` stays at a stable
base (`medium` by default) so the response's reported effort is always the base
setting, not the update-selected value.

## Status

Verified spike. The checks recorded below were run on Node 24.x during
implementation; see [Verified behavior](#verified-behavior) for what that does and
does not prove.

## Requirements

- Node.js 24.x (runtime and development)
- Either [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) with Codex OAuth
  or an OpenAI API key with access to `gpt-6-astra`
- A TypeSafe API key for Jev (`TYPESAFE_API_KEY`)

## Install and run

The npm package is `@robertn702/opencode-jev-router`; the command is
`opencode-jev-router`. Install Node.js 24.x and choose an upstream mode below.

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
# CLIProxyAPI (default; existing configurations work without UPSTREAM_MODE)
UPSTREAM_MODE=cliproxy
UPSTREAM_BASE_URL=http://127.0.0.1:8317/v1
```

```dotenv
# Direct OpenAI (billed to your API account, independent of a Codex subscription)
UPSTREAM_MODE=openai
OPENAI_API_KEY=sk-...
UPSTREAM_BASE_URL=https://api.openai.com/v1
```

In `openai` mode, the router uses only `OPENAI_API_KEY` for upstream
`Authorization`, regardless of any OpenCode bearer token. The OpenAI URL is
restricted to the official HTTPS API base; `cliproxy` mode rejects
`api.openai.com` as its base URL. Missing keys, unknown modes, or mismatched
URLs fail at startup before the server listens. The CLI listens on
`http://127.0.0.1:4320` by default; check `curl http://127.0.0.1:4320/health`.
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
and select `jev/astra`. In `cliproxy` mode, `CLIPROXY_KEY` must be set in the
OpenCode process; the proxy forwards that bearer credential to CLIProxyAPI.
In `openai` mode, set `CLIPROXY_KEY` to a non-secret placeholder such as
`local-router` in the OpenCode process; OpenCode sends it locally, but the router
ignores it and substitutes its own `OPENAI_API_KEY` upstream. Never put
`OPENAI_API_KEY` in the OpenCode provider configuration.

```jsonc
{
  "provider": {
    "jev": {
      "npm": "@ai-sdk/openai",
      "name": "Jev adaptive Astra",
      "options": {
        "apiKey": "{env:CLIPROXY_KEY}",
        "baseURL": "http://127.0.0.1:4320/v1"
      },
      "models": {
        "astra": {
          "name": "GPT-6 Astra with adaptive effort",
          "reasoning": true,
          "options": { "useResponses": true }
        }
      }
    }
  }
}
```

## Behavior

### Scope

- Astra **standard, single-agent mode only** in either upstream mode. Requests
  with `reasoning.mode` other than `standard` (pro, multi-agent, etc.), pro model
  slugs, or `truncation: "auto"` are rejected with a local `400` before
  classification or generation. OpenCode reasoning-effort variants are ignored
  for this provider.
- Array-form Responses `input` as emitted by OpenCode is supported, including tool
  continuations (`function_call` / `function_call_output`). Other input shapes are
  rejected with a local `400`.
- `UPSTREAM_MODEL` pins the outbound model (default `gpt-6-astra`). Direct API
  access requires that model to be available to your API organization; a Codex
  subscription or CLIProxyAPI alias does not grant API access. Check the
  [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra)
  for API availability and supported efforts. `configuration_update` is supported
  for the GPT-6 family in standard, single-agent mode; choosing a different model
  can cause the API to reject this router's update item.

### Effort updates (no cache lineage)

Every execution request is rewritten to `model: gpt-6-astra` with a stable
request-level `reasoning.effort` (`BASE_EFFORT`, default `medium`). Existing
reasoning `configuration_update` items are stripped from the input and exactly one
current update is appended at the end:

```json
{ "type": "configuration_update", "reasoning": { "effort": "high" } }
```

Other input items keep their order. This strip/append policy does **not** replay
updates at their original historical positions and promises **no cache lineage,
hits, or savings**. Historical update replay and cache-prefix preservation are
deferred; [OpenAI's guidance](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)
requires retaining original update positions when replaying history manually.

### Classification

- Bounded Jev state (recent user text, assistant progress, up to 8 tool results
  with names and error flags, failure summary) with excerpt caps.
- One Jev question selecting `low`, `medium`, `high`, `xhigh`, or `max`.
- `@typesafe-ai/sdk` is configured with `retry: { maxRetries: 0 }` and
  `logLevel: "off"` explicitly (SDK logging is suppressed even when
  `TYPESAFE_LOG_LEVEL` is inherited as `debug`).
- One aborting total deadline (`JEV_TIMEOUT_MS`, default `4000` ms) covers the
  whole classifier call through body consumption. There is no promise race that
  leaves the request running and no retry loop.
- On timeout (`jev_timeout`), error (`jev_error`), or invalid output
  (`jev_invalid_output`), the previous validated effort for the same usable
  `prompt_cache_key` is reused; otherwise `medium`. The in-memory previous-effort
  cache is limited to 256 entries and 10 minutes by default, with LRU eviction
  and lazy expiry. It is not a history or cache-preservation store.
- Client cancellation is separate from classifier failure: a disconnect aborts
  classification and any upstream request and never fails open into generation,
  including at the timeout-to-fallback boundary. Late classifier results cannot
  change a settled fallback or start duplicate generation.

### Evidence

Per accepted execution request the proxy emits one metadata record with only:
proxy-generated request ID, outbound pinned model, validated selected effort
(from the rewritten outbound request), Jev latency, a fixed fallback code, and a
fixed completion/failure outcome. Prompt content, tool content, credentials,
cache keys, raw SDK errors, and bodies are never logged.
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

An upstream deadline before headers returns `504` with
`{"error":"upstream_timeout"}`. After headers, the client stream closes
without injecting a replacement response.

### Forwarding

- `POST /v1/responses` and `GET /v1/models` on localhost; the client's bearer
  credential is forwarded only in CLIProxyAPI mode. In OpenAI mode, the router
  sends its own API key instead. Neither credential is logged.
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

Ran on Node 24.x (`npm run check`: 51 tests) with **OpenCode 1.18.32** and
**CLIProxyAPI 7.2.151**:

1. The actual OpenCode client emits array-form `POST /v1/responses` input and
   performs tool continuations through the proxy (shape-verified against a capture
   upstream, no prompts or credentials retained).
2. A live CLIProxyAPI/Codex request in Astra standard, single-agent mode accepted
   the strip/append `configuration_update` placement and completed a real tool
   continuation.
3. A full-path OpenCode -> proxy -> CLIProxyAPI -> Codex tool task completed with
   Jev enabled (tool executed, task finished).
4. Two live requests selected **different** Jev efforts (`low` and `high`) while
   the outbound model stayed `gpt-6-astra` and the top-level effort stayed
   `medium` in both.

What this proves: protocol compatibility of the strip/append policy, outbound
model/effort selection, and completed tool-using tasks. The response's
`reasoning.effort` reports the stable request-level setting, **not** the
update-selected effort; there is no visibility into the model's internally applied
effort.

Direct OpenAI mode is covered by offline fake-upstream tests for non-streaming,
streaming SSE, tool continuations, and authorization routing. A live direct
OpenAI request has not yet been verified; it requires an `OPENAI_API_KEY` with
API access to `gpt-6-astra`.

## Development

```bash
npm run typecheck
npm test
npm run check   # both, on Node 24.x
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
