# Capability verification

Checked 2026-09-23. These are documentation findings, not live compatibility
results. No upstream generation requests were made during this verification.

| Exact model | Documented reasoning efforts | Documented API default | Reasoning configuration updates | Live verification |
| --- | --- | --- | --- | --- |
| `gpt-6-astra` | `low`, `medium`, `high`, `xhigh`, `max` [1] | Not established by the cited model page | Supported in standard, single-agent mode [4] | Not run |
| `gpt-6-luna` | `none`, `low`, `medium`, `high`, `xhigh`, `max` [2] | `medium` [2] | Supported in standard, single-agent mode [4] | Not run |
| `gpt-6-sol` | `none`, `low`, `medium`, `high`, `xhigh`, `max` [3] | `medium` [3] | Supported in standard, single-agent mode [4] | Not run |

## Sources

1. [GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra).
2. [GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna).
3. [GPT-6 Sol model](https://developers.openai.com/api/docs/models/gpt-6-sol).
4. [Reasoning: change reasoning mid-conversation](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation).
5. [GPT-6 model guidance](https://developers.openai.com/api/docs/guides/latest-model).

The current reasoning guide explicitly states: “Configuration updates are
supported by the GPT-6 model family in standard, single-agent mode. They change
only reasoning effort.” The current model guidance names Astra, Sol, and Luna
as that family and recommends configuration updates when changing effort.

Context7 queries and indexed page extraction returned some older GPT-5.6 and
Astra-only guidance. Direct retrieval of the current official reasoning and
model-guidance pages established family-wide update support. Do not treat the
older indexed excerpts as evidence of a restriction to Astra.

## Protocol limits

The reasoning guide says adjacent configuration updates are rejected and updates
must not be combined with automatic compaction or automatic truncation. The
standalone compact endpoint also rejects histories containing updates. The
reported response effort remains the request-level setting, not the selected
update effort.

The guide recommends retaining updates in their original positions for prompt
cache preservation. The approved router design intentionally strips old updates
and appends one final update; this record makes no cache-lineage claim. Live
tests must verify that exact outbound shape for each model.

API defaults are distinct from router base and fallback policy. This evidence
does not establish arbitrary cross-model replay of encrypted reasoning or
previous response IDs. Required live continuation checks remain same-model.

## Live acceptance status

| Model | Non-streaming | Incremental SSE | Same-model tool continuation | Tested upstream |
| --- | --- | --- | --- | --- |
| `gpt-6-astra` | Not run | Not run | Not run | None |
| `gpt-6-luna` | Not run | Not run | Not run | None |
| `gpt-6-sol` | Not run | Not run | Not run | None |

Credential availability and upstream access have not been assessed. These checks
are pending, not recorded as access failures or successful compatibility tests.
