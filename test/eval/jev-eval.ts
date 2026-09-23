import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createJevClassifier, type JevState } from "../../src/jev.js";
import { loadJevConnection } from "../../src/config.js";
import type { Effort } from "../../src/rewrite.js";

// Plan item 16: Jev selection eval (live classifier, synthetic fixture corpus).
// Runs each corpus state 3 times through the production selector and asserts:
//   1. output is a valid effort enum value
//   2. the per-state selection (median of clean runs) falls within its expected band
//   3. monotonicity: a higher tier never selects below a lower tier's selection
// Per-state variance across runs is report-only. The written report lists scenario
// IDs and efforts only, never prompt or tool text.

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const ORDINAL: Record<Effort, number> = {
  none: -1,
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};
const BANDS: Record<string, readonly Effort[]> = {
  "low-medium": ["low", "medium"],
  "high-max": ["high", "xhigh", "max"],
};
const TIER_RANK: Record<string, number> = {
  trivial: 0,
  simple: 1,
  medium: 2,
  hard: 3,
  "very-hard": 4,
};

const RUNS_PER_SCENARIO = 3;
const MAX_ATTEMPTS_PER_SCENARIO = 6;

type Band = keyof typeof BANDS;

interface Scenario {
  id: string;
  tier: string;
  band: Band;
  pair?: { id: string; role: "clean" | "failed" };
  state: JevState;
}

interface RunRecord {
  effort: Effort | null;
  fallback: string | null;
}

function stateToInput(state: JevState): unknown[] {
  const items: unknown[] = [];
  if (state.assistant_progress.length > 0) {
    items.push({ role: "assistant", content: state.assistant_progress });
  }
  items.push({
    role: "user",
    content: [{ type: "input_text", text: state.recent_user_text }],
  });
  state.tool_results.forEach((result, index) => {
    items.push({
      type: "function_call",
      call_id: `call_${index}`,
      name: result.name,
      arguments: "{}",
    });
    items.push(
      result.ok
        ? {
            type: "function_call_output",
            call_id: `call_${index}`,
            output: result.excerpt,
          }
        : {
            type: "function_call_output",
            call_id: `call_${index}`,
            output: result.excerpt,
            error: "tool failed",
          },
    );
  });
  return items;
}

function medianEffort(runs: RunRecord[]): Effort | null {
  const ordinals = runs
    .map((run) => (run.effort === null ? null : ORDINAL[run.effort]))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const middle = ordinals[Math.floor(ordinals.length / 2)];
  if (middle === undefined) {
    return null;
  }
  return EFFORTS[middle] ?? null;
}

