# Changelog

## 0.6.1

- Add Claude Sonnet 5.5 (`claude-sonnet-5-5`) to the Anthropic profiles for OpenCode V2 wraps.

## 0.6.0

- **Breaking:** OpenCode V1 plugin support is removed. The default export has
  `id`/`setup()` but no `server()`, and the `./server` package export is
  removed. OpenCode V2 2.0.4 is the minimum supported version (tested with 2.0.4
  and 2.0.18). 0.5.x is the last V1-compatible release and receives no further
  fixes; V1 users can pin `@robertn702/opencode-jev-router@0.5` or use the
  standalone proxy, which is unchanged.
- **Breaking:** `jev-router` models now wrap existing OpenCode models instead of
  calling a plugin-configured upstream. `upstreamBaseURL`, `upstreamApiKey`,
  `anthropicUpstreamBaseURL`, and `anthropicUpstreamApiKey` are removed and fail
  at startup. List source models under `wrap`, grouped by wire:
  `"wrap": { "openai": ["openai/gpt-6-astra"], "anthropic": ["anthropic/claude-opus-5-5"] }`.
  Each alias (`jev-router/<profile>`) reuses its source's route, headers, and
  API key (from source settings, the environment, or `opencode auth login`).
  A gateway becomes an OpenCode provider that you wrap. Invalid refs fail every
  `jev-router` request with a message listing them. Subscription (OAuth) sources
  such as ChatGPT or Claude plans are not supported yet.
- Only primary agent requests are classified. Title, compaction, and generate
  requests to a wrapped model pass through unchanged without a decision event;
  a primary request on the wrong wire path is rejected locally.
- `jev-router` stays on HTTP transport; a websocket override fails the request
  instead of bypassing Jev. Source providers keep their own transport.
- Session cancellation before upstream headers now reliably aborts the routed
  request. Previously, garbage collection of OpenCode's original request could
  break the abort link and leave the exchange open until the header timeout.
- A stream cancelled mid-response is recorded as `failed`, not `completed`, even
  when a pending upstream read settles after the cancellation.
- Anthropic effort history is preserved across requests again. OpenCode moves
  the `cache_control` breakpoint to the newest message on every request, which
  made each continuation look like edited history and dropped earlier effort
  updates from the prompt prefix. Lineage now compares messages without it.

## 0.5.0

- **Breaking:** the Jev classifier credential is `JEV_API_KEY` and its endpoint
  is `JEV_BASE_URL`, for both the proxy and the plugin's environment fallback.
  `JEV_ROUTER_API_KEY` and `JEV_ROUTER_BASE_URL` are rejected with an error
  naming the replacement. Other `JEV_ROUTER_*` router settings are unchanged.
- Claude support for Fable 5.1, Mythos 5.1, Opus 5.5 and Opus 5 through the
  Anthropic Messages API. The top-level `output_config.effort` stays fixed and
  Jev's selection is sent as an effort-only system message before the newest
  user message, so the prompt cache prefix is preserved. The proxy adds
  `POST /v1/messages` (`JEV_ROUTER_ANTHROPIC_UPSTREAM_*`); the plugin adds the
  Claude models to `jev-router` when `anthropicUpstreamBaseURL` or
  `anthropicUpstreamApiKey` is set.
- `npm run cache:validate` also checks the Anthropic path (offline by default;
  live mode is separately opted in).
- Redirect responses keep their `Location` header.

## 0.4.0

- OpenCode V2 support. The package's default export now serves both majors:
  V1 1.18.29+ calls `server()` and V2 calls `setup()`. In V2 the plugin
  registers `jev-router` through a provider transform on the native OpenAI
  Responses runtime and routes requests with provider-scoped HTTP hooks. Options,
  models, and decision events are unchanged. V2 users can use the object form of
  `plugins` (the former V2 example); the V1 `plugin` tuple keeps working
  in both. Tested with OpenCode 1.18.32 and 2.0.18.
- The plugin default export is now an object, not a function. OpenCode loads
  both forms; code that called the export directly should call `.server()`.
- A stream the client cancels after the upstream's `response.completed` event is
  now recorded as `completed` and commits lineage. OpenCode V2 cancels at that
  point rather than reading to EOF.
- CI runs the plugin smoke against pinned OpenCode 1.18.32 and 2.0.18
  (`npm run smoke:plugin:v2` installs the packed plugin by name from a loopback
  registry).

## 0.3.0

- **Breaking (standalone proxy):** router environment variables are now
  prefixed with `JEV_ROUTER_`, with no legacy aliases. For example,
  `JEV_API_KEY` is now `JEV_ROUTER_API_KEY`, `JEV_PROXY_PORT` is now
  `JEV_ROUTER_PORT`, and `UPSTREAM_BASE_URL` is now
  `JEV_ROUTER_UPSTREAM_BASE_URL`. See `docs/environment.md`.
- **Breaking (standalone proxy):** `JEV_ROUTER_UPSTREAM_BASE_URL` is required;
  the proxy no longer defaults to a local gateway port.
- Configurable Jev retries and fallback (`maxRetries`, `fallbackMode`,
  `fallbackEffort` and their `JEV_ROUTER_*` equivalents). Decision events
  include `jev_attempts` and, on fallback, `fallback_source`.
- The README and example configuration now target any Responses
  API-compatible endpoint, with step-by-step setup and troubleshooting.
  Reference material moved to `docs/behavior.md` and `docs/verification.md`.

## 0.2.0

- Make the in-process OpenCode plugin the primary setup path, including Vercel
  AI Gateway configuration and model defaults.
- Pass through structurally valid Responses input items, including newer tool
  and reference types, while keeping router-specific validation and bounded Jev state.

## 0.1.0

- Initial packaged CLI for the Jev-powered Responses API proxy.
- In-process OpenCode plugin with generated Astra/Luna/Sol models, Responses routing,
  and optional metadata-only Jev decision logging.
- TypeSafe and Vercel AI Gateway classification, effort-update lineage replay,
  and request-level usage telemetry.
- Node 24 CI, packed-artifact smoke test, and version-tagged npm publishing.
