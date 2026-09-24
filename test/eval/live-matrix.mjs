// Plan item 17: graded live path matrix (supersedes item 15's two-request check).
// Five real tool-using tasks of increasing difficulty through the full
// OpenCode -> proxy -> CLIProxyAPI -> Codex path, plus one direct probe per tier.
// Asserts: task completion, outbound model remains gpt-6-astra, top-level effort
// remains stable (probe responses report the base effort), easy-tier selected
// effort <= hard-tier selected effort in Jev's ordinal order, and only allowlisted
// metadata is emitted. Evidence is prompt-free/credential-free: scenario IDs and
// efforts only.
//
// Usage: node test/eval/live-matrix.mjs   (requires JEV_ROUTER_API_KEY + CLIPROXY_KEY)
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
} catch {
  /* no .env; rely on the ambient environment */
}

const PORT = 4321;
const JEV_ROUTER_BASE_EFFORT = process.env.JEV_ROUTER_BASE_EFFORT ?? "medium";
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL ?? "gpt-6-astra";
const ALLOWED_KEYS = [
  "effort",
  "fallback",
  "jev_latency_ms",
  "model",
  "outcome",
  "request_id",
];
const ORDINAL = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

const TIERS = [
  {
    id: "t1-trivial",
    difficulty: "trivial",
    prompt:
      "Use the read tool on marker.txt, then reply with exactly ANS-<the number in that file, no spaces>.",
    expect: "ANS-7",
    files: { "marker.txt": "7\n" },
  },
  {
    id: "t2-simple",
    difficulty: "simple",
    prompt:
      "Use the read tool on word.txt, then reply with exactly ANS-<the word in that file>.",
    expect: "ANS-quokka",
    files: { "word.txt": "quokka\n" },
  },
  {
    id: "t3-medium",
    difficulty: "medium",
    prompt:
      "Use grep to find which file in notes/ contains the word orbit, read that file, then reply with exactly ANS-<the number in that file>.",
    expect: "ANS-42",
    files: {
      "notes/a.txt": "nothing here\n",
      "notes/b.txt": "orbit 42\n",
      "notes/c.txt": "all quiet\n",
    },
  },
  {
    id: "t4-hard",
    difficulty: "hard",
    prompt:
      "Use glob to list the .log files in logs/, read each one, then reply with exactly ANS-<the status code that appears in exactly one file>.",
    expect: "ANS-504",
    files: {
      "logs/x.log": "status 200\n",
      "logs/y.log": "status 200\n",
      "logs/z.log": "status 504\n",
    },
  },
  {
    id: "t5-very-hard",
    difficulty: "very-hard",
    prompt:
      "Use the read tool on config.json, error.txt, and owners.txt. error.txt shows a connection failure to a specific port; config.json maps service names to ports; owners.txt maps service names to teams. Reply with exactly ANS-<the team that owns the failing service>.",
    expect: "ANS-platform",
    files: {
      "config.json":
        '{\n  "services": {\n    "billing": 8081,\n    "search": 8082,\n    "mailer": 8083\n  }\n}\n',
      "error.txt":
        "upstream connect failed: dial tcp 127.0.0.1:8083: connection refused\n",
      "owners.txt":
        "billing: payments team\nsearch: discovery team\nmailer: platform team\n",
    },
  },
];

const evidence = { versions: {}, steps: {}, pass: {} };

const proxy = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: { ...process.env, JEV_ROUTER_PORT: PORT },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const proxyEvidence = [];
let proxyLog = "";
let proxyLineBuffer = "";
proxy.stdout.on("data", (chunk) => {
  proxyLineBuffer += chunk.toString();
  let idx;
  while ((idx = proxyLineBuffer.indexOf("\n")) >= 0) {
    const part = proxyLineBuffer.slice(0, idx);
    proxyLineBuffer = proxyLineBuffer.slice(idx + 1);
    proxyLog += `${part}\n`;
    if (part.startsWith("{")) {
      try {
        proxyEvidence.push(JSON.parse(part));
      } catch {
        /* not metadata */
      }
    }
  }
});
proxy.stderr.on("data", (chunk) => {
  proxyLog += chunk.toString();
});

