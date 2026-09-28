# Cache-validation harness

`npm run cache:validate` is a bounded, metadata-only **offline** check of both OpenAI Responses and Anthropic Messages. It starts `createAppServer` with an injected deterministic selector and local fake upstreams; no Jev request, credential, or live model call occurs. The OpenAI fixed arm is `low, low, low, low, low`; the adaptive arm is `low, low, high, high, low`. Each arm receives a separate generated cache key, a complete warm pass, then a measured pass. Trial order alternates fixed/adaptive and adaptive/fixed.

The OpenAI arm sends a long stable prefix with stable top-level instructions and a stable tool definition. Every request ends with a current user item; the warm pass retains actual preceding upstream `output` only in memory, rather than fabricating an assistant item. The measured pass replays that same in-memory history, so each measured request is an exact retry of its warm counterpart. It uses the real proxy rewrite and forwarding path, records actual outbound update positions in memory, and outputs only metadata. It does not print or persist request bodies, tool output, responses, cache keys, credentials, or raw upstream errors.

This is deliberately a **controlled-classifier** harness: `selectEffort` is
injected, so its sequences are deterministic and it never calls Jev. In live
mode it uses the checked-out `createAppServer`, not an already-running router
deployment. A successful controlled live comparison therefore establishes the
wire/cache experiment, not that a particular deployment revision is running or
that real Jev made those choices. Check the deployment revision and its
metadata-only decision log separately; a real-Jev deployment run cannot promise
the fixed/adaptive effort arms and is observational evidence only.

## Run

```bash
npm run cache:validate
```

By default the OpenAI portion makes 43 requests (two trials, a tool-continuation pilot and missing-usage probe) and the Anthropic portion makes eight; two separate metadata JSON lines are printed. `CACHE_PROVIDER=openai` or `CACHE_PROVIDER=anthropic` selects just one provider. OpenAI bounds are `CACHE_TRIALS=1..3` and `CACHE_MAX_REQUESTS=23..60`; Anthropic always caps itself at 12 requests. To save the final JSON metadata report, set an absolute `CACHE_RESULTS_PATH`; with both offline providers the Anthropic report overwrites the OpenAI report, so select a provider to persist a single report. The file is owner-only. Keep reports in the ignored `cache-results/` directory (for example, `cache-results/issue21-live-node24-two-trial.json`). These are local artifacts and must not be committed. Reports contain only status, usage, and structural check metadata.

The Anthropic offline sequence runs a warm request, low/high follow-ups, a top-level effort control, a prompted tool use (`tool_choice: auto`, since these models reject forced tool choice), low/max tool-result-only continuations, and a deliberate lineage-loss replay. It checks outbound byte-prefix-preserving message extensions, fixed top-level `output_config.effort`, effort-only system updates before the newest user (including tool-result-only turns), and the `anthropic-beta` header. The fake upstream simulates the cache-control contrast and rejects a missing historical update with HTTP 400; these synthetic usage counts and simulated signature failure are **not** evidence of live Anthropic behavior.

For a live deployment, first complete the offline run, verify the running deployment contains the prefix-preserving rewrite, then explicitly opt in:

```bash
CACHE_LIVE=1 CACHE_CLIENT_AUTHORIZATION='Bearer …' JEV_ROUTER_UPSTREAM_BASE_URL=… JEV_ROUTER_UPSTREAM_AUTH=forward npm run cache:validate
```

For `JEV_ROUTER_UPSTREAM_AUTH=bearer`, also set `JEV_ROUTER_UPSTREAM_API_KEY`. Live forward mode uses `CLIPROXY_KEY` from `.env` (the same convention as `scripts/verify-models.mjs`); `CACHE_CLIENT_AUTHORIZATION` can explicitly override it. Neither is retained. The harness alone ignores a legacy `UPSTREAM_MODEL` after reporting `legacy_upstream_model_ignored: true`, because each harness request pins its model; it does not change the environment or running service, and normal router startup still rejects that setting. Live requests run through an in-process relay so the harness can inspect outbound placement while forwarding to the configured upstream. It does not alter account routing. Do not use it against an unapproved or production account without a request budget.

Anthropic live checks are separately opt-in and **must never run in CI**. With an approved funded account and access to the selected model:

```bash
CACHE_PROVIDER=anthropic CACHE_LIVE=1 CACHE_ANTHROPIC_LIVE=1 JEV_ROUTER_ANTHROPIC_UPSTREAM_API_KEY=… JEV_ROUTER_ANTHROPIC_UPSTREAM_BASE_URL=https://api.anthropic.com/v1 npm run cache:validate
```

`CACHE_ANTHROPIC_MODEL` defaults to `claude-opus-5-5` and accepts `claude-fable-5-1`, `claude-mythos-5-1`, `claude-opus-5-5`, or `claude-opus-5`. The Anthropic endpoint defaults to `https://api.anthropic.com/v1`; the key is forwarded as `x-api-key` through an in-process proxy and relay. The classifier is injected (no Jev connection is made; `JEV_API_KEY` and `JEV_BASE_URL` are only needed when running the real router). Eight paid requests are planned and 12 is a hard cap. The control uses a second proxy with a different fixed base effort so the router, rather than a raw upstream call, creates the top-level effort change. Cache reads of at least 2,000 tokens after a low/high effort change and zero for the top-level control are required. The lineage-loss replay intentionally drops a historical effort update and records whether the upstream returns 400; that outcome is observational, especially if `thinking_present` was false in the prior replies. A 200 cannot prove that signed thinking replay is safe. No prompts, tool contents, keys, signatures, or raw upstream error bodies appear in reports.

