"""Download the pinned SWE-bench Verified rows for the two-task pilot."""

import json
import hashlib
from pathlib import Path

from datasets import load_dataset

REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"
IDS = {"pallets__flask-5014", "django__django-15957"}

rows = load_dataset("SWE-bench/SWE-bench_Verified", split="test", revision=REVISION)
selected = [row for row in rows if row["instance_id"] in IDS]
if {row["instance_id"] for row in selected} != IDS:
    raise RuntimeError("Pinned benchmark revision is missing a selected instance")
manifest = json.loads((Path(__file__).parent / "tasks.json").read_text())
for task in manifest["tasks"]:
    row = next(row for row in selected if row["instance_id"] == task["id"])
    if row["base_commit"] != task["commit"] or row["problem_statement"].replace("\r\n", "\n") != task["prompt"]:
        raise RuntimeError(f"Manifest differs from pinned benchmark: {task['id']}")
output = Path(__file__).parent / "runs" / "swebench-verified-pilot.json"
output.parent.mkdir(exist_ok=True)
contents = json.dumps(selected, ensure_ascii=False) + "\n"
digest = hashlib.sha256(contents.encode()).hexdigest()
expected = (Path(__file__).parent / "swebench-verified-pilot.sha256").read_text().strip()
if digest != expected:
    raise RuntimeError("Pinned dataset digest mismatch; check the dataset revision and generator")
output.write_text(contents)
print(output.resolve())
