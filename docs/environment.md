# Router environment namespace

Use `JEV_ROUTER_*` variables for router configuration and `JEV_API_KEY` /
`JEV_BASE_URL` for the Jev classifier; `.env.example` lists the supported
names. `JEV_ROUTER_API_KEY` and `JEV_ROUTER_BASE_URL` are rejected. Plugin option names are unchanged. This beta migration
is breaking: old environment names are no longer supported.

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
`authorization` are forwarded. Plugin equivalents are
`anthropicUpstreamBaseURL` and `anthropicUpstreamApiKey`; either option (or an
explicit `jev-router-anthropic` provider) enables the second provider.

`JEV_PROXY_PORT` becomes `JEV_ROUTER_PORT`; `JEV_TIMEOUT_MS` becomes
`JEV_ROUTER_CLASSIFICATION_TIMEOUT_MS`. All upstream, base effort, limit,
cache and shutdown variables gain `JEV_ROUTER_`. Historical eval reports
describe the configuration used at the time and are not migration examples.
