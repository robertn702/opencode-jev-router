# Verified behavior

Evidence behind the compatibility and cache claims in the [README](../README.md). Results describe the configuration used at the time.

## Anthropic live check

Anthropic cache and thinking-signature behavior has not been measured here.
With a funded Anthropic key and access to a supported model, opt in locally
(never in CI):

```bash
CACHE_PROVIDER=anthropic CACHE_LIVE=1 CACHE_ANTHROPIC_LIVE=1 JEV_ROUTER_ANTHROPIC_UPSTREAM_API_KEY=… JEV_ROUTER_ANTHROPIC_UPSTREAM_BASE_URL=https://api.anthropic.com/v1 npm run cache:validate
```

`CACHE_ANTHROPIC_MODEL` defaults to `claude-opus-5-5`; only the four registered
Claude IDs are accepted. The harness budgets at most 12 paid requests, prints
only usage/status and structural metadata, and compares warm-cache reuse across
low/high changes with a separate proxy's top-level effort control. It also checks
tool-result-only continuation at low/max and observes lineage-loss replay.
HTTP 400 on the lineage replay is reported, not masked. Run the default offline
`npm run cache:validate` first; see [Cache validation](cache-validation.md) for
env vars and limitations. Live results remain observational, not a cache guarantee.

## Cache preservation

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
with `low` effort and no fallback. See [Cache validation](cache-validation.md)
for reproduction, trial conditions, historical pilot results, and limitations.

## Model and client compatibility

The official [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and
[Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) pages document the
supported effort sets. The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)
documents configuration updates for the GPT-6 family in standard, single-agent mode.

Multi-model verification on Node 24.21.0 passed 90 offline tests and the build.
Live checks through a loopback Responses API-compatible gateway
with forwarded credentials returned HTTP 200 and completed for non-streaming,
SSE completion, and independent same-model tool continuations on all three models.
These checks used `scripts/verify-models.mjs`; incremental SSE is tested offline.
Actual OpenCode-client acceptance of all three selections and additional explicit
multi-model edge-case assertions remain pending. Direct bearer-auth live checks
were not run for this change.

The following results are historical Astra checks, not new Luna/Sol evidence.

Ran on Node 24.x (`npm run check`: 51 tests) with **OpenCode 1.18.32** and
a loopback Responses API-compatible gateway backed by a Codex subscription:

1. The actual OpenCode client emits array-form `POST /v1/responses` input and
   performs tool continuations through the proxy (shape-verified against a capture
   upstream, no prompts or credentials retained).
2. A live gateway request in Astra standard, single-agent mode accepted
   the historical strip/append placement and completed a real tool continuation.
3. A full-path OpenCode -> proxy -> gateway tool task completed with
   Jev enabled (tool executed, task finished).
4. Two live requests selected **different** Jev efforts (`low` and `high`) while
   the outbound model stayed `gpt-6-astra` and the top-level effort stayed
   `medium` in both.

What this proves: historical protocol compatibility, outbound model/effort
selection, and completed tool-using tasks. An effort update is needed when the
selected effort changes, before the next user message or tail tool continuation;
consecutive same-effort turns do not need another update. Cache-preservation
evidence under the current replay placement is measured in
[`cache-validation.md`](cache-validation.md).
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
