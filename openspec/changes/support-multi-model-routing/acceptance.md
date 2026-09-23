# Implementation verification

Node 24.21.0: `npm run check` passed (87 tests), `npm run build` passed,
and `git diff --check` passed. Offline coverage includes model-local fallback,
immutable profiles, out-of-order mixed-model requests, both authorization
policies, incremental SSE and independent same-model tool continuations.

## Live results

Tested configured upstream: `http://127.0.0.1:8317`, authorization `forward`.
Executed `scripts/verify-models.mjs` through one router and real Jev classifier.
Only metadata was retained. All entries below returned HTTP 200 and completed.

| Model | Non-streaming | SSE completion | Same-model tool continuation |
| --- | --- | --- | --- |
| gpt-6-astra | Passed | Passed | Passed |
| gpt-6-luna | Passed | Passed | Passed |
| gpt-6-sol | Passed | Passed | Passed |

This verifies the exact strip/append request shape. Live SSE checks verify
completion; incremental delivery/backpressure are tested offline. No claim is
made about internally applied effort or arbitrary cross-model continuation.
Direct bearer-auth upstream live checks were not run.

The local environment contained obsolete `UPSTREAM_MODEL`; the smoke script
excluded that setting in memory. Normal CLI startup correctly rejects it.

## Remaining acceptance work

- Execute the example using the actual OpenCode client for all three selections.
  The published current schema was inspected; its provider/model fields match
  the example. An actual OpenCode acceptance run remains pending.
- Add explicit multi-model TTL, delimiter-collision, cancellation-write and
  startup-process diagnostic assertions. Existing single-model expiry,
  cancellation and lifecycle tests pass, but do not establish every requested
  new combination.

The capability report's earlier "not run" entries describe the initial
documentation gate; this report supersedes those live-result statuses.
