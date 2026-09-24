"""Check that each candidate's base fails and its reference patch resolves."""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
variant = sys.argv[1] if len(sys.argv) == 2 else "candidates"
if variant not in {"candidates", "astra"}:
    raise RuntimeError("Expected candidates or astra")
DATASET = ROOT / "runs" / f"swebench-{variant}.json"
MANIFEST = ROOT / "runs" / f"tasks-{variant}.json"
rows = {row["instance_id"]: row for row in json.loads(DATASET.read_text())}
tasks = json.loads(MANIFEST.read_text())["tasks"]
if set(rows) != {task["id"] for task in tasks}:
    raise RuntimeError("Candidate dataset and manifest differ")

for task in tasks:
    instance = task["id"]
    for label, patch in (
        ("base", "diff --git a/jev-preflight-marker.txt b/jev-preflight-marker.txt\n"
                 "new file mode 100644\n--- /dev/null\n+++ b/jev-preflight-marker.txt\n"
                 "@@ -0,0 +1 @@\n+baseline grader check\n"),
        ("gold", rows[instance]["patch"]),
    ):
        directory = ROOT / "runs" / f"{variant}-preflight" / instance / label
        directory.mkdir(parents=True, exist_ok=True)
        patch_path = directory / "patch.diff"
        patch_path.write_text(patch)
        env = {**os.environ, "SWE_BENCH_DATASET_PATH": str(DATASET.resolve()),
               "SWE_BENCH_PYTHON": sys.executable,
               "EVAL_PATCH_PATH": str(patch_path.resolve()),
               "EVAL_TASK_COMMIT": task["commit"]}
        result = subprocess.run(["node", str(ROOT / "grade-swebench.mjs"), instance],
                                cwd=directory, env=env, capture_output=True, text=True)
        (directory / "grader.log").write_text(result.stdout + result.stderr)
        expected = label == "gold"
        if result.returncode != (0 if expected else 1) or not any(
            json.loads(line).get("resolved") is expected
            for line in result.stdout.splitlines() if line.startswith('{"instance_id":')
        ):
            raise RuntimeError(f"{instance} {label} preflight failed; see {directory / 'grader.log'}")
        print(f"{instance} {label}: resolved={expected}", flush=True)
