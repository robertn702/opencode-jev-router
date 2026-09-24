// Recalculate usage metadata from saved logs; never rerun the model or grader.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileEvidence } from "./evidence.mjs";

const runs = join(dirname(fileURLToPath(import.meta.url)), "runs");
let processed = 0;
for (const name of await readdir(runs)) {
  if (!name.startsWith("pytest-dev__pytest-5787-gpt-6-astra-")) continue;
  const dir = join(runs, name);
  let result;
  try { result = JSON.parse(await readFile(join(dir, "result.json"), "utf8")); }
  catch { continue; }
  if (!/^gateway-astra-spike-2026-09-24-r[1-5]$/.test(result.run_set ?? "")) continue;
  const events = (await readFile(join(dir, "decisions.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const output = (await readFile(join(dir, "output.jsonl"), "utf8")).split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const matched = reconcileEvidence(events, output);
  if (!matched || !events.every((e) => e.model === result.model && e.outcome === "completed" &&
      (result.arm === "jev" || e.effort === result.arm) &&
      [e.input_tokens, e.cached_input_tokens, e.output_tokens].every(Number.isFinite))) {
    throw new Error(`Evidence still ambiguous: ${result.run_id}`);
  }
  result.requests = events.length;
  result.auxiliary_requests = matched.auxiliary;
  result.agent_usage = matched.agent;
  result.evidence_valid = true;
  for (const field of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
    result[field] = events.reduce((sum, event) => sum + event[field], 0);
  }
  await writeFile(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  processed++;
}
if (processed !== 20) throw new Error(`Expected 20 Astra pytest attempts, found ${processed}`);
console.log(`Reconciled ${processed} saved Astra pytest attempts`);
