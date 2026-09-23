# Cache-validation harness

`npm run cache:validate` is a bounded, metadata-only **offline** check. It starts `createAppServer` with an injected deterministic selector and a local fake upstream; no Jev request, credential, or live model call occurs. The fixed arm is `low, low, low, low, low`; the adaptive arm is `low, low, high, high, low`. Each arm receives a separate generated cache key, a complete warm pass, then a measured pass. Trial order alternates fixed/adaptive and adaptive/fixed.

The harness sends a long stable prefix with stable top-level instructions and a stable tool definition. Every request ends with a current user item; the warm pass retains actual preceding upstream `output` only in memory, rather than fabricating an assistant item. The measured pass replays that same in-memory history, so each measured request is an exact retry of its warm counterpart. It uses the real proxy rewrite and forwarding path, records actual outbound update positions in memory, and outputs only metadata. It does not print or persist request bodies, tool output, responses, cache keys, credentials, or raw upstream errors.

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

Defaults are two trials plus a two-request tool-continuation pilot and offline missing-usage probe (43 total requests, including warm-up). Bounds are `CACHE_TRIALS=1..3` and `CACHE_MAX_REQUESTS=23..60`. To save the final JSON metadata report, set an absolute `CACHE_RESULTS_PATH`; the file is owner-only. Keep reports in the ignored `cache-results/` directory (for example, `cache-results/issue21-live-node24-two-trial.json`). These are local artifacts and must not be committed. The report includes status, selected effort, upstream usage (null when absent), proxy request/session/turn correlations, replay/update positions, and reusable-prefix byte/item measurements.

For a live deployment, first complete the offline run, verify the running deployment contains the prefix-preserving rewrite, then explicitly opt in:

```bash
CACHE_LIVE=1 CACHE_CLIENT_AUTHORIZATION='Bearer …' UPSTREAM_BASE_URL=… UPSTREAM_AUTH=forward npm run cache:validate
```

For `UPSTREAM_AUTH=bearer`, also set `UPSTREAM_API_KEY`. Live forward mode uses `CLIPROXY_KEY` from `.env` (the same convention as `scripts/verify-models.mjs`); `CACHE_CLIENT_AUTHORIZATION` can explicitly override it. Neither is retained. The harness alone ignores a legacy `UPSTREAM_MODEL` after reporting `legacy_upstream_model_ignored: true`, because each harness request pins its model; it does not change the environment or running service, and normal router startup still rejects that setting. Live requests run through an in-process relay so the harness can inspect outbound placement while forwarding to the configured upstream. It does not alter account routing. Do not use it against an unapproved or production account without a request budget.

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

This harness measures prefix eligibility for one OpenAI Responses upstream, and
the result depends on how that upstream accepts an effort change. Here it works
because OpenAI exposes a mid-conversation reasoning change as a
`configuration_update` input item: effort is request-level configuration on a
fixed model ID, so an update can be appended after the cached prefix. That is
OpenAI-specific and does not generalize. Providers that render effort into the
prompt behave differently: Anthropic invalidates cached message blocks on a
top-level `output_config.effort` change and preserves the prefix only when effort
changes ride in a mid-conversation `system` message (a beta on selected models),
and Gemini and xAI expose thinking level or `reasoning_effort` as request
configuration without a documented cross-effort guarantee. Pointing this router at
a non-OpenAI upstream requires re-measuring its cache behavior rather than
inheriting these results.

No provider shares a prompt cache across different models: the cache is KV state
produced by one model's weights over one model's tokenization, so a model switch is
always a cold prefix, even between adjacent versions of the same family. Cache
lineage here is keyed on `[resolved model ID, prompt_cache_key]` and resets when the
resolved model changes for that reason; the model in the key is required for
correctness, not arbitrary.
