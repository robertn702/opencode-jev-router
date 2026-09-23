# Working on this repo

This is a local Responses API proxy: OpenCode sends requests here, Jev selects
reasoning effort, and CLIProxyAPI runs them on Astra. `README.md` documents the
wire behavior; `examples/opencode.jsonc` shows the client configuration.

## Commands

Use Node.js 24.x from the repo root.

| Task | Command |
| --- | --- |
| Install dependencies | `npm ci` |
| Typecheck and run offline tests | `npm run check` |
| Run a focused test | `npx vitest run test/rewrite.test.ts` |
| Build the CLI in `dist/` | `npm run build` |
| Watch source changes | `npm run dev` |

The tests use a fake upstream and mocked Jev; they need no API keys. To run the
real proxy, copy `.env.example` to `.env`, set `TYPESAFE_API_KEY`, start
CLIProxyAPI, then run `npm run build && npm start`. OpenCode needs `CLIPROXY_KEY`.
`npm run eval:live` calls external services.

## Behavior to preserve

- `src/rewrite.ts`: Pin the outbound model. Keep request-level
  `reasoning.effort` at `BASE_EFFORT`. The server's bounded lineage ledger replays
  historical updates at their original positions and appends effort changes.
  Preserve matched prefixes; reset lineage on unmatched history. Reported
  response effort is not the selected effort. Usage observation must not alter
  streaming bytes or backpressure.
- `src/validate.ts` and `src/server.ts`: Reject unsupported modes, truncation,
  and input shapes with a local 400 before calling Jev or the upstream.
- `src/jev.ts` and `src/server.ts`: Jev timeout or failure may fall back to a
  validated effort. Client disconnect must instead abort work without starting
  upstream generation.
- `src/forward.ts` and `src/headers.ts`: Preserve upstream status/body passthrough,
  incremental SSE with backpressure, and header filtering. `src/evidence.ts` logs
  metadata only: no prompts, tool output, credentials, or raw upstream errors.

## Worktree setup

Orca waits for `scripts/setup.sh` (`orca.yaml`). The script installs dependencies
and carries local environment files and optional links into a new worktree
without overwriting existing files. If you change setup behavior, run
`node --test scripts/verify-setup.mjs`.