async function main(): Promise<number> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const jev = loadJevConnection(process.env);

  const here = dirname(fileURLToPath(import.meta.url));
  const corpusPath = join(here, "..", "fixtures", "jev-eval-corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
    scenarios: Scenario[];
  };

  const classifier = createJevClassifier({
    ...jev,
    timeoutMs: 15_000,
  });

  const report: {
    generated_at: string;
    runs_per_scenario: number;
    scenarios: Array<{
      id: string;
      tier: string;
      band: Band;
      efforts: Array<string | null>;
      fallbacks: number;
      selection: string | null;
      variance: boolean;
    }>;
    pair_deltas: Array<{
      pair: string;
      clean_selection: string | null;
      failed_selection: string | null;
      failed_at_least_clean: boolean | null;
    }>;
    monotonicity_violations: Array<{ lower: string; higher: string }>;
    pass: {
      valid_enum: boolean;
      bands: boolean;
      monotonicity: boolean;
      coverage: boolean;
    };
  } = {
    generated_at: new Date().toISOString(),
    runs_per_scenario: RUNS_PER_SCENARIO,
    scenarios: [],
    pair_deltas: [],
    monotonicity_violations: [],
    pass: {
      valid_enum: true,
      bands: true,
      monotonicity: true,
      coverage: true,
    },
  };

  const selections = new Map<string, Effort | null>();

  for (const scenario of corpus.scenarios) {
    const runs: RunRecord[] = [];
    let attempts = 0;
    let fallbackCount = 0;
    while (runs.length < RUNS_PER_SCENARIO && attempts < MAX_ATTEMPTS_PER_SCENARIO) {
      attempts += 1;
      const decision = await classifier.select({
        model: findModel("gpt-6-astra")!,
        body: { input: stateToInput(scenario.state) },
        signal: new AbortController().signal,
      });
      if (decision.fallback !== null) {
        fallbackCount += 1;
        continue;
      }
      runs.push({ effort: decision.effort, fallback: null });
    }

    const cleanEfforts = runs.map((run) => run.effort);
    const validEnum =
      cleanEfforts.length > 0 &&
      cleanEfforts.every(
        (effort) => effort !== null && EFFORTS.includes(effort),
      );
    const selection = medianEffort(runs);
    selections.set(scenario.id, selection);

    const band = BANDS[scenario.band] ?? [];
    const bandsOk = selection !== null && band.includes(selection);
    const variance = new Set(cleanEfforts).size > 1;

    if (!validEnum) {
      report.pass.valid_enum = false;
    }
    if (!bandsOk) {
      report.pass.bands = false;
    }
    if (runs.length < RUNS_PER_SCENARIO) {
      report.pass.coverage = false;
    }

    report.scenarios.push({
      id: scenario.id,
      tier: scenario.tier,
      band: scenario.band,
      efforts: cleanEfforts.map((effort) => effort),
      fallbacks: fallbackCount,
      selection,
      variance,
    });

    const label = selection ?? "none";
    console.log(
      `${scenario.id} tier=${scenario.tier} band=${scenario.band} selection=${label} runs=[${cleanEfforts.join(",")}] fallbacks=${fallbackCount}`,
    );
  }

  for (const scenario of corpus.scenarios) {
    if (!scenario.pair) {
      continue;
    }
    const sibling = corpus.scenarios.find(
      (other) =>
        other.pair !== undefined &&
        scenario.pair !== undefined &&
        other.pair.id === scenario.pair.id &&
        other.pair.role !== scenario.pair.role,
    );
    if (sibling === undefined || scenario.pair.role !== "clean") {
      continue;
    }
    const clean = selections.get(scenario.id) ?? null;
    const failed = selections.get(sibling.id) ?? null;
    const compared =
      clean !== null && failed !== null
        ? ORDINAL[failed] >= ORDINAL[clean]
        : null;
    report.pair_deltas.push({
      pair: scenario.pair.id,
      clean_selection: clean,
      failed_selection: failed,
      failed_at_least_clean: compared,
    });
  }

  for (const lower of corpus.scenarios) {
    for (const higher of corpus.scenarios) {
      const lowerRank = TIER_RANK[lower.tier];
      const higherRank = TIER_RANK[higher.tier];
      if (lowerRank === undefined || higherRank === undefined) {
        continue;
      }
      if (lowerRank >= higherRank) {
        continue;
      }
      const lowSelection = selections.get(lower.id) ?? null;
      const highSelection = selections.get(higher.id) ?? null;
      if (lowSelection === null || highSelection === null) {
        continue;
      }
      if (ORDINAL[highSelection] < ORDINAL[lowSelection]) {
        report.pass.monotonicity = false;
        report.monotonicity_violations.push({
          lower: lower.id,
          higher: higher.id,
        });
      }
    }
  }

  const passAll =
    report.pass.valid_enum &&
    report.pass.bands &&
    report.pass.monotonicity &&
    report.pass.coverage;

  const outDir = join(here, "..", "..", "scratch");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "eval-jev-report.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`report written to ${outPath}`);
  console.log(
    `pass: enum=${report.pass.valid_enum} bands=${report.pass.bands} monotonicity=${report.pass.monotonicity} coverage=${report.pass.coverage}`,
  );
  if (report.monotonicity_violations.length > 0) {
    for (const violation of report.monotonicity_violations) {
      console.log(`monotonicity violation: ${violation.lower} > ${violation.higher}`);
    }
  }
  for (const delta of report.pair_deltas) {
    console.log(
      `pair ${delta.pair}: clean=${delta.clean_selection} failed=${delta.failed_selection} (report-only)`,
    );
  }
  return passAll ? 0 : 1;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
import { findModel } from "../../src/models.js";
