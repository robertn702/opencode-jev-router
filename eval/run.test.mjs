import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
test("prepare-only creates an isolated task checkout and config without credentials or model calls", async () => {
  const temp = await mkdtemp(join(tmpdir(), "jev-eval-test-"));
  const repo = join(temp, "task-repo");
  const manifest = join(temp, "manifest.json");
  try {
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(join(repo, "hello.txt"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "hello.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Eval", "-c", "user.email=eval@example.test", "commit", "-qm", "fixture"]);
    const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(manifest, JSON.stringify({ tasks: [{ id: "offline-fixture", repo, commit, prompt: "Make a change", grade: ["node", "--version"] }] }));
    const path = execFileSync("node", ["eval/run.mjs", "--manifest", manifest, "--task", "offline-fixture", "--model", "gpt-6-sol", "--arm", "high", "--prepare-only"], { cwd: root, encoding: "utf8" }).trim();
    const result = JSON.parse(await readFile(path, "utf8"));
    const config = JSON.parse(await readFile(join(resolve(path, ".."), "opencode.json"), "utf8"));
    assert.equal(result.prepared, true);
    assert.equal(result.grade_passed, null);
    assert.equal(config.plugin[0][1].fixedEffort, "high");
    assert.equal(config.plugin[0][1].jevApiKey, undefined);
    assert.deepEqual((await readdir(join(resolve(path, "..")))).sort(), ["opencode.json", "result.json"]);
    assert.equal(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).match(/worktree /g)?.length, 1);
    await rm(resolve(path, ".."), { recursive: true, force: true });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
