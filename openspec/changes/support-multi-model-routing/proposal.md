## Why

OpenCode should select Astra, Luna, or Sol through one provider and one router process. The current singleton execution-model setting forces separate instances, while the fallback-effort cache can mix model histories when a conversation changes models.

## What Changes

- Resolve the requested model against the built-in capability registry before classification; all registered models are available by default.
- Remove `UPSTREAM_MODEL`; introduce no `UPSTREAM_MODELS` or `ALLOWED_MODELS` setting. Backward compatibility is not required for this undeployed package.
- Keep one upstream endpoint and authorization policy for all enabled models.
- Define model capability profiles for allowed efforts, base effort, fallback effort, and configuration-update support.
- Scope fallback-effort history to the selected model and client cache key, within the existing global capacity and TTL.
- Put Astra, Luna, and Sol under the single `jev-router` OpenCode provider.
- Preserve model discovery passthrough; document that upstream discovery is not the router capability registry.
- Verify Luna and Sol capabilities before publishing support claims.

## Capabilities

### New Capabilities

- `multi-model-routing`: Explicit model selection, compatibility, model-local fallback state, and a single-provider client setup.

### Modified Capabilities

None; this repository has no existing OpenSpec capability specifications.

## Impact

Changes will touch configuration, validation, rewriting, server/classifier interfaces, cache-key construction, telemetry call sites, offline tests, README, `.env.example`, CLI help, and `examples/opencode.jsonc`. No new runtime dependency is intended. The AGENTS.md singleton-pinning guidance must be updated to describe pinning to the resolved request model. This proposal does not introduce automatic model selection, upstream-account routing, or prompt-cache lineage preservation.
