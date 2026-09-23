import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod } from "node:fs/promises";
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
    await writeFile(manifest, JSON.stringify({ tasks: [{ id: "offline-fixture", repo, commit, prompt: "Make a change", grade: [process.execPath, "--version"] }] }));
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

test("offline agent attempt grades an immutable patch and rejects missing router evidence", async () => {
  const temp = await mkdtemp(join(tmpdir(), "jev-eval-offline-"));
  const repo = join(temp, "repo"); const bin = join(temp, "bin");
  const manifest = join(temp, "manifest.json"); const grader = join(temp, "grader.mjs");
  await mkdir(bin);
  try {
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(join(repo, "file.txt"), "before\n");
    execFileSync("git", ["-C", repo, "add", "file.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Eval", "-c", "user.email=eval@example.test", "commit", "-qm", "fixture"]);
    const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(grader, `import {readFileSync} from 'node:fs'; if (!readFileSync(process.env.EVAL_PATCH_PATH, 'utf8').includes('+after')) process.exit(1);`);
    await writeFile(manifest, JSON.stringify({ tasks: [{ id: "fake-agent", repo, commit, prompt: "Change file", grade: [process.execPath, grader] }] }));
    const fake = join(bin, "opencode");
    await writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync('file.txt','after\\n'); if(fs.existsSync(${JSON.stringify(join(temp, "evidence-on"))})){ const conf=JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG)); const p=conf.plugin[0][1].decisionsLogPath; fs.writeFileSync(p,JSON.stringify({model:'gpt-6-sol',effort:'high',outcome:'completed',input_tokens:3,cached_input_tokens:0,output_tokens:2})+'\\n'); } console.log(JSON.stringify({type:'step_finish'}));`);
    await chmod(fake, 0o755);
    for (const withEvidence of [true, false]) {
      if (withEvidence) await writeFile(join(temp, "evidence-on"), "yes");
      else await rm(join(temp, "evidence-on"));
      const path = execFileSync(process.execPath, ["eval/run.mjs", "--manifest", manifest, "--task", "fake-agent", "--model", "gpt-6-sol", "--arm", "high"], {
        cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLIPROXY_KEY: "offline" },
      }).trim();
      const result = JSON.parse(await readFile(path, "utf8"));
      assert.equal(result.grade_passed, true);
      assert.equal(result.evidence_valid, withEvidence);
      assert.equal(result.output_tokens, withEvidence ? 2 : null);
      assert.equal((await readFile(join(resolve(path, ".."), "patch.diff"), "utf8")).includes("+after"), true);
      assert.equal(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).match(/worktree /g)?.length, 1);
      await rm(resolve(path, ".."), { recursive: true, force: true });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
