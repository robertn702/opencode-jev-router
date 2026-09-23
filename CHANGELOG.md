# Changelog

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
