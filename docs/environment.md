# Router environment namespace

Use `JEV_ROUTER_*` variables for router configuration and `JEV_API_KEY` /
`JEV_BASE_URL` for the default hosted Jev classifier; `.env.example` lists the
supported names. `JEV_ROUTER_API_KEY` and `JEV_ROUTER_BASE_URL` are rejected.
This beta migration is breaking: old environment names are no longer supported.

`JEV_ROUTER_CLASSIFIER_BACKEND` is explicit and accepts `jev` (the default) or
`laya`. The local Laya backend does not read or send a Jev credential. Optional
`JEV_ROUTER_LAYA_MODEL_DIR` points to an existing ONNX bundle;
`JEV_ROUTER_LAYA_CACHE_DIR` changes the download cache. Without a model directory,
the first classified request downloads about 1.7 GB and caches it under
`~/.cache/receptron-laya`; the loaded model needs roughly 2 GB RAM plus a few
hundred MB per batch.

`JEV_API_KEY` is a TypeSafe credential when the base URL is omitted
(default `https://api.typesafe.ai`). A Vercel Gateway credential also requires
`JEV_BASE_URL=https://ai-gateway.vercel.sh/typesafe`. No key inspection
or automatic endpoint detection occurs.

The optional `POST /v1/messages` route needs
`JEV_ROUTER_ANTHROPIC_UPSTREAM_BASE_URL` (for example
`https://api.anthropic.com/v1`); without it the route returns 404. In
`JEV_ROUTER_UPSTREAM_AUTH=bearer` mode also set
`JEV_ROUTER_ANTHROPIC_UPSTREAM_API_KEY` (sent as `x-api-key`). In `forward`
mode only a loopback Anthropic upstream is allowed; client `x-api-key` and/or
`authorization` are forwarded. The plugin instead wraps an existing Anthropic
model via `wrap.anthropic` and reuses its provider's route and key.

`JEV_PROXY_PORT` becomes `JEV_ROUTER_PORT`; `JEV_TIMEOUT_MS` becomes
`JEV_ROUTER_CLASSIFICATION_TIMEOUT_MS`. All upstream, base effort, limit,
cache and shutdown variables gain `JEV_ROUTER_`. Historical eval reports
describe the configuration used at the time and are not migration examples.
