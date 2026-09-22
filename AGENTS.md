# Development

Use Node.js 24.x. Run `npm ci` to install dependencies and `npm run check` to
typecheck and test the project. `npm run build` produces `dist/`.

Orca runs `./scripts/setup.sh` from `orca.yaml` and waits for it to finish before
starting an agent. The script installs dependencies with `npm ci`, copies local
`.env*` files from the main checkout into a new worktree (excluding
`.env.example`), and creates `.env` from the example if needed. If present, it
links `.scratch/shared` and `AGENTS.local.md`. Existing local files are preserved.
Set `TYPESAFE_API_KEY` in `.env` before running the proxy.

Verify the worktree setup with `node --test scripts/verify-setup.mjs`.
