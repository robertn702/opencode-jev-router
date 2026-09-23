# Small paired agent evaluation (scaffold)

This scaffold compares GPT-6 Astra and Sol at fixed `medium`, fixed `high`, and
Jev-selected effort using the **same OpenCode plugin, upstream, base effort and
task checkout**. No benchmark tasks or live results are included yet. Select
and pin two independently graded tasks before making live comparisons.

## Task manifest

Populate `eval/tasks.json` with two tasks, for example:

```json
{
  "tasks": [{
    "id": "example-task",
    "repo": "/absolute/path/to/local/git/repository",
    "commit": "full-40-character-base-commit-sha",
    "prompt": "Task instructions visible to the agent",
    "grade": ["node", "--test", "test/acceptance.test.mjs"]
  }]
}
```

`grade` is an argv array, not a shell command. Its exit code determines success.
Use a pinned, independent grader; for SWE-bench, an adapter will need to submit
the saved patch to its container harness rather than run tests in the checkout.
Pin the dataset/harness revision and publish the selection rule and task IDs.
Check the reference solution against the grader before spending model runs.

## Prepare and run

Use Node 24, `npm ci && npm run build`, and an installed `opencode` CLI. Configure
`JEV_API_KEY` for the adaptive arm and `CLIPROXY_KEY` for every arm; the default
upstream is `http://127.0.0.1:8317/v1` (override with `UPSTREAM_BASE_URL`).
The baseline arms do not contact Jev. OpenCode config is generated for each
attempt and project config loading is disabled to avoid task-local overrides.

```bash
node eval/run.mjs --task example-task --model gpt-6-sol --arm medium --prepare-only
node eval/run.mjs --task example-task --model gpt-6-sol --arm medium
node eval/run.mjs --task example-task --model gpt-6-sol --arm high
node eval/run.mjs --task example-task --model gpt-6-sol --arm jev
```

Repeat for `gpt-6-astra`, ideally alternating arm order. Each attempt gets a
fresh detached task worktree and a new OpenCode session. Runs are sequential by
default; the CLI exits on idle. `--prepare-only` exercises worktree and config
creation without OpenCode, Jev or upstream calls. The runner removes task
worktrees in `finally`. Each run gets an ignored `eval/runs/<id>/` directory:
`result.json` (metadata/usage), `decisions.jsonl` (per-request router evidence),
`opencode.json` (generated config), `output.jsonl` (raw OpenCode events), and
`patch.diff` (agent changes). **Raw events and patches can contain task content**;
inspect/redact before publishing. Do not publish keys or complete private tasks.

`result.json` records grade status, elapsed time, request count, selected
efforts, fallback count and summed upstream usage. If any response lacks usage,
the corresponding total is `null`, not an estimated saving. Model output tokens
include billed reasoning tokens. Subscription usage is not a dollar-cost claim.
Two tasks per model × three arms = 12 attempts; this is a harness pilot, not a
statistically meaningful benchmark score.
