"""Generate a pinned dataset and runner manifest for intermediate candidates."""

import hashlib
import json
import sys
from pathlib import Path

from datasets import load_dataset

ROOT = Path(__file__).parent
REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"
variant = sys.argv[1] if len(sys.argv) == 2 else "candidates"
if variant not in {"candidates", "astra"}:
    raise RuntimeError("Expected candidates or astra")
selection = "candidate-selection.json" if variant == "candidates" else "astra-selection.json"
tasks = json.loads((ROOT / selection).read_text())["tasks"]
ids = {task["id"] for task in tasks}
if len(ids) != len(tasks):
    raise RuntimeError("Duplicate candidate instance")

rows = load_dataset("SWE-bench/SWE-bench_Verified", split="test", revision=REVISION)
selected = [row for row in rows if row["instance_id"] in ids]
if {row["instance_id"] for row in selected} != ids:
    raise RuntimeError("Pinned benchmark revision is missing a selected instance")
contents = json.dumps(selected, ensure_ascii=False) + "\n"
expected = (ROOT / f"swebench-{variant}.sha256").read_text().strip()
if hashlib.sha256(contents.encode()).hexdigest() != expected:
    raise RuntimeError("Pinned candidate dataset digest mismatch")

by_id = {row["instance_id"]: row for row in selected}
manifest = []
for task in tasks:
    row = by_id[task["id"]]
    if row["base_commit"] != task["commit"] or task["repo"] != f"https://github.com/{row['repo']}.git":
        raise RuntimeError(f"Candidate selection differs from benchmark: {task['id']}")
    manifest.append({**task, "benchmark": "SWE-bench Verified", "prompt": row["problem_statement"].replace("\r\n", "\n")})

output = ROOT / "runs"
output.mkdir(exist_ok=True)
(output / f"swebench-{variant}.json").write_text(contents)
(output / f"tasks-{variant}.json").write_text(json.dumps({"tasks": manifest}, ensure_ascii=False, indent=2) + "\n")
print(output.resolve())
