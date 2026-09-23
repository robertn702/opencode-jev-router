## Purpose

Allow a client to select supported execution models through one local router while preserving explicit authentication and model-local reasoning-effort fallback.

## ADDED Requirements

### Requirement: Configuration-free model availability
The router SHALL support all registered models without model-selection environment configuration. It MUST NOT provide singleton, custom-model, or deployment-allowlist configuration. `UPSTREAM_MODEL`, `UPSTREAM_MODELS`, and `ALLOWED_MODELS`, when present, SHALL cause a value-free startup error directing selection through request.model. An incompatible base-effort override MUST fail before contacting Jev or upstream services.

#### Scenario: Multi-model setup
- **WHEN** the router starts with valid upstream settings and no model environment variables
- **THEN** one router endpoint SHALL accept each exact model ID.

#### Scenario: No implicit model
- **WHEN** a request omits its model
- **THEN** the router SHALL return a local 400 rather than select Astra or another default.

#### Scenario: Unsupported model settings
- **WHEN** any of the three unsupported model configuration variables is present
- **THEN** startup SHALL fail before network calls with a diagnostic that identifies the variable without echoing its value.

### Requirement: Request-local model selection
The router SHALL resolve the requested registered model before classification and SHALL preserve that selection through rewriting, forwarding, and request telemetry. Missing, malformed, unknown, and pro model selections MUST receive a local 400 without Jev or generation calls.

#### Scenario: Concurrent models
- **WHEN** valid Astra and Luna requests overlap on the same endpoint
- **THEN** each outbound request SHALL retain its own resolved model and effort profile regardless of completion order.

#### Scenario: Rejected model
- **WHEN** a request names a model outside the capability registry
- **THEN** no classifier or upstream generation request SHALL occur.

### Requirement: Model-valid adaptive effort
Every selected, base, and fallback effort SHALL be valid for the resolved model profile. The router SHALL preserve a stable request-level base effort, remove previous reasoning updates, and append exactly one final configuration update with the selected effort. Existing standard-mode, truncation, and input-shape restrictions SHALL remain enforced.

#### Scenario: Unsupported classifier output
- **WHEN** Jev returns an effort outside the selected model's supported set
- **THEN** the router SHALL use the model-valid fallback path and report `jev_invalid_output` metadata.

#### Scenario: Valid selection
- **WHEN** Jev selects a supported effort
- **THEN** the outbound model SHALL match the resolved request model, the top-level effort SHALL equal the effective base, and the final input update SHALL carry the selected effort.

### Requirement: Model-local bounded fallback history
Fallback history SHALL be isolated by resolved model and usable client prompt-cache key. The configured cache capacity SHALL bound the total entries across models; TTL and eviction SHALL continue to apply. The upstream prompt-cache key MUST remain unchanged and MUST NOT be logged.

#### Scenario: Switching models with the same key
- **WHEN** Astra has a cached high effort under key K and Luna classification fails under K with no Luna history
- **THEN** Luna SHALL use its own default fallback rather than Astra's cached effort.

#### Scenario: Returning to a model
- **WHEN** a request returns to Astra under K before its successful entry expires or is evicted and classification fails
- **THEN** it SHALL reuse Astra's valid cached effort.

#### Scenario: Missing or expired history
- **WHEN** a usable key or unexpired valid same-model entry is absent
- **THEN** classification failure SHALL use the selected profile's default fallback without creating a fallback-history entry.

#### Scenario: Client cancellation
- **WHEN** the client disconnects during classification
- **THEN** the router SHALL neither store a new effort nor start upstream generation.

### Requirement: Shared connection and client configuration
Astra, Luna, and Sol SHALL be selectable under one `jev-router` provider using one base URL. Both auth policies SHALL apply identically to all registered models. Streaming, non-streaming responses, and same-model tool continuations SHALL preserve existing transport behavior. Model discovery SHALL remain upstream passthrough and documentation SHALL distinguish it from the capability registry.

#### Scenario: Router-owned credential
- **WHEN** any registered model is requested under bearer policy, with or without client authorization
- **THEN** only the configured router-owned credential SHALL be sent upstream.

#### Scenario: Client-owned credential
- **WHEN** any registered model is requested under forward policy
- **THEN** the client's authorization SHALL be forwarded to the configured permitted loopback upstream.

#### Scenario: Shared endpoint continuation
- **WHEN** a supported model returns a tool call and the client submits a valid same-model tool output
- **THEN** the router SHALL forward the continuation under that model with a fresh selected-effort update.

### Requirement: Honest compatibility evidence
Published support for each added model SHALL be backed by verified effort capabilities and live non-streaming, SSE, and tool-continuation evidence identifying the tested upstream. Verification records MUST retain metadata only, excluding prompts, outputs, credentials, and cache keys.

#### Scenario: Mock-only coverage
- **WHEN** a model's test passes only against a fake upstream
- **THEN** documentation SHALL describe it as offline coverage and SHALL NOT claim live compatibility.