async function waitForProxy() {
  for (let i = 0; i < 60; i += 1) {
    if (proxy.exitCode !== null) {
      throw new Error(`proxy exited early (${proxy.exitCode}):\n${proxyLog}`);
    }
    if (proxyLog.includes("listening on")) {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`proxy did not become healthy:\n${proxyLog}`);
}

async function settleEvidence(startIndex, minLines, waitMs = 4000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (proxyEvidence.length >= startIndex + minLines) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return proxyEvidence.slice(startIndex);
}

function summarize(lines) {
  return lines.map((line) => ({
    model: line.model,
    effort: line.effort,
    fallback: line.fallback,
    outcome: line.outcome,
    keys: Object.keys(line).sort(),
  }));
}

try {
  await waitForProxy();
  console.log("proxy healthy");

  const workdir = "/tmp/jev-matrix";
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    `${workdir}/opencode.jsonc`,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          "jev-router": {
            npm: "@ai-sdk/openai",
            name: "Jev adaptive Astra",
            options: {
              apiKey: "{env:CLIPROXY_KEY}",
              baseURL: `http://127.0.0.1:${PORT}/v1`,
            },
            models: {
              "gpt-6-astra": {
                name: "GPT-6 Astra with adaptive effort",
                reasoning: true,
                options: { useResponses: true },
              },
            },
          },
        },
        model: "jev-router/gpt-6-astra",
        permission: {
          read: "allow",
          glob: "allow",
          grep: "allow",
          edit: "deny",
          write: "deny",
          bash: "deny",
        },
      },
      null,
      2,
    ),
  );

  const probeResults = {};
  const taskResults = {};
  const allEvidenceKeysOk = [];
  const allModelPinned = [];

  for (const tier of TIERS) {
    for (const [name, content] of Object.entries(tier.files)) {
      const path = `${workdir}/${name}`;
      mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      writeFileSync(path, content);
    }

    // Direct probe: same prompt, non-streaming, observes the reported top-level
    // effort (must stay at the base) plus the one evidence line for this tier.
    const probeStart = proxyEvidence.length;
    const probeRes = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.CLIPROXY_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-6-astra",
        reasoning: { effort: "low" },
        store: false,
        input: [{ role: "user", content: tier.prompt }],
      }),
      signal: AbortSignal.timeout(180000),
    });
    const probeJson = await probeRes.json();
    const probeLines = await settleEvidence(probeStart, 1);
    const probeMeta = probeLines.at(-1) ?? null;
    probeResults[tier.id] = {
      status: probeRes.status,
      reasoning_effort_reported: probeJson?.reasoning?.effort ?? null,
      selected_effort: probeMeta ? probeMeta.effort : null,
      fallback: probeMeta ? probeMeta.fallback : null,
      metadata: probeMeta ? summarize([probeMeta])[0] : null,
    };

    // Full-path OpenCode tool-using task.
    const taskStart = proxyEvidence.length;
    const oc = spawn(
      "opencode",
      [
        "run",
        "--dir",
        workdir,
        "-m",
        "jev-router/gpt-6-astra",
        "--format",
        "json",
        "--pure",
        tier.prompt,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let ocOut = "";
    oc.stdout.on("data", (c) => (ocOut += c.toString()));
    oc.stderr.on("data", (c) => (ocOut += c.toString()));
    console.log(`${tier.id} opencode running`);
    const ocClosed = once(oc, "close");
    const ocTimer = setTimeout(() => {
      console.log(`${tier.id} hard timeout, killing`);
      oc.kill();
    }, 120000);
    await ocClosed;
    clearTimeout(ocTimer);
    const taskLines = await settleEvidence(taskStart, 1);
    const toolUsed = ocOut.includes('"tool":') && ocOut.includes("completed");
    const completed = ocOut.includes(tier.expect);
    taskResults[tier.id] = {
      opencode_exit: oc.exitCode,
      tool_completed: toolUsed,
      marker_found: completed,
      turns: taskLines.length,
      first_turn_effort: taskLines[0] ? taskLines[0].effort : null,
      metadata: summarize(taskLines),
    };
    console.log(
      `${tier.id} done exit=${oc.exitCode} marker=${completed} tool=${toolUsed} first=${taskResults[tier.id].first_turn_effort}`,
    );
  }

  const everyLine = [
    ...Object.values(probeResults).map((p) => p.metadata),
    ...Object.values(taskResults).flatMap((t) => t.metadata),
  ].filter(Boolean);
  const keysOk = everyLine.every(
    (m) => JSON.stringify(m.keys) === JSON.stringify(ALLOWED_KEYS),
  );
  const modelOk = everyLine.every((m) => m.model === UPSTREAM_MODEL);
  const topLevels = Object.values(probeResults).map(
    (p) => p.reasoning_effort_reported,
  );
  const topLevelStable =
    topLevels.length === TIERS.length && topLevels.every((v) => v === JEV_ROUTER_BASE_EFFORT);

  const probeEfforts = TIERS.map((t) => probeResults[t.id].selected_effort);
  const firstTurnEfforts = TIERS.map((t) => taskResults[t.id].first_turn_effort);
  const easyProbe = probeEfforts[0];
  const hardProbe = probeEfforts[probeEfforts.length - 1];
  const easyTask = firstTurnEfforts[0];
  const hardTask = firstTurnEfforts[firstTurnEfforts.length - 1];
  const ladderOk = (easy, hard) =>
    easy != null &&
    hard != null &&
    ORDINAL[easy] !== undefined &&
    ORDINAL[hard] !== undefined &&
    ORDINAL[easy] <= ORDINAL[hard];

  const tasksComplete = TIERS.every(
    (t) =>
      taskResults[t.id].marker_found &&
      taskResults[t.id].tool_completed &&
      taskResults[t.id].opencode_exit === 0,
  );

  evidence.versions = {
    node: process.version,
    opencode: "1.18.32",
    cliproxyapi: "7.2.151",
  };
  evidence.steps = { probes: probeResults, tasks: taskResults };
  evidence.ladder = {
    probe_efforts: probeEfforts,
    first_turn_efforts: firstTurnEfforts,
  };
  evidence.pass = {
    task_completion: tasksComplete,
    outbound_model_pinned: modelOk,
    top_level_effort_stable: topLevelStable,
    easy_lte_hard_probe: ladderOk(easyProbe, hardProbe),
    easy_lte_hard_tasks: ladderOk(easyTask, hardTask),
    evidence_allowlisted: keysOk,
  };

  const passAll = Object.values(evidence.pass).every(Boolean);
  evidence.pass.all = passAll;

  writeFileSync(
    new URL("../../scratch/eval-live-matrix-evidence.json", import.meta.url),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence.ladder, null, 2));
  console.log(JSON.stringify(evidence.pass, null, 2));
  process.exitCode = passAll ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    process.kill(-proxy.pid, "SIGKILL");
  } catch {
    proxy.kill("SIGKILL");
  }
  proxy.stdout.destroy();
  proxy.stderr.destroy();
}
process.exit(process.exitCode ?? 0);
