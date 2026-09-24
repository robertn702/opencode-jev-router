#!/usr/bin/env bash
# Run after the xarray workers have stopped. Preflight gates all live attempts.
set -euo pipefail
# Requires Node 24 on PATH.
export SWE_BENCH_DATASET_PATH="$PWD/eval/runs/swebench-candidates.json"
export SWE_BENCH_PYTHON="$PWD/eval/runs/swebench-venv/bin/python"

"$SWE_BENCH_PYTHON" eval/prepare-candidates.py
"$SWE_BENCH_PYTHON" eval/preflight-candidates.py

for round in 1 2; do
  export EVAL_RUN_SET="gateway-astropy-screen-2026-09-24-r${round}"
  for task in astropy__astropy-12907 astropy__astropy-13579; do
    if [[ "$round" == 1 ]]; then
      arms=(medium high xhigh jev)
    else
      arms=(high jev medium xhigh)
    fi
    for arm in "${arms[@]}"; do
      echo "START $(date -u +%FT%TZ) $EVAL_RUN_SET $task gpt-6-sol $arm"
      node eval/run.mjs --manifest eval/runs/tasks-candidates.json --task "$task" --model gpt-6-sol --arm "$arm"
      echo "DONE  $(date -u +%FT%TZ) $EVAL_RUN_SET $task gpt-6-sol $arm"
    done
  done
done
echo "COMPLETE $(date -u +%FT%TZ) candidate screen"
