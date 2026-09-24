"""Run a fresh five-per-arm Astra matrix, at most two attempts concurrently.

Requires canonical eval credentials in the environment and a built plugin.
Usage: python eval/confirm-astra.py UNIQUE_RUN_SET
Raw artifacts and the immutable schedule stay in ignored eval/runs/.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
name = sys.argv[1]
assert name and all(c.isalnum() or c in "-_" for c in name)
directory = ROOT / "eval/runs" / name
directory.mkdir()  # Never silently repeat an existing experiment.
env = {**os.environ,
       "SWE_BENCH_DATASET_PATH": str(ROOT / "eval/runs/swebench-astra.json"),
       "SWE_BENCH_PYTHON": str(ROOT / "eval/runs/swebench-venv/bin/python")}
assert env.get("JEV_ROUTER_API_KEY") and env.get("CLIPROXY_KEY")
orders = ["medium high xhigh jev", "jev xhigh high medium",
          "high jev medium xhigh", "xhigh medium jev high",
          "medium jev high xhigh"]
schedule = [{"round": i + 1, "arm": arm} for i, order in enumerate(orders) for arm in order.split()]
metadata = {"run_set": name, "concurrency": 2, "schedule": schedule,
            "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "node": subprocess.check_output(["node", "--version"], text=True).strip(),
            "opencode": subprocess.check_output(["opencode", "--version"], text=True).strip(),
            "classification_policy": {"maxRetries": 3, "fallbackMode": "error", "jevTimeoutMs": 10000}}
(directory / "schedule.json").write_text(json.dumps(metadata, indent=2) + "\n")
# Recheck the existing immutable base/reference fixtures, without overwriting old logs.
for label, expected in [("base", 1), ("gold", 0)]:
    target = directory / label
    target.mkdir()
    grade_env = {**env, "EVAL_TASK_COMMIT": "955e54221008aba577ecbaefa15679f6777d3bf8",
                 "EVAL_PATCH_PATH": str(ROOT / "eval/runs/astra-preflight/pytest-dev__pytest-5787" / label / "patch.diff")}
    with (target / "grader.log").open("w") as log:
        result = subprocess.run(["node", str(ROOT / "eval/grade-swebench.mjs"), "pytest-dev__pytest-5787"], cwd=target, env=grade_env, stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode == expected, f"{label} preflight failed"
    print(f"PREFLIGHT {label}: OK", flush=True)

def attempt(item):
    round_, arm = item["round"], item["arm"]
    print(f"START r{round_} {arm}", flush=True)
    start = time.time()
    with (directory / f"r{round_}-{arm}.log").open("w") as log:
        result = subprocess.run(["node", "eval/run.mjs", "--manifest", "eval/runs/tasks-astra.json", "--task", "pytest-dev__pytest-5787", "--model", "gpt-6-astra", "--arm", arm], cwd=ROOT, env={**env, "EVAL_RUN_SET": f"{name}-r{round_}"}, stdout=log, stderr=subprocess.STDOUT)
    print(f"DONE r{round_} {arm} exit={result.returncode} seconds={time.time()-start:.1f}", flush=True)
    return {**item, "exit_code": result.returncode}

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(attempt, schedule))
(directory / "completed.json").write_text(json.dumps(results, indent=2) + "\n")
print("COMPLETE", flush=True)
