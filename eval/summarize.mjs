// Produce a small, shareable Markdown result from private per-attempt metadata.
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const runSet = process.argv[process.argv.indexOf("--run-set") + 1];
if (!runSet || runSet.startsWith("--")) throw new Error("Usage: node eval/summarize.mjs --run-set NAME");
const runs = join(root, "runs");
const manifest = JSON.parse(await readFile(join(root, "tasks.json"), "utf8"));
const commits = new Map(manifest.tasks.map((task) => [task.id, task.commit]));
const rows = [];
for (const name of await readdir(runs)) {
  let result;
  try { result = JSON.parse(await readFile(join(runs, name, "result.json"), "utf8")); }
  catch { continue; }
  if (result.elapsed_ms === null || commits.get(result.task) !== result.commit || result.run_set !== runSet) continue;
  rows.push(result);
}
rows.sort((a, b) => a.task.localeCompare(b.task) || a.model.localeCompare(b.model) || a.arm.localeCompare(b.arm));
const expected = new Set([...commits.keys()].flatMap((task) => ["gpt-6-sol", "gpt-6-astra"].flatMap((model) => ["medium", "high", "jev"].map((arm) => `${task}/${model}/${arm}`))));
const seen = new Set();
for (const row of rows) {
  const key = `${row.task}/${row.model}/${row.arm}`;
  if (!expected.has(key) || seen.has(key)) throw new Error(`Unexpected or duplicate attempt: ${key}`);
  seen.add(key);
}
if (seen.size !== expected.size) throw new Error(`Incomplete run set ${runSet}: found ${seen.size} of ${expected.size} task/model/arm combinations`);
const cell = (value) => value === null || value === undefined ? "—" : String(value);
const lines = [
  "# SWE-bench Verified pilot results", "",
  "Dataset: `SWE-bench/SWE-bench_Verified` revision `78f471bf655a3137b2e8a75af1501690ec009ec3`.",
  `Run set: \`${runSet}\`. One short and one harder selected case; this is not a representative benchmark score. Only compare token totals when evidence is valid.`,
  "", "| Task | Model | Arm | Graded | Grader error | Evidence valid | Time (s) | Requests | Auxiliary requests | Selected efforts | Fallbacks | Input tokens | Cached input | Output tokens | Run ID |",
  "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |",
];
for (const r of rows) {
  const counts = new Map();
  for (const effort of r.efforts ?? []) counts.set(effort, (counts.get(effort) ?? 0) + 1);
  const efforts = r.evidence_valid ? [...counts].map(([effort, count]) => `${effort}:${count}`).join(", ") : "—";
  lines.push(`| ${r.task} | ${r.model} | ${r.arm} | ${cell(r.grade_passed)} | ${cell(r.grader_error)} | ${cell(r.evidence_valid)} | ${cell(Math.round(r.elapsed_ms / 1000))} | ${cell(r.requests)} | ${r.evidence_valid ? cell(r.auxiliary_requests) : "—"} | ${efforts} | ${r.evidence_valid ? cell(r.fallbacks) : "—"} | ${cell(r.input_tokens)} | ${cell(r.cached_input_tokens)} | ${cell(r.output_tokens)} | ${r.run_id} |`);
}
const adaptive = rows.filter((r) => r.arm === "jev");
const validAdaptive = adaptive.filter((r) => r.evidence_valid);
const choices = new Map();
for (const r of validAdaptive) for (const effort of r.efforts ?? []) choices.set(effort, (choices.get(effort) ?? 0) + 1);
lines.push("", "## Reading this pilot", "",
  `Resolved: ${rows.filter((r) => r.grade_passed === true).length}/${rows.length} attempts; adaptive arm: ${adaptive.filter((r) => r.grade_passed === true).length}/${adaptive.length}.`,
  `Adaptive selected-effort events across ${validAdaptive.length} evidence-valid attempts: ${[...choices].map(([effort, count]) => `${effort} ${count}`).join(", ")}; fallback events: ${validAdaptive.reduce((sum, r) => sum + r.fallbacks, 0)}. Fallback efforts are included in the displayed effort counts.`,
  "Each arm used one fresh attempt per task/model. Differences in solution path and run length confound token and time comparisons; these two tasks cannot establish a general saving or success-rate advantage.",
  "Raw OpenCode events, grader logs, and patches remain in ignored local run directories; only metadata is published here.");
const output = join(root, "results", "pilot.md");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${lines.join("\n")}\n`);
console.log(output);
