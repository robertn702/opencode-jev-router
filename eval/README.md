# Small paired agent evaluation (scaffold)

This pilot compares GPT-6 Astra and Sol at fixed `medium`, fixed `high`, and
Jev-selected effort using the **same OpenCode plugin, upstream, base effort and
task checkout**. No live results are included yet.

## Task manifest

`eval/tasks.json` pins two [SWE-bench Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)
instances, their public repository URLs, base commits, and original issue
statements: `pallets__flask-5014` (human-labeled `<15 min fix`, one failing test)
and `django__django-15957` (human-labeled `1-4 hours`, four failing tests).
`eval/tasks-xarray.json` separately pins `pydata__xarray-6992` (human-labeled
`>4 hours`, twelve failing tests) for a harder follow-up. Run
`eval/runs/swebench-venv/bin/python eval/prepare-xarray.py` to generate its
separately checked `eval/runs/swebench-xarray.json` dataset. Set
`SWE_BENCH_DATASET_PATH` to that file and pass `--manifest eval/tasks-xarray.json`
to the runner. This task has a 30-minute agent cap; the original two retain the
15-minute cap. Grade its unmodified base and reference fix before live attempts.
For the next intermediate screen, `eval/candidate-selection.json` selects
`astropy__astropy-12907` (15 min–1 hour) and `astropy__astropy-13579` (1–4 hours).
Run `eval/runs/swebench-venv/bin/python eval/prepare-candidates.py` to generate
`eval/runs/swebench-candidates.json` and `eval/runs/tasks-candidates.json` from
the same pinned Verified revision. The selected rows have a separate checked
digest in `eval/swebench-candidates.sha256`. Set `SWE_BENCH_DATASET_PATH` to
the generated dataset and pass `--manifest eval/runs/tasks-candidates.json` to
the runner. Preflight both base and reference grading before live attempts.
When the xarray workers have finished, run
`eval/runs/swebench-venv/bin/python eval/preflight-candidates.py` (with Node 24 on PATH)
to check both bases and reference patches with the official Docker grader.
Preflight artifacts stay in ignored `eval/runs/candidates-preflight/`.
Use a balanced Sol screen across all four arms before deciding which tasks
merit five attempts per arm; select follow-up tasks for mixed outcomes, not
based on which arm wins a small screen. The xarray matrix was stopped after 38 unresolved attempts.
`bash eval/screen-candidates.sh` prepares and preflights both tasks before
running two rounds of all four arms on Sol (16 attempts, each in a fresh
worktree). The script stops if a preflight or attempt fails to execute; inspect
its log and existing run sets before restarting to avoid duplicate attempts.

For the Astra follow-up, `eval/astra-selection.json` pins
`django__django-14631` and `pytest-dev__pytest-5787`, both human-labeled
1–4 hours. `bash eval/screen-astra.sh` prepares a separate checked dataset,
preflights base and reference grading, then runs two fresh attempts each at
fixed medium and fixed xhigh for each task. Review those eight results before
expanding: prefer a task with both passes and failures, particularly a medium
versus xhigh distinction. If neither task discriminates, screen another
candidate rather than interpreting an all-pass/all-fail matrix. For a selected
task, complete five attempts per arm (medium, high, xhigh, Jev), counting the
spike attempts toward the medium and xhigh totals. Keep the grader, timeout,
base commit, and prompt fixed, and report grading failures separately from
usage-evidence failures. Summarize only metadata in `eval/results/`.
After the pytest spike, `bash eval/finish-astra.sh` fills in rounds 1–2
with high and Jev, then runs all four arms in rounds 3–5. It reuses the
spike run-set names so that each arm ends with five distinct attempts.
Only run this once after checking the spike and the existing run sets.
Selection rule: one short, mechanical issue and one longer, multi-step ORM
issue from different repositories, both human-verified and with concise issue
descriptions. These two original pilot cases are not a representative benchmark
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
`JEV_ROUTER_API_KEY` for the adaptive arm and `CLIPROXY_KEY` for every arm. The eval
defaults Jev to Vercel AI Gateway (`https://ai-gateway.vercel.sh/typesafe`);
set `JEV_ROUTER_BASE_URL=https://api.typesafe.ai` only for a direct TypeSafe key. The default
upstream is `http://127.0.0.1:8317/v1` (override with `JEV_ROUTER_UPSTREAM_BASE_URL`).
The baseline arms do not contact Jev. OpenCode config is generated for each
attempt and project config loading is disabled to avoid task-local overrides.

```bash
node eval/run.mjs --task pallets__flask-5014 --model gpt-6-sol --arm medium --prepare-only
node eval/run.mjs --task pallets__flask-5014 --model gpt-6-sol --arm medium
node eval/run.mjs --task pallets__flask-5014 --model gpt-6-sol --arm high
node eval/run.mjs --task pallets__flask-5014 --model gpt-6-sol --arm xhigh
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
If router evidence is absent or cannot reconcile every OpenCode step-finish
event by ordered usage, the result is marked `evidence_valid: false` and token
  totals are withheld. OpenCode may make auxiliary provider requests without a
  step-finish event. The reconciler requires one uniquely unmatched early
  request, which may complete before, during, or just after the second step.
  It includes that request in upstream totals and reports it as
  `auxiliary_requests`; `agent_usage` separately sums only matched agent-step
  requests. Its purpose is not proven by the metadata alone. Ambiguous matches
  and other shapes fail closed until explicitly verified.
Two tasks per model × three arms = 12 attempts; this is a harness pilot, not a
statistically meaningful benchmark score. Inspect the `efforts` array and
`fallbacks` for each Jev attempt: neither high nor xhigh is guaranteed, and a
fallback to medium is not evidence of routing. Report the observed effort
distribution, including if every decision is low or medium; do not present
these two tasks as evidence of broad savings or an xhigh benefit.

For durable, low-maintenance references, set a distinct `EVAL_RUN_SET` for all
attempts in a matrix. Run `node eval/summarize.mjs --run-set NAME` after
the attempts, review `eval/results/pilot.md`, and commit that metadata-only
table to this repo for a stable GitHub URL. Attach raw run directories to a
GitHub Release or upload them as CI artifacts for auditing if desired;
Actions artifacts expire. Do not commit the ignored `eval/runs/` directories
or credentials.
