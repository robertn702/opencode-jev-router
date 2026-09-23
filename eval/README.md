# Small paired agent evaluation (scaffold)

This pilot compares GPT-6 Astra and Sol at fixed `medium`, fixed `high`, and
Jev-selected effort using the **same OpenCode plugin, upstream, base effort and
task checkout**. No live results are included yet.

## Task manifest

`eval/tasks.json` pins two [SWE-bench Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)
instances, their public repository URLs, base commits, and original issue
statements: `pallets__flask-5014` (human-labeled `<15 min fix`, one failing test)
and `django__django-15957` (human-labeled `1-4 hours`, four failing tests).
Selection rule: one short, mechanical issue and one longer, multi-step ORM
issue from different repositories, both human-verified and with concise issue
descriptions. These two selected cases are not a representative benchmark
score; their difficulty labels do not predict Jev's decisions. The dataset is pinned to revision
`78f471bf655a3137b2e8a75af1501690ec009ec3`. The generated two-row
dataset is checked against `eval/swebench-verified-pilot.sha256` before grading.

The runner fetches only each pinned base commit into a new shallow Git store,
then creates the agent's worktree. Later fixes are not present in local history.
The agent is given the dataset's problem statement, not its test patch or gold
patch. Internet access could still expose public solutions; report this
limitation when interpreting results. The grader and agent run as the same OS
user; this pilot assumes non-adversarial agents and is not sandboxed against
deliberate benchmark gaming.

For custom tasks the runner also accepts local repositories and an external
grader argv, for example:

```json
{
  "tasks": [{
    "id": "example-task",
    "repo": "/absolute/path/to/local/git/repository",
    "commit": "full-40-character-base-commit-sha",
    "prompt": "Task instructions visible to the agent",
    "grade": ["/absolute/path/to/trusted-grader"]
  }]
}
```

Custom `grade` is an argv array beginning with an absolute executable outside
the task repo. The built-in `"swebench"` grader submits the saved patch to
the official Docker harness and reads its per-instance resolved report. It
requires `SWE_BENCH_DATASET_PATH` pointing to the pinned local dataset rows;
never grade against agent-written tests. Check the gold prediction and the
unmodified base against the installed harness before spending model runs.

## Prepare and run

Use Node 24, `npm ci && npm run build`, and an installed `opencode` CLI. Install
Docker and the official SWE-bench harness (pilot revision
`02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`), then run
`python3 eval/prepare-swebench.py` once (requires Python `datasets`) and set
`SWE_BENCH_DATASET_PATH` to its printed file path. Set `SWE_BENCH_PYTHON` to
the interpreter with `swebench` installed, if not available through `python3`.
Check the gold prediction and the unmodified base against the installed harness
before spending model runs. Configure
`JEV_API_KEY` for the adaptive arm and `CLIPROXY_KEY` for every arm; the default
upstream is `http://127.0.0.1:8317/v1` (override with `UPSTREAM_BASE_URL`).
The baseline arms do not contact Jev. OpenCode config is generated for each
attempt and project config loading is disabled to avoid task-local overrides.

```bash
node eval/run.mjs --task pallets__flask-5014 --model gpt-6-sol --arm medium --prepare-only
node eval/run.mjs --task pallets__flask-5014 --model gpt-6-sol --arm medium
node eval/run.mjs --task pallets__flask-5014 --model gpt-6-sol --arm high
node eval/run.mjs --task pallets__flask-5014 --model gpt-6-sol --arm jev
```

Repeat for `django__django-15957` and `gpt-6-astra`, ideally alternating arm order. Each attempt gets a
fresh detached task worktree and a new OpenCode session. Runs are sequential by
default; the CLI exits on idle. `--prepare-only` exercises worktree and config
creation without OpenCode, Jev or upstream calls. The runner removes task
worktrees in `finally`. Each run gets an ignored `eval/runs/<id>/` directory:
`result.json` (metadata/usage), `decisions.jsonl` (per-request router evidence),
`opencode.json` (generated config), `output.jsonl` (raw OpenCode events), and
`patch.diff` (agent changes), `prediction.jsonl`, and Docker grader logs.
**Raw events and patches can contain task content**;
inspect/redact before publishing. Do not publish keys or complete private tasks.

`result.json` records grade status, elapsed time, request count, selected
efforts, fallback count and summed upstream usage. If any response lacks usage,
the corresponding total is `null`, not an estimated saving. Model output tokens
include billed reasoning tokens. Subscription usage is not a dollar-cost claim.
If router evidence is absent or differs from OpenCode step-finish events, the
result is marked `evidence_valid: false` and token totals are withheld.
Two tasks per model × three arms = 12 attempts; this is a harness pilot, not a
statistically meaningful benchmark score. Inspect the `efforts` array and
`fallbacks` for each Jev attempt: neither high nor xhigh is guaranteed, and a
fallback to medium is not evidence of routing. Report the observed effort
distribution, including if every decision is low or medium; do not present
these two tasks as evidence of broad savings or an xhigh benefit.

For durable, low-maintenance references, run `node eval/summarize.mjs` after
the attempts, review `eval/results/pilot.md`, and commit that metadata-only
table to this repo for a stable GitHub URL. Attach raw run directories to a
GitHub Release or upload them as CI artifacts for auditing if desired;
Actions artifacts expire. Do not commit the ignored `eval/runs/` directories
or credentials.
