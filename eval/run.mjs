import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileEvidence } from "./evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const prepareOnly = args.includes("--prepare-only");
const taskId = option("--task");
const model = option("--model");
const arm = option("--arm");
if (!taskId || !["gpt-6-astra", "gpt-6-sol"].includes(model) || !["medium", "high", "jev"].includes(arm)) {
  throw new Error("Usage: node eval/run.mjs --task ID --model gpt-6-astra|gpt-6-sol --arm medium|high|jev [--prepare-only]");
}
const manifest = JSON.parse(await readFile(resolve(option("--manifest") ?? join(root, "eval/tasks.json")), "utf8"));
const task = manifest.tasks.find((item) => item.id === taskId);
const remote = typeof task?.repo === "string" && /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\.git$/.test(task.repo);
const grader = task?.grade === "swebench" ? [join(root, "eval/grade-swebench.mjs"), task.id] : task?.grade;
if (!task || !/^[a-zA-Z0-9_-]+$/.test(task.id) || !/^\w{40}$/.test(task.commit) ||
    typeof task.repo !== "string" || !(task.repo.startsWith("/") || remote) ||
    typeof task.prompt !== "string" || !task.prompt.trim() ||
    !Array.isArray(grader) || !grader.length || !grader.every((v) => typeof v === "string" && v.length > 0) ||
    !grader[0].startsWith("/") || grader.some((arg) => arg === task.repo || arg.startsWith(`${task.repo}/`)) ||
    resolve(task.repo) === root || root.startsWith(`${resolve(task.repo)}/`)) {
  throw new Error("Task missing or invalid: require pinned repo, commit, prompt, independent absolute grader argv");
}
const runId = `${task.id}-${model}-${arm}-${randomUUID()}`;
const dir = join(root, "eval/runs", runId);
const worktree = join(dir, "worktree");
const taskRepo = remote ? join(dir, "source.git") : task.repo;
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const save = async (name, contents) => writeFile(join(dir, name), contents, { mode: 0o600 });
const run = (command, argv, opts = {}) => new Promise((done, reject) => {
  const child = spawn(command, argv, { cwd: opts.cwd ?? root, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = []; const stderr = [];
  child.stdout.on("data", (part) => stdout.push(part));
  child.stderr.on("data", (part) => stderr.push(part));
  let timedOut = false;
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs) : null;
  child.on("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
  child.on("close", (code) => { if (timer) clearTimeout(timer); done({ code, timedOut, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }); });
});
const git = (argv, cwd) => run("git", argv, { cwd });
if (remote) {
  const initialized = await git(["init", "--bare", taskRepo]);
  if (initialized.code !== 0) throw new Error(`Failed to initialize task source: ${initialized.stderr}`);
  const fetched = await git(["-C", taskRepo, "fetch", "--depth=1", "--no-tags", task.repo, task.commit]);
  if (fetched.code !== 0) throw new Error(`Failed to fetch pinned task commit: ${fetched.stderr}`);
}
const checkout = await git(["-C", taskRepo, "worktree", "add", "--detach", worktree, task.commit]);
if (checkout.code !== 0) throw new Error(`Failed to create worktree: ${checkout.stderr}`);

const result = { run_id: runId, run_set: process.env.EVAL_RUN_SET ?? null, task: task.id, model, arm, commit: task.commit, prepared: false, grade_passed: null, grader_error: false, elapsed_ms: null, exit_code: null, timed_out: false, requests: 0, efforts: [], fallbacks: 0, input_tokens: null, cached_input_tokens: null, output_tokens: null };
try {
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [[join(root, "dist/plugin.js"), {
      ...(arm === "jev" ? { jevApiKey: "{env:JEV_API_KEY}", jevBaseUrl: process.env.JEV_BASE_URL ?? "https://ai-gateway.vercel.sh/typesafe" } : { fixedEffort: arm }),
      upstreamBaseURL: process.env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:8317/v1",
      upstreamApiKey: "{env:CLIPROXY_KEY}", decisionsLogPath: join(dir, "decisions.jsonl"),
    }]], model: `jev-router/${model}`,
  };
  await save("opencode.json", `${JSON.stringify(config, null, 2)}\n`);
  result.prepared = true;
  if (!prepareOnly) {
    if (!process.env.CLIPROXY_KEY || (arm === "jev" && !process.env.JEV_API_KEY)) throw new Error("Missing CLIPROXY_KEY or JEV_API_KEY");
    const home = join(dir, "home");
    await mkdir(home, { mode: 0o700 });
    for (const name of ["config", "data", "cache", "state"]) await mkdir(join(home, name), { mode: 0o700 });
    const start = performance.now();
    const oc = await run("opencode", ["run", "--dir", worktree, "--model", `jev-router/${model}`, "--format", "json", task.prompt], {
      cwd: worktree, timeoutMs: 15 * 60_000,
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
        CLIPROXY_KEY: process.env.CLIPROXY_KEY, ...(arm === "jev" ? { JEV_API_KEY: process.env.JEV_API_KEY } : {}),
        OPENCODE_CONFIG: join(dir, "opencode.json"), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" },
    });
    result.elapsed_ms = Math.round(performance.now() - start);
    result.exit_code = oc.code; result.timed_out = oc.timedOut;
    await save("output.jsonl", oc.stdout);
    await save("stderr.log", oc.stderr);
    // Intent-to-add captures new agent files without staging their contents.
    const added = await git(["add", "-N", "."], worktree);
    if (added.code !== 0) throw new Error(`Failed to capture new files: ${added.stderr}`);
    const patch = await git(["diff", "--binary", task.commit], worktree);
    if (patch.code !== 0) throw new Error(`Failed to capture patch: ${patch.stderr}`);
    await save("patch.diff", patch.stdout);
    if (oc.code === 0 && !oc.timedOut) {
      // The grader runs outside the agent-writable checkout and receives only
      // its patch and pinned source. An adapter must apply the patch to a fresh
      // checkout and use tests that are not taken from agent-modified files.
      const dockerEnv = Object.fromEntries(["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
      const grade = await run(grader[0], grader.slice(1), { cwd: dir, timeoutMs: task.grade === "swebench" ? 30 * 60_000 : 120_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...dockerEnv,
          ...(process.env.SWE_BENCH_DATASET_PATH ? { SWE_BENCH_DATASET_PATH: process.env.SWE_BENCH_DATASET_PATH } : {}),
          ...(process.env.SWE_BENCH_PYTHON ? { SWE_BENCH_PYTHON: process.env.SWE_BENCH_PYTHON } : {}),
          EVAL_PATCH_PATH: join(dir, "patch.diff"), EVAL_TASK_REPO: taskRepo, EVAL_TASK_COMMIT: task.commit } });
      result.grader_error = grade.timedOut || (grade.code !== 0 && grade.code !== 1);
      result.grade_passed = result.grader_error ? null : grade.code === 0;
      await save("grade.log", grade.stdout + grade.stderr);
    } // An incomplete agent run was not submitted to the benchmark grader.
    // Decision logging is asynchronous; allow the queue to flush after OpenCode exits.
    let evidence = ""; let stable = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((done) => setTimeout(done, 100));
      let next = "";
      try { next = await readFile(join(dir, "decisions.jsonl"), "utf8"); } catch { /* no decisions yet */ }
      stable = next && next === evidence ? stable + 1 : 0;
      evidence = next;
      if (stable >= 3) break;
    }
    const events = evidence.trim().split("\n").filter(Boolean).map(JSON.parse);
    result.requests = events.length;
    result.efforts = events.map((e) => e.effort);
    result.fallbacks = events.filter((e) => e.fallback).length;
    for (const field of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
      if (events.length && events.every((e) => Number.isFinite(e[field]))) result[field] = events.reduce((sum, e) => sum + e[field], 0);
    }
    const output = oc.stdout.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const reconciliation = reconcileEvidence(events, output);
    result.auxiliary_requests = reconciliation?.auxiliary ?? null;
    result.evidence_valid = events.length > 0 && events.every((e) => e.model === model && e.outcome === "completed" && (arm === "jev" || e.effort === arm)) &&
      reconciliation !== null;
    if (!result.evidence_valid) { result.input_tokens = null; result.cached_input_tokens = null; result.output_tokens = null; }
  }
} finally {
  await save("result.json", `${JSON.stringify(result, null, 2)}\n`);
  const removed = await git(["-C", taskRepo, "worktree", "remove", "--force", worktree]);
  if (removed.code !== 0) console.error(`Worktree cleanup failed: ${removed.stderr}`);
  if (remote) await (await import("node:fs/promises")).rm(taskRepo, { recursive: true, force: true });
}
console.log(join(dir, "result.json"));
