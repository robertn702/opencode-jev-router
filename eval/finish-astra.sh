#!/usr/bin/env bash
# Fill in pytest's missing arms from rounds 1–2, then run all arms in rounds 3–5.
set -euo pipefail
# Requires Node 24 on PATH.
export SWE_BENCH_DATASET_PATH="$PWD/eval/runs/swebench-astra.json"
export SWE_BENCH_PYTHON="$PWD/eval/runs/swebench-venv/bin/python"
task=pytest-dev__pytest-5787

for round in 1 2 3 4 5; do
  export EVAL_RUN_SET="gateway-astra-spike-2026-09-24-r${round}"
  case "$round" in
    1) arms=(high jev) ;;
    2) arms=(jev high) ;;
    3) arms=(medium xhigh high jev) ;;
    4) arms=(xhigh jev medium high) ;;
    5) arms=(high medium jev xhigh) ;;
  esac
  for arm in "${arms[@]}"; do
    echo "START $(date -u +%FT%TZ) $EVAL_RUN_SET $task gpt-6-astra $arm"
    node eval/run.mjs --manifest eval/runs/tasks-astra.json --task "$task" --model gpt-6-astra --arm "$arm"
    echo "DONE  $(date -u +%FT%TZ) $EVAL_RUN_SET $task gpt-6-astra $arm"
  done
done
node eval/summarize-astra.mjs
echo "COMPLETE $(date -u +%FT%TZ) pytest Astra pass@5"
