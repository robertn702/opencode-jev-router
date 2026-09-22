# opencode-jev

Adaptive reasoning effort for OpenCode while keeping execution on one model and one cache lineage.

This repository is an initial scaffold. The planned request path is:

```text
OpenCode -> opencode-jev -> CLIProxyAPI -> GPT-6 Astra
```

`opencode-jev` will inspect each OpenAI Responses request, ask [Jev](https://typesafe.ai/) for the appropriate reasoning effort, pin execution to `gpt-6-astra`, and append an Astra `configuration_update` item before forwarding the request.

The first version targets [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) so OpenCode can continue using a Codex subscription. Direct API authentication and other upstreams can be added later.

## Current status

The scaffold has a local HTTP server, a health endpoint, TypeScript configuration, and tests. Adaptive request handling is not implemented yet. The implementation plan is in [`scratch/plan.md`](scratch/plan.md).

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run check
npm start
curl http://127.0.0.1:4320/health
```

## Prior art

The design is informed by:

- [0xNatoshi/jev-codex-router](https://github.com/0xNatoshi/jev-codex-router)
- [mejiasd3v/pi-jev-router](https://github.com/mejiasd3v/pi-jev-router)

No code has been copied from either project.

## License

MIT
