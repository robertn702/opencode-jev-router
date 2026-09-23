## Context

See proposal.md for motivation. `src/config.ts` currently produces one upstream model. The server validates against it before Jev, then the rewriter validates again and pins to it. `src/jev.ts` uses one static effort question and a bounded previous-effort cache keyed only by `prompt_cache_key`; on failure it returns a previous effort or hard-coded `medium`. `BASE_EFFORT` controls the request-level effort, not that fallback. Transport and authentication are already independent of model selection.

## Goals / Non-Goals

**Goals:** Resolve an immutable model profile per request; keep concurrent requests independent; retain explicit authentication and the current wire rewrite; make three models selectable through one provider.

**Non-Goals:** Automatic model selection, model aliases, per-model upstreams or credentials, cross-model server-side conversation migration, new input formats, and prompt-cache lineage preservation. Model-local cache means fallback-effort state, not stored responses or provider KV cache.

## Decisions

### 1. Request-driven selection without model configuration

All registered models are supported by default. OpenCode controls its selectable model list; the router registry defines protocol capabilities; upstream configuration defines execution location and credentials. Requests must name an exact registered model. No model is silently substituted when the field is absent.

Remove `UPSTREAM_MODEL` from configuration, CLI help, examples, and tests. Do not add `UPSTREAM_MODELS`, `ALLOWED_MODELS`, aliases, or an arbitrary custom-model escape hatch. There are no deployed users to migrate and no backward-compatibility requirement. Explicitly reject these three model configuration variables at startup with a value-free diagnostic directing users to select the model in requests, rather than silently ignoring a purported restriction.

Keep `BASE_EFFORT` as an optional global override. With no override, use each profile's default base. Reject an override unsupported by any registered profile. Fallback remains profile-defined and separate from base effort; Astra's fallback is `medium`.

Alternative: deployment allowlists or singleton compatibility. Rejected as unnecessary configuration for this undeployed package. Alternative: multiple processes. Rejected because model selection does not require separate transport or auth.

### 2. Resolve model once, then carry its profile through the request

Add `src/models.ts` with immutable profiles containing `id`, `supportedEfforts`, `defaultBaseEffort`, `fallbackEffort`, and `supportsConfigurationUpdate`. A request must contain an exact registered model ID; missing, non-string, pro, and unknown IDs fail locally before Jev or generation. No default substitution or silent downgrade occurs.

Pass the resolved profile explicitly to the selector and rewriter. Pin outbound `model` to that resolved ID, never a mutable process-wide current model. Preserve strip/append: request-level effort uses the effective base; exactly one final reasoning update carries the chosen effort. Existing mode, truncation, and input validation continue. Make error wording model-neutral.

Successful request telemetry uses the resolved model. Early overload/body-size evidence, where no model has been validated, uses an empty model rather than pretending the request targeted Astra. Do not log raw rejected model strings or add request data to evidence.

### 3. Capability-aware Jev selection

Generate the effort question from the resolved profile's allowed efforts; retain existing effort descriptions. Validate Jev's result against that same profile. Include the resolved model ID in bounded classification state so the selector knows its target. Invalid output follows the existing fallback path, never clamps silently to a different effort.

Astra's existing effort profile is the compatibility baseline. Luna and Sol effort sets, default base, fallback, and configuration-update acceptance require current official documentation and live verification before support is declared complete. Do not populate them by assuming every GPT-6 model is identical. If a target cannot support the required update mechanism, stop and revise this proposal rather than silently switching to top-level adaptive effort.

Alternative: one universal profile. Rejected because even a shared initial effort set should not permanently couple models' capabilities.

### 4. One bounded cache, model-scoped keys

Use a collision-safe tuple encoding such as `JSON.stringify([resolvedModel.id, promptCacheKey])` for internal fallback lookup and storage. Preserve the original upstream `prompt_cache_key` without rewriting it. Missing/blank keys disable history lookup and storage, as today.

Keep one global LRU capacity and TTL across all model/key pairs; per-model caches would multiply the configured memory bound. On Jev failure: use an unexpired same-model entry that is valid for the profile, otherwise the profile fallback. Cache successful decisions only; do not renew an entry because it was used as fallback. Client cancellation neither writes history nor starts generation. Concurrent successful requests for the same pair retain completion-order last-write-wins; no conversation sequencing is inferred.

This does not promise cache hits or preserved prompt prefixes. The existing strip/append update behavior remains unchanged.

### 5. One client provider and unchanged transport

The resulting setup is:

```dotenv
JEV_PROXY_PORT=4320
UPSTREAM_BASE_URL=http://127.0.0.1:8317/v1
UPSTREAM_AUTH=forward
```

For direct OpenAI, keep the same models and port; use the existing HTTPS base URL, bearer policy, and router-owned API key.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "jev-router": {
      "npm": "@ai-sdk/openai",
      "name": "Jev adaptive GPT-6",
      "options": {
        "apiKey": "{env:CLIPROXY_KEY}",
        "baseURL": "http://127.0.0.1:4320/v1"
      },
      "models": {
        "gpt-6-astra": { "name": "GPT-6 Astra with adaptive effort", "reasoning": true, "options": { "useResponses": true } },
        "gpt-6-luna": { "name": "GPT-6 Luna with adaptive effort", "reasoning": true, "options": { "useResponses": true } },
        "gpt-6-sol": { "name": "GPT-6 Sol with adaptive effort", "reasoning": true, "options": { "useResponses": true } }
      }
    }
  }
}
```

Replace the earlier separate-provider example during implementation. Auth substitution, passthrough HTTP errors, incremental SSE, backpressure, disconnect handling, deadlines, and global admission limits remain shared. Keep `/v1/models` as authenticated upstream passthrough to avoid adding discovery aggregation to this change; clearly state that its list is upstream inventory, not the local capability registry. A filtered discovery API can be a separate change.

## Risks / Trade-offs

- [Luna/Sol capabilities or account access differ] → Verify actual efforts and update support; distinguish local support from upstream entitlement in docs and smoke results.
- [Replayed encrypted reasoning or response IDs may be model-bound] → Guarantee request routing and independent same-model continuations; do not claim arbitrary cross-model continuation works. Preserve upstream errors rather than mutate opaque history.
- [One busy model evicts another's fallback state] → Accept global LRU sharing to preserve the existing total bound; fallback remains model-correct after eviction.
- [Global BASE_EFFORT may not suit all registered models] → Validate against every profile; profile defaults avoid requiring an override.

## Rollout

Update repository examples and local development settings to omit model environment variables. Use the single-provider example, restart the router and OpenCode, and verify each model independently through the same endpoint. No compatibility shim, deprecation period, or persisted cache migration is required.

Acceptance requires offline tests for all routing/auth/cache combinations and recorded live non-streaming, SSE, and tool-continuation results for each advertised model on a configured upstream. Record metadata only and identify the tested upstream; a mock test must not be reported as live compatibility evidence.
