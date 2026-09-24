#!/usr/bin/env bash
# Gate a two-attempt-per-arm medium/xhigh spike on official grader preflights.
set -euo pipefail
# Requires Node 24 on PATH.
export SWE_BENCH_DATASET_PATH="$PWD/eval/runs/swebench-astra.json"
export SWE_BENCH_PYTHON="$PWD/eval/runs/swebench-venv/bin/python"

"$SWE_BENCH_PYTHON" eval/prepare-candidates.py astra
"$SWE_BENCH_PYTHON" eval/preflight-candidates.py astra

for round in 1 2; do
  export EVAL_RUN_SET="gateway-astra-spike-2026-09-24-r${round}"
  for task in django__django-14631 pytest-dev__pytest-5787; do
    if [[ "$round" == 1 ]]; then arms=(medium xhigh); else arms=(xhigh medium); fi
    for arm in "${arms[@]}"; do
      echo "START $(date -u +%FT%TZ) $EVAL_RUN_SET $task gpt-6-astra $arm"
      node eval/run.mjs --manifest eval/runs/tasks-astra.json --task "$task" --model gpt-6-astra --arm "$arm"
      echo "DONE  $(date -u +%FT%TZ) $EVAL_RUN_SET $task gpt-6-astra $arm"
    done
  done
done
echo "COMPLETE $(date -u +%FT%TZ) Astra spike"
