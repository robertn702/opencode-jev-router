## 1. Model profiles and configuration

- [x] 1.1 Verify official Luna/Sol effort and configuration-update documentation; deliver a cited capability table distinguishing documented support from live results, and stop for design revision if either model lacks the required update mechanism. See capabilities.md; live results remain pending.
- [x] 1.2 Add immutable registered model profiles, remove singleton configuration and reject UPSTREAM_MODEL, UPSTREAM_MODELS, and ALLOWED_MODELS; verify all three models work without model settings, obsolete settings fail clearly, and unknown/pro models and incompatible BASE_EFFORT are rejected.
- [ ] 1.3 Provide credential-free startup diagnostics for new configuration failures; verify invalid setups exit before classifier/upstream calls and diagnostics contain no supplied key or URL values.

## 2. Request-local execution and effort

- [x] 2.1 Resolve the registered model before classification and pass its profile explicitly through validation, selection, and rewriting; verify all three exact model IDs, local rejection of missing/unknown models, and unchanged strip/append behavior.
- [ ] 2.2 Build profile-specific Jev choices and validate returned efforts; verify unsupported output, timeout, and error fallback always use a supported effort and preserve Astra defaults.
- [ ] 2.3 Scope successful-effort history by model/key tuples within the global LRU/TTL; verify same-key model switching and returning, tuple-collision cases, expiry, total capacity, missing keys, fallback non-renewal, and cancellation without writes.
- [ ] 2.4 Record resolved models in request evidence and empty model values for pre-validation resource rejections; verify telemetry excludes prompts, tool outputs, credentials, raw rejected model strings, and cache keys.

## 3. Integration and client setup

- [x] 3.1 Add fake-upstream integration coverage for concurrent mixed-model requests, both authorization policies, non-streaming, incremental SSE, and same-model tool continuations; verify requests retain their own models and effort updates regardless of completion order.
- [ ] 3.2 Consolidate examples/opencode.jsonc into one provider and endpoint with three model entries; verify the current OpenCode schema and parsed configuration, with no model environment settings required.
- [ ] 3.3 Update README, .env.example, CLI help, and AGENTS.md for request-local model pinning, removal of model configuration, fallback-cache semantics, discovery passthrough, and protocol limits; verify documented configuration combinations against config tests.

## 4. End-to-end verification

- [x] 4.1 Run npm run check, npm run build, and git diff --check; verify all existing transport/lifecycle regressions and new multi-model tests pass.
- [x] 4.2 Run live non-streaming, SSE, and same-model tool-continuation checks for each advertised model on the configured upstream; retain only metadata identifying model, upstream mode, outcome, and test type, and mark unavailable combinations unverified.
- [ ] 4.3 Exercise the single-provider example in OpenCode against one router process; verify each of the three model selections targets the correct upstream model and complete a metadata-only acceptance summary.
