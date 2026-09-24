"""Download and verify the pinned SWE-bench Verified xarray instance."""

import hashlib
import json
from pathlib import Path

from datasets import load_dataset

ROOT = Path(__file__).parent
INSTANCE = "pydata__xarray-6992"
REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"

rows = load_dataset("SWE-bench/SWE-bench_Verified", split="test", revision=REVISION)
row = next(item for item in rows if item["instance_id"] == INSTANCE)
task = next(item for item in json.loads((ROOT / "tasks-xarray.json").read_text())["tasks"] if item["id"] == INSTANCE)
if row["base_commit"] != task["commit"] or row["problem_statement"].replace("\r\n", "\n") != task["prompt"]:
    raise RuntimeError("Xarray task manifest differs from pinned benchmark")

contents = json.dumps([row], ensure_ascii=False) + "\n"
digest = hashlib.sha256(contents.encode()).hexdigest()
expected = (ROOT / "swebench-xarray.sha256").read_text().strip()
if digest != expected:
    raise RuntimeError("Pinned xarray dataset digest mismatch")
output = ROOT / "runs" / "swebench-xarray.json"
output.write_text(contents)
print(output.resolve())
