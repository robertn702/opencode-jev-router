# Working on this repo

This project provides both a standalone local Responses API proxy and an
in-process OpenCode plugin. Jev selects reasoning effort; a shared upstream
runs the requested GPT-6 model. `README.md` documents both paths and their
wire behavior; `examples/opencode.jsonc` shows the plugin configuration.

## Commands

Use Node.js 24.x from the repo root.

| Task | Command |
| --- | --- |
| Install dependencies | `npm ci` |
| Typecheck and run offline tests | `npm run check` |
| Run a focused test | `npx vitest run test/rewrite.test.ts` |
| Build the CLI in `dist/` | `npm run build` |
| Smoke-test the plugin | `npm run smoke:plugin` |
| Watch source changes | `npm run dev` |

The tests use a fake upstream and mocked Jev; they need no API keys. To run the
real proxy, copy `.env.example` to `.env`, set `JEV_API_KEY`, start
CLIProxyAPI, then run `npm run build && npm start`. The plugin instead loads in
OpenCode and connects directly to the configured upstream. OpenCode needs
`CLIPROXY_KEY` when using CLIProxyAPI with the example configuration.
`npm run eval:live` calls external services.

## Behavior to preserve

- `src/models.ts` and `src/rewrite.ts`: Pin the outbound model to the resolved
  request profile. Keep request-level `reasoning.effort` at the profile default
  or validated `BASE_EFFORT` override, preserve historical reasoning updates in
  their original positions, and insert Jev's selected update before the next user
  message, or after tool results for a continuation without a new user message
  (never adjacent to another update). This follows OpenAI's reasoning
  continuation guidance and preserves an eligible prefix, not a guaranteed cache
  hit; the reported response effort is not the selected effort. Usage observation
  must not alter streaming bytes or backpressure.
- `src/validate.ts` and `src/server.ts`: Reject unsupported modes, truncation,
  and input shapes with a local 400 before calling Jev or the upstream.
- `src/jev.ts` and `src/server.ts`: Jev timeout or failure may fall back to a
  validated effort. Client disconnect must instead abort work without starting
  upstream generation.
- `src/forward.ts` and `src/headers.ts`: Preserve upstream status/body passthrough,
  incremental SSE with backpressure, and header filtering. `src/evidence.ts` logs
  metadata only: no prompts, tool output, credentials, or raw upstream errors.
- `src/plugin.ts` and `src/router.ts`: The plugin shares classification and
  rewriting with the proxy. Optional plugin `decisionsLogPath` and CLI
  `JEV_DECISIONS_LOG_PATH` both write metadata-only `JevDecision` events using
  shared formatting; the CLI also prints request evidence to stdout. Log failure
  must never affect generation. Do not infer a selected effort from OpenCode's
  provider or reported response effort alone.

## Worktree setup

Orca waits for `scripts/setup.sh` (`orca.yaml`). The script installs dependencies
and carries local environment files and optional links into a new worktree
without overwriting existing files. If you change setup behavior, run
`node --test scripts/verify-setup.mjs`.
