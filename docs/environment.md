# Router environment namespace

Use `JEV_ROUTER_*` variables for router configuration; `.env.example` lists
the supported names. Plugin option names are unchanged. This beta migration
is breaking: old environment names are no longer supported.

`JEV_ROUTER_API_KEY` is a TypeSafe credential when the base URL is omitted
(default `https://api.typesafe.ai`). A Vercel Gateway credential also requires
`JEV_ROUTER_BASE_URL=https://ai-gateway.vercel.sh/typesafe`. No key inspection
or automatic endpoint detection occurs.

`JEV_PROXY_PORT` becomes `JEV_ROUTER_PORT`; `JEV_TIMEOUT_MS` becomes
`JEV_ROUTER_CLASSIFICATION_TIMEOUT_MS`. All upstream, base effort, limit,
cache and shutdown variables gain `JEV_ROUTER_`. Historical eval reports
describe the configuration used at the time and are not migration examples.
