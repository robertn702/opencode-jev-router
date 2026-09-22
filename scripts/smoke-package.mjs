import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const temp = await mkdtemp(join(tmpdir(), "jev-package-"));
let child;
try {
  const tarball = process.argv[2] ?? join(temp, JSON.parse(run("npm", ["--silent", "pack", "--json", "--pack-destination", temp]))[0].filename);
  const paths = run("tar", ["-tzf", tarball]).trim().split("\n").map((path) => path.replace(/^package\//, ""));
  for (const required of ["dist/index.js", "README.md", "LICENSE", "examples/opencode.jsonc"]) {
    assert.ok(paths.includes(required), `package is missing ${required}`);
  }
  assert.ok(paths.every((path) =>
    !path.startsWith("test/") && !path.startsWith("src/") && !path.startsWith("scripts/") &&
    !path.startsWith("dist/test/") && !path.endsWith(".ts")
  ), `package includes development files: ${paths.join(", ")}`);

  run("npm", ["install", "--prefix", temp, "--omit=dev", "--no-audit", "--no-fund", tarball]);
  const binary = join(temp, "node_modules", ".bin", "opencode-jev-router");
  const help = run(binary, ["--help"], { cwd: temp, env: { ...process.env, TYPESAFE_API_KEY: "" } });
  assert.match(help, /Usage: opencode-jev-router/);

  const port = await unusedPort();
  child = spawn(binary, [], {
    cwd: temp,
    env: { ...process.env, TYPESAFE_API_KEY: "smoke-test-key", JEV_PROXY_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) { healthy = true; break; }
    } catch { /* Wait for the server to bind. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(healthy, `installed CLI did not start and serve /health:\n${output}`);
  const installed = JSON.parse(await readFile(join(temp, "node_modules", "@robertn702", "opencode-jev-router", "package.json"), "utf8"));
  console.log(`Packed and ran ${installed.name}@${installed.version} with production dependencies only.`);
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
