// Produce a small, shareable Markdown result from private per-attempt metadata.
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const runs = join(root, "runs");
const manifest = JSON.parse(await readFile(join(root, "tasks.json"), "utf8"));
const commits = new Map(manifest.tasks.map((task) => [task.id, task.commit]));
const rows = [];
for (const name of await readdir(runs)) {
  let result;
  try { result = JSON.parse(await readFile(join(runs, name, "result.json"), "utf8")); }
  catch { continue; }
  if (result.elapsed_ms === null || commits.get(result.task) !== result.commit) continue; // Only this pilot's completed attempts.
  rows.push(result);
}
rows.sort((a, b) => a.task.localeCompare(b.task) || a.model.localeCompare(b.model) || a.arm.localeCompare(b.arm));
const cell = (value) => value === null || value === undefined ? "—" : String(value);
const lines = [
  "# SWE-bench Verified pilot results", "",
  "Dataset: `SWE-bench/SWE-bench_Verified` revision `78f471bf655a3137b2e8a75af1501690ec009ec3`.",
  "Two selected easy cases; this is not a representative benchmark score. Only compare token totals when evidence is valid.",
  "", "| Task | Model | Arm | Graded | Grader error | Evidence valid | Time (s) | Requests | Selected efforts | Fallbacks | Input tokens | Cached input | Output tokens | Run ID |",
  "| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |",
];
for (const r of rows) {
  const counts = new Map();
  for (const effort of r.efforts ?? []) counts.set(effort, (counts.get(effort) ?? 0) + 1);
  const efforts = r.evidence_valid ? [...counts].map(([effort, count]) => `${effort}:${count}`).join(", ") : "—";
  lines.push(`| ${r.task} | ${r.model} | ${r.arm} | ${cell(r.grade_passed)} | ${cell(r.grader_error)} | ${cell(r.evidence_valid)} | ${cell(Math.round(r.elapsed_ms / 1000))} | ${cell(r.requests)} | ${efforts} | ${r.evidence_valid ? cell(r.fallbacks) : "—"} | ${cell(r.input_tokens)} | ${cell(r.cached_input_tokens)} | ${cell(r.output_tokens)} | ${r.run_id} |`);
}
const output = join(root, "results", "pilot.md");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${lines.join("\n")}\n`);
console.log(output);
