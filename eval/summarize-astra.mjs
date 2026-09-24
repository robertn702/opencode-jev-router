// Publish metadata only after the selected task has five graded attempts per arm.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const id = "pytest-dev__pytest-5787";
const model = "gpt-6-astra";
const commit = "955e54221008aba577ecbaefa15679f6777d3bf8";
const arms = ["medium", "high", "xhigh", "jev"];
const rows = [];
for (const name of await readdir(join(root, "runs"))) {
  let result;
  try { result = JSON.parse(await readFile(join(root, "runs", name, "result.json"), "utf8")); }
  catch { continue; }
  if (result.task !== id || result.model !== model || !/^gateway-astra-spike-2026-09-24-r[1-5]$/.test(result.run_set ?? "")) continue;
  if (result.commit !== commit || !arms.includes(result.arm) || typeof result.grade_passed !== "boolean" || result.grader_error) {
    throw new Error(`Invalid attempt: ${result.run_id}`);
  }
  rows.push(result);
}
const seen = new Set();
for (const row of rows) {
  const key = `${row.run_set}/${row.arm}`;
  if (seen.has(key)) throw new Error(`Duplicate attempt: ${key}`);
  seen.add(key);
}
if (rows.length !== 20 || arms.some((arm) => rows.filter((row) => row.arm === arm).length !== 5)) {
  throw new Error(`Incomplete Astra pass@5: ${rows.length}/20 attempts`);
}
const lines = [
  "# Astra effort comparison: pytest #5787", "",
  "SWE-bench Verified `pytest-dev__pytest-5787`, dataset revision `78f471bf655a3137b2e8a75af1501690ec009ec3`; five fresh attempts per arm at the same pinned base commit and grader. The first two medium and xhigh attempts were the selection spike. This task was selected after observing a medium/xhigh difference, so these results are exploratory, not an unbiased benchmark estimate.",
  "", "## Selection spike", "",
  "Both candidates passed base-fails/reference-passes grading preflight. Astra solved `django__django-14631` 2/2 at medium and 2/2 at xhigh; it solved `pytest-dev__pytest-5787` 1/2 at medium and 2/2 at xhigh. Only pytest was expanded.",
  "", "## Selected task: pass@5", "",
  "", "| Arm | Resolved | Evidence valid | Mean agent time (s) | Mean upstream output tokens | Mean agent-step output tokens |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
];
for (const arm of arms) {
  const attempts = rows.filter((row) => row.arm === arm);
  const valid = attempts.filter((row) => row.evidence_valid && Number.isFinite(row.output_tokens));
  const mean = (items, field) => items.length ? Math.round(items.reduce((sum, row) => sum + row[field], 0) / items.length) : "—";
  lines.push(`| ${arm} | ${attempts.filter((row) => row.grade_passed).length}/5 | ${attempts.filter((row) => row.evidence_valid).length}/5 | ${mean(attempts, "elapsed_ms") / 1000} | ${mean(valid, "output_tokens")} | ${mean(valid.map((row) => row.agent_usage), "output_tokens")} |`);
}
const adaptive = rows.filter((row) => row.arm === "jev");
const validAdaptive = adaptive.filter((row) => row.evidence_valid);
const counts = new Map();
for (const row of validAdaptive) for (const effort of row.efforts ?? []) counts.set(effort, (counts.get(effort) ?? 0) + 1);
lines.push("", `Jev effort decisions across ${validAdaptive.length} evidence-valid attempts: ${[...counts].map(([effort, count]) => `${effort} ${count}`).join(", ") || "none"}. Fallbacks: ${validAdaptive.reduce((sum, row) => sum + row.fallbacks, 0)}.`,
  "", "Each attempt's grader outcome is separate from usage-evidence validity. Upstream totals include the one logged auxiliary request; agent-step totals exclude it. Output tokens include reasoning tokens; times and tokens depend on solution path and do not establish dollar cost. Raw prompts, patches, traces, and grader logs remain in ignored `eval/runs/`.");
const output = join(root, "results", "astra-pytest-5787.md");
await writeFile(output, `${lines.join("\n")}\n`);
console.log(output);
