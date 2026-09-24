"""Summarize the strict Astra confirmation without publishing prompts or patches."""
import json
from pathlib import Path
import statistics
import sys

root = Path(__file__).resolve().parent
name = sys.argv[1]
rows = []
for path in (root / "runs").glob("pytest-dev__pytest-5787-gpt-6-astra-*/result.json"):
    r = json.loads(path.read_text())
    if r.get("run_set") not in [f"{name}-r{i}" for i in range(1, 6)]:
        continue
    events = [json.loads(line) for line in (path.parent / "decisions.jsonl").read_text().splitlines() if line]
    config = json.loads((path.parent / "opencode.json").read_text())["plugin"][0][1]
    if r["arm"] == "jev":
        assert config["fallbackMode"] == "error" and config["maxRetries"] == 3 and config["jevTimeoutMs"] == 10000
        assert not any(e.get("fallback") for e in events)
    r["extra_attempts"] = sum(max(0, e.get("jev_attempts", 0) - 1) for e in events)
    r["decision_counts"] = {effort: sum(e.get("effort") == effort for e in events) for effort in ["low", "medium", "high", "xhigh", "max"]}
    rows.append(r)
rows.sort(key=lambda r: (r["run_set"], r["arm"]))
expected = {(f"{name}-r{i}", arm) for i in range(1, 6) for arm in ["medium", "high", "xhigh", "jev"]}
assert len(rows) == 20 and {(r["run_set"], r["arm"]) for r in rows} == expected
metadata = json.loads((root / "runs" / name / "schedule.json").read_text())
lines = ["# Astra pytest #5787: fallback-free confirmation", "",
         f"Run set: `{name}`. Five fresh attempts per arm; two concurrent attempts, rotated arm order. Base-fails/reference-passes preflight passed before execution.", "",
         "Jev: three additional retries, 10-second total classification deadline, fallback disabled. All initiated attempts are retained, with no replacement runs. Historical fallback-enabled attempts are excluded.", "",
         "| Arm | Solved / initiated | Graded | Evidence valid | Mean agent seconds | Mean input | Mean cached input | Mean output |",
         "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
for arm in ["medium", "high", "xhigh", "jev"]:
    group = [r for r in rows if r["arm"] == arm]
    valid = [r for r in group if r.get("evidence_valid")]
    def mean(field, subset):
        values = [r[field] for r in subset if r.get(field) is not None]
        return f"{statistics.mean(values):.1f}" if values else "—"
    lines.append(f"| {arm} | {sum(r['grade_passed'] is True for r in group)}/5 | {sum(r['grade_passed'] is not None for r in group)} | {len(valid)}/5 | {float(mean('elapsed_ms', group))/1000:.1f} | {mean('input_tokens', valid)} | {mean('cached_input_tokens', valid)} | {mean('output_tokens', valid)} |")
lines += ["", "Time means include incomplete attempts; usage means include only evidence-valid attempts. Compare denominators before interpreting savings. Cached input is a subset of input, not an additional token category. Output includes reasoning and auxiliary requests. These are consumption measurements, not dollar-cost estimates.", "", "## Individual attempts", "",
          "| Round | Arm | Solved | Agent error | Classification errors | Timeout | Grader error | Evidence valid | Seconds | Output | Extra classification attempts | Run ID |",
          "| --- | --- | --- | --- | ---: | --- | --- | --- | ---: | ---: | ---: | --- |"]
for r in rows:
    lines.append("| " + " | ".join(str(v) for v in [r['run_set'].rsplit('-',1)[1], r['arm'], r['grade_passed'], r.get('agent_error'), r.get('classification_errors'), r['timed_out'], r['grader_error'], r.get('evidence_valid'), round(r['elapsed_ms']/1000,1), r['output_tokens'], r['extra_attempts'], r['run_id']]) + " |")
adaptive = [r for r in rows if r['arm'] == 'jev']
lines += ["", "## Routing", "", "Fallback events: **0**. Additional classification attempts: **" + str(sum(r['extra_attempts'] for r in adaptive)) + "**.", "", "Recorded effort counts: " + ", ".join(f"{e} {sum(r['decision_counts'][e] for r in adaptive)}" for e in ['low','medium','high','xhigh','max']) + ".", "", "## Comparisons", ""]
if all(r.get('evidence_valid') for r in rows):
    for arm in ['high', 'xhigh']:
        baseline = [r for r in rows if r['arm'] == arm]
        changes = {f: (statistics.mean(r[f] for r in adaptive) / statistics.mean(r[f] for r in baseline) - 1) * 100 for f in ['elapsed_ms', 'input_tokens', 'output_tokens']}
        lines.append(f"Jev versus {arm}, all five attempts per arm: time {changes['elapsed_ms']:+.1f}%, input tokens {changes['input_tokens']:+.1f}%, output tokens {changes['output_tokens']:+.1f}% (negative means reduction).")
        lines.append("")
lines += ["The strict router solved 5/5 without fallback, so these successes were not rescued by fallback-to-high. Against high, the small output-token reduction did not produce a speed gain. Medium solved 4/5, versus 1/5 historically: the previously observed sharp effort boundary did not reproduce. Xhigh's aggregate includes one short failed attempt; it is not a matched-success comparison. These fresh results do not explain whether historical outcomes were caused by fallback.", "", "## Provenance", "", f"Router commit: `{metadata['commit']}`. Node `{metadata['node']}`; OpenCode `{metadata['opencode']}`. Task base: `955e54221008aba577ecbaefa15679f6777d3bf8`. Dataset revision: `78f471bf655a3137b2e8a75af1501690ec009ec3`, checked using `eval/swebench-astra.sha256`. Jev endpoint: Vercel Gateway; generation upstream: local CLIProxyAPI. Agent cap: 15 minutes. Agent time excludes independent grading, but includes classification and retries.", "", "Schedule by round: " + "; ".join(f"r{i}: " + ", ".join(x['arm'] for x in metadata['schedule'] if x['round'] == i) for i in range(1,6)) + ". At most two attempts were active, with queued attempts starting as slots became free.", "", "## Scope", "", "This is a fresh confirmation on one task selected from earlier exploratory results, not a representative benchmark. Five attempts per arm do not establish equal success probabilities. Two concurrent runs and other host/upstream activity can affect latency. No causal claim is made about the effort required by an individual step. Raw evidence stays in ignored eval/runs/."]
out = root / "results" / f"{name}.md"
out.write_text("\n".join(lines) + "\n")
print(out)
