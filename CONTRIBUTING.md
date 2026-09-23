# Contributing

Thanks for helping improve `opencode-jev-router`! Please search existing issues
before opening a new one. For a behavior change, open an issue first so we can
agree on the upstream compatibility and expected wire behavior.

## Development

Use Node.js 24.x. Run `npm ci`, then `npm run check` and
`npm run smoke:package` before submitting a pull request. Tests use a fake
upstream and mocked Jev, so no credentials or paid API calls are needed.

Keep PRs focused, explain the observable behavior change, and include tests for
new compatibility cases or failure paths. Follow the protocol and privacy
invariants documented in [AGENTS.md](AGENTS.md): do not include prompts, tool
output, credentials, or raw upstream errors in telemetry or issue reports.

For a security issue, use the private reporting instructions in
[SECURITY.md](SECURITY.md) instead of a public issue.
