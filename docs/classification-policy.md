# Classification retries and fallback

Hosted Jev defaults to one additional retry, then fixed **high** effort. The
hosted classifier retries connection failures, SDK timeouts, HTTP 429 and HTTP
5xx. Authentication errors, other 4xx responses, and invalid classifier output
are not retried. SDK-level retries remain disabled to avoid multiplying
attempts. Exponential backoff with jitter starts at approximately 200 ms;
Retry-After is respected within the total classification deadline.

Local Laya performs one in-process inference attempt. Model-load failure,
inference failure, invalid typed output, and timeout use the same fallback modes
and decision metadata as hosted Jev. Client cancellation never falls back.
Because the ONNX API cannot interrupt an inference already running, a timed-out
or cancelled call's late result is ignored.

| Plugin option | CLI environment | Default |
| --- | --- | --- |
| `maxRetries` | `JEV_ROUTER_MAX_RETRIES` | 1 (0–10 additional attempts) |
| `fallbackMode` | `JEV_ROUTER_FALLBACK_MODE` | `fixed` |
| `fallbackEffort` | `JEV_ROUTER_FALLBACK_EFFORT` | `high` |
| `jevTimeoutMs` | `JEV_ROUTER_CLASSIFICATION_TIMEOUT_MS` | 4000, total budget including backoff |

Modes: `fixed` uses the configured effort; `previous` uses the last successful
selection for the same credential/model/cache context, otherwise the configured
effort; `error` returns a local 502 `jev_classification_failed` without starting
upstream generation. Client cancellation always aborts and never falls back.

New SWE-bench Jev attempts use three additional retries, a 10-second total
budget, and `fallbackMode: "error"`. A recorded classification failure makes
the attempt incomplete (grade stays null), even if the client later retries.
These runs must not be silently pooled with historical fallback-enabled runs.
Saved old results are unchanged. The generated per-run config records policy.

Decision metadata includes `jev_attempts` and, when falling back,
`fallback_source` (`fixed` or `previous`). Failed closed requests emit
`outcome: "classification_failed"` with no selected effort. No prompt or raw
provider error content is logged.

Rebuild before using the changed local plugin and restart OpenCode to load it.