## Interpreting results

`reusable_prefix_bytes` and `reusable_prefix_items` are exact common-prefix measurements of serialized outbound **input items**. They are not rendered-token counts, billed tokens, or a claim that the upstream cache hit. Compare `cached_input_tokens` with both eligible prefix measures and total `input_tokens`; the summary's `mean_cached_to_input_ratio` is the only token-to-token ratio. Do not divide prefix bytes or items by tokens. A positive cache count alone is not success. The relevant result is whether the adaptive arm has systematic additional eligible-prefix loss or lower cached-token reuse than the fixed arm under the same warm-up, model, instructions, tools, routing, and trial conditions.

`cached_input_tokens: null` means the upstream did not supply usable usage; it is not zero. A real zero is distinct. Cache availability may still vary with provider routing, eviction, expiry, and account policy, so repeated alternating trials are required before attributing a difference to effort changes.

The comparison arms prove controlled user-followup eligibility, not tool continuation placement. A separate two-request pilot forces `stable_lookup`, retains the actual returned function call in memory, and submits its matching `function_call_output`; its metadata-only result is in `tool_continuations`. The user-followup result must not be cited as proof of that tool placement. Offline pilot output is only fake-upstream wiring evidence; a live pilot is meaningful only when it reports `function_call_observed: true` and a successful continuation. Expected lineage resets include edited/compacted history, branches, changed model/instructions/tools, cache-key changes, expiry, eviction, concurrency pressure, and router restart when history is in memory.

Each measured record includes `warm_exact_request_eligible` and
`prefix_fully_stable`, in addition to its byte/item prefix measures. The protocol
checks compare the effective outbound update-effort sequence with the selected
transition sequence (identical consecutive efforts do not add a new transition)
and compare the warm and measured exact retries for byte-for-byte idempotence.
Either failure blocks a live run.

## Results and reproducibility status

An initial controlled live pilot ran on 2026-09-23 through the configured loopback upstream on **Node 22.23.2**: one alternating trial, 22 requests (including the tool pilot), all HTTP 200, with placement/effective-effort/retry/tool checks passing. Its local, ignored metadata-only artifact is `cache-results/issue21-live-pilot.json` (not committed). Fixed-arm mean cached input was 3072 tokens (ratio 0.965); adaptive was 2432 (ratio 0.764), including one zero-cache adaptive request. It is retained as Node-22-only exploratory evidence.

The Node-24 repeat ran on 2026-09-23 using `npx --package=node@24` (**v24.21.0**): two alternating trials, 42 live requests (including one tool pilot), all HTTP 200, with placement/effective-effort/retry/tool checks passing. Its local, ignored metadata-only artifact is `cache-results/issue21-live-node24-two-trial.json` (not committed). Both arms averaged 2765 cached input tokens; cached/input ratios were 0.869 fixed and 0.868 adaptive. Each arm had one isolated zero-cache request, while all recorded measured retries were exact-eligible and all noninitial prefixes were fully stable. On this limited sample there is no systematic additional adaptive cache loss; it demonstrates variability, not cache-hit guarantees. The run used base Git revision `b5ea81e` with the then-uncommitted prefix-preservation implementation in the working tree, and an in-process server. No running deployment revision was verified. A separate Node-24 real-Jev smoke completed HTTP 200 with selected `low` and no fallback. The offline fake-upstream run validates harness wiring only; its synthetic usage does not demonstrate upstream cache behavior.

For ongoing monitoring, query metadata-only decision logs by request correlation and compare `cached_input_tokens / input_tokens` alongside reusable prefix bytes and item counts, grouped by model, selected effort, and lineage status. Exclude null usage rather than treating it as zero.

## Scope of the cache guarantee

The Anthropic Messages path is implemented but its live cache behavior against
the Anthropic API is unmeasured. On 2026-09-28 the live Anthropic arm ran through
a local Meridian 1.76.5 proxy (Claude Agent SDK, not the raw Messages API) with
`claude-opus-5-5`: eight requests, all HTTP 200, with placement, prefix, beta
header, and tool-result-only continuation checks passing. Meridian rebuilds each
request through Claude Code and uses the top-level `output_config.effort` when
present, so that run shows wire compatibility only: its cache counts are
Meridian's, the top-level control still read the cache, and the selected
mid-conversation effort is not applied there. Its offline fake-upstream checks do not establish Anthropic cache reuse or live tool-continuation acceptance.
It measures prefix eligibility for one OpenAI Responses upstream, and
the result depends on how that upstream accepts an effort change. Here it works
because OpenAI exposes a mid-conversation reasoning change as a
`configuration_update` input item: effort is request-level configuration on a
fixed model ID, so an update can be appended after the cached prefix. That is
OpenAI-specific and does not generalize. Providers that render effort into the
prompt behave differently: Anthropic invalidates cached message blocks on a
top-level `output_config.effort` change and preserves the prefix only when effort
changes ride in a mid-conversation `system` message (a beta on selected models),
while Gemini and xAI expose thinking level or `reasoning_effort` as request
configuration without a documented cross-effort guarantee. Pointing this router at
a non-OpenAI upstream requires re-measuring its cache behavior rather than
inheriting these results.

No provider shares a prompt cache across different models: the cache is KV state
produced by one model's weights over one model's tokenization, so a model switch is
always a cold prefix, even between adjacent versions of the same family. Cache
lineage here is keyed on `[resolved model ID, prompt_cache_key]` and resets when the
resolved model changes for that reason; the model in the key is required for
correctness, not arbitrary.
