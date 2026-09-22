# Implementation plan

## Goal

Ship a small Responses API proxy that lets OpenCode use Jev-selected reasoning effort while every execution request stays on `gpt-6-astra` through CLIProxyAPI.

```text
OpenCode -> local Jev proxy -> CLIProxyAPI -> Codex subscription
```

CLIProxyAPI is required for the first version. Keep `UPSTREAM_BASE_URL` configurable so a later release can support direct OpenAI API access or another Responses-compatible upstream without changing request classification.

## Required behavior

- Expose `POST /v1/responses` and `GET /v1/models` on localhost.
- Forward OpenCode's bearer credential to CLIProxyAPI without logging it.
- Rewrite every execution request to `model: gpt-6-astra`.
- Force a stable top-level `reasoning.effort`, initially `medium`.
- Ignore OpenCode reasoning variants for this provider.
- Support the array-form Responses `input` emitted by OpenCode. Reject unsupported shapes with a clear error.
- Build bounded Jev state from recent user text, assistant progress, tool results, and failure state.
- Ask Jev for one effort value from `low`, `medium`, `high`, `xhigh`, or `max`.
- Remove any existing reasoning `configuration_update` from the incoming input and append exactly one current update.
- Forward CLIProxyAPI's status, relevant headers, body, and SSE stream without buffering the completed response.
- Log request ID, selected effort, Jev latency, and fallback reason. Never log prompts, full payloads, or credentials.
- On classifier failure, reuse the previous effort keyed by `prompt_cache_key`. Fall back to `medium` when there is no usable key or prior value.

The injected item should be:

```json
{
  "type": "configuration_update",
  "reasoning": {
    "effort": "high"
  }
}
```

## Dependencies

Runtime:

- Node.js 20 or newer
- `@typesafe-ai/sdk`
- CLIProxyAPI with Codex OAuth and `gpt-6-astra` access
- `CLIPROXY_KEY` in the OpenCode process
- `TYPESAFE_API_KEY` in the proxy process

Development:

- TypeScript
- `tsx`
- `vitest`
- Native Node HTTP and fetch APIs

Avoid a web framework for the first version.

## Tests

1. The model is always rewritten to `gpt-6-astra`.
2. The top-level reasoning effort remains constant across classifications.
3. Exactly one valid `configuration_update` is appended.
4. A previous incoming reasoning update is removed before the current update is added.
5. Invalid Jev output reuses the previous effort or falls back to `medium`.
6. Prompt and credential data do not appear in logs.
7. SSE data from a fake upstream reaches the client incrementally.
8. OpenCode can list and call the model with `@ai-sdk/openai` and `useResponses: true`.
9. A live tool-using task completes through CLIProxyAPI.
10. Two live requests can select different effort levels while the forwarded model remains Astra.

## Timebox

- Minutes 0 to 10. Confirm the OpenCode request contract with a fake upstream and add the first failing rewrite test.
- Minutes 10 to 30. Implement model pinning, stable base effort, update injection, and HTTP forwarding.
- Minutes 30 to 45. Add the Jev call, bounded state, output validation, and fail-open behavior.
- Minutes 45 to 60. Add SSE pass-through and finish unit tests.
- Minutes 60 to 72. Run a real OpenCode to proxy to CLIProxyAPI smoke test.
- Minutes 72 to 82. Finish the README and configuration example.
- Minutes 82 to 90. Record a terminal demo and draft the X post.

## Stop rules

- At minute 15, stop if OpenCode does not emit a compatible array-form `/v1/responses` request. Do not fork OpenCode or its AI SDK provider during this spike.
- At minute 60, freeze features.
- At minute 72, do not publish the project as working unless a real tool-using request has completed through CLIProxyAPI.
- At minute 90, stop. Publish the working proof or keep the result labeled as an incomplete experiment.

## Out of scope

- OpenCode plugin
- npm publication
- Model routing
- Non-Astra execution models
- Direct OpenAI API-key support
- Direct ChatGPT OAuth handling
- Route leases
- Dashboard or persistent database
- WebSocket Responses transport
- `/responses/compact`
- Automatic installation
- Multi-user or production security

## Publication checklist

- Replace the scaffold status in the README with tested setup instructions.
- Include one OpenCode configuration example.
- Include one terminal recording or screenshot showing changing effort and a fixed model.
- Credit the prior projects that informed the design.
- Scan the repository and demo for credentials, prompt contents, local paths, and account identifiers.
- Draft the X post after the live check. Do not claim cache preservation until request logs or usage data support it.
