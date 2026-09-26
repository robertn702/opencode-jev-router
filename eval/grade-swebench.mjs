#!/usr/bin/env node
// Submit the saved patch to the official SWE-bench Docker harness; never run agent-written tests.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Any unexpected adapter failure is infrastructure, never a failed solution.
process.on("uncaughtException", (error) => {
  console.error(`SWE-bench grader error: ${error.message}`);
  process.exit(2);
});

const id = process.argv[2];
const dir = process.cwd();
const dataset = process.env.SWE_BENCH_DATASET_PATH;
const root = dirname(fileURLToPath(import.meta.url));
if (!/^[a-zA-Z0-9_-]+$/.test(id ?? "") || !dataset || !process.env.EVAL_PATCH_PATH) {
  console.error("Expected instance ID, SWE_BENCH_DATASET_PATH, and EVAL_PATCH_PATH");
  process.exit(2);
}
const contents = readFileSync(dataset);
const digestFile = ["sympy__sympy-13878", "sphinx-doc__sphinx-7590", "scikit-learn__scikit-learn-25102", "sphinx-doc__sphinx-11510", "pytest-dev__pytest-6197"].includes(id) ? "swebench-boundary.sha256" :
  ["django__django-14631", "pytest-dev__pytest-5787"].includes(id) ? "swebench-astra.sha256" :
  id.startsWith("astropy__astropy-") ? "swebench-candidates.sha256" :
  id === "pydata__xarray-6992" ? "swebench-xarray.sha256" : "swebench-verified-pilot.sha256";
const expected = readFileSync(process.env.EVAL_DATASET_DIGEST_FILE ?? join(root, digestFile), "utf8").trim();
if (createHash("sha256").update(contents).digest("hex") !== expected) {
  console.error("Pinned SWE-bench dataset digest mismatch");
  process.exit(2);
}
const rows = JSON.parse(contents.toString("utf8"));
const row = rows.find((item) => item.instance_id === id);
if (!row || row.base_commit !== process.env.EVAL_TASK_COMMIT) {
  console.error("Instance or base commit does not match the pinned dataset");
  process.exit(2);
}
const patch = readFileSync(process.env.EVAL_PATCH_PATH, "utf8");
if (!patch.trim()) {
  console.log(JSON.stringify({ instance_id: id, resolved: false, reason: "empty_patch" }));
  process.exit(1);
}
const predictions = join(dir, "prediction.jsonl");
writeFileSync(predictions, JSON.stringify({ instance_id: id, model_name_or_path: "jev-eval", model_patch: patch }) + "\n", { mode: 0o600 });
const runId = `jev-${randomUUID()}`;
const run = spawnSync(process.env.SWE_BENCH_PYTHON ?? "python3", ["-m", "swebench.harness.run_evaluation", "--dataset_name", dataset,
  "--predictions_path", predictions, "--instance_ids", id, "--max_workers", "1", "--run_id", runId],
  { cwd: dir, encoding: "utf8", timeout: 28 * 60_000, maxBuffer: 10 * 1024 * 1024 });
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
if (run.error || run.status !== 0) {
  console.error(run.error?.message ?? `SWE-bench harness exited ${run.status}`);
  process.exit(2);
}
let report;
try { report = JSON.parse(readFileSync(join(dir, "logs/evaluation", runId, "jev-eval", id, "report.json"), "utf8")); }
catch (error) { console.error(`SWE-bench report unavailable: ${error.message}`); process.exit(2); }
if (typeof report[id]?.resolved !== "boolean") {
  console.error("SWE-bench report missing resolved status");
  process.exit(2);
}
console.log(JSON.stringify({ instance_id: id, resolved: report[id]?.resolved === true }));
process.exit(report[id]?.resolved === true ? 0 : 1);
