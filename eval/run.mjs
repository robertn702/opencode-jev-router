import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
if (!task || !/^[a-zA-Z0-9_-]+$/.test(task.id) || !/^\w{40}$/.test(task.commit) ||
    typeof task.repo !== "string" || !task.repo.startsWith("/") ||
    typeof task.prompt !== "string" || !task.prompt.trim() ||
    !Array.isArray(task.grade) || !task.grade.length || !task.grade.every((v) => typeof v === "string" && v.length > 0)) {
  throw new Error("Task missing or invalid: require pinned repo, commit, prompt, grade argv");
}
const runId = `${task.id}-${model}-${arm}-${randomUUID()}`;
const dir = join(root, "eval/runs", runId);
const worktree = join(dir, "worktree");
await mkdir(dir, { recursive: true });
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
const checkout = await git(["-C", task.repo, "worktree", "add", "--detach", worktree, task.commit]);
if (checkout.code !== 0) throw new Error(`Failed to create worktree: ${checkout.stderr}`);

const result = { run_id: runId, task: task.id, model, arm, commit: task.commit, prepared: false, grade_passed: null, elapsed_ms: null, exit_code: null, timed_out: false, requests: 0, efforts: [], fallbacks: 0, input_tokens: null, cached_input_tokens: null, output_tokens: null };
try {
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [[join(root, "dist/plugin.js"), {
      ...(arm === "jev" ? { jevApiKey: "{env:JEV_API_KEY}", ...(process.env.JEV_BASE_URL ? { jevBaseUrl: process.env.JEV_BASE_URL } : {}) } : { fixedEffort: arm }),
      upstreamBaseURL: process.env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:8317/v1",
      upstreamApiKey: "{env:CLIPROXY_KEY}", decisionsLogPath: join(dir, "decisions.jsonl"),
    }]], model: `jev-router/${model}`,
  };
  await writeFile(join(dir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
  result.prepared = true;
  if (!prepareOnly) {
    if (!process.env.CLIPROXY_KEY || (arm === "jev" && !process.env.JEV_API_KEY)) throw new Error("Missing CLIPROXY_KEY or JEV_API_KEY");
    const start = performance.now();
    const oc = await run("opencode", ["run", "--dir", worktree, "--model", `jev-router/${model}`, "--format", "json", task.prompt], {
      cwd: worktree, timeoutMs: 15 * 60_000,
      env: { ...process.env, OPENCODE_CONFIG: join(dir, "opencode.json"), OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    });
    result.elapsed_ms = Math.round(performance.now() - start);
    result.exit_code = oc.code; result.timed_out = oc.timedOut;
    await writeFile(join(dir, "output.jsonl"), oc.stdout);
    await writeFile(join(dir, "stderr.log"), oc.stderr);
    // Intent-to-add captures new agent files without staging their contents.
    const added = await git(["add", "-N", "."], worktree);
    if (added.code !== 0) throw new Error(`Failed to capture new files: ${added.stderr}`);
    const patch = await git(["diff", "--binary", "HEAD"], worktree);
    if (patch.code !== 0) throw new Error(`Failed to capture patch: ${patch.stderr}`);
    await writeFile(join(dir, "patch.diff"), patch.stdout);
    if (oc.code === 0 && !oc.timedOut) {
      const grade = await run(task.grade[0], task.grade.slice(1), { cwd: worktree, timeoutMs: 120_000 });
      result.grade_passed = grade.code === 0 && !grade.timedOut;
      await writeFile(join(dir, "grade.log"), grade.stdout + grade.stderr);
    } else result.grade_passed = false;
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
  }
} finally {
  await writeFile(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const removed = await git(["-C", task.repo, "worktree", "remove", "--force", worktree]);
  if (removed.code !== 0) console.error(`Worktree cleanup failed: ${removed.stderr}`);
}
console.log(join(dir, "result.json"));
