# Changelog

## Unreleased

- **Breaking (standalone proxy):** router environment variables are now
  prefixed with `JEV_ROUTER_`, with no legacy aliases. For example,
  `JEV_API_KEY` is now `JEV_ROUTER_API_KEY`, `JEV_PROXY_PORT` is now
  `JEV_ROUTER_PORT`, and `UPSTREAM_BASE_URL` is now
  `JEV_ROUTER_UPSTREAM_BASE_URL`. See `docs/environment.md`.
- **Breaking (standalone proxy):** `JEV_ROUTER_UPSTREAM_BASE_URL` is required;
  the proxy no longer defaults to a local gateway port.
- Configurable Jev retries and fallback (`maxRetries`, `fallbackMode`,
  `fallbackEffort` and their `JEV_ROUTER_*` equivalents).
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
