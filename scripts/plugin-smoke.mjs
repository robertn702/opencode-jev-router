import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { close, exists, fakeAnthropicUpstream, fakeJevProxy, fakeResponsesUpstream, listen, run, sleep } from "./smoke-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginPath = join(root, "dist", "plugin.js");
const opencode = process.env.OPENCODE_BIN ?? "opencode";

const observed = {};
let upstream;
let anthropic;
let proxy;
let tls;
let child;
let temp;
try {
  assert.equal(run(opencode, ["--version"]).trim(), "1.18.32", "this smoke is pinned to OpenCode 1.18.32");
  assert.ok(await exists(pluginPath), "dist/plugin.js is missing; run npm run build first");
  const local = await import(pathToFileURL(pluginPath).href);
  const exported = await import("@robertn702/opencode-jev-router/server");
  assert.equal(exported.default, local.default, "package ./server must resolve to dist/plugin.js");

  // /tmp/opencode is deliberately outside this checkout. Its parent must exist
  // before this smoke creates its throwaway project, per the isolation contract.
  assert.ok(await exists("/tmp/opencode"), "/tmp/opencode must exist before running this smoke");
  temp = await mkdtemp("/tmp/opencode/jev-plugin-");
  const home = join(temp, "home");
  const config = join(temp, "config");
  const data = join(temp, "data");
  const cache = join(temp, "cache");
  const ca = join(temp, "ca");
  await Promise.all(["home", "config", "data", "cache", "ca", "empty-config-dir"].map((name) => mkdir(join(temp, name), { recursive: true })));

  upstream = fakeResponsesUpstream(observed);
  const upstreamPort = await listen(upstream);
  anthropic = fakeAnthropicUpstream(observed);
  const anthropicPort = await listen(anthropic);
  const fake = await fakeJevProxy(ca, observed);
  ({ proxy, tls } = fake);
  const jevKeyFile = join(temp, "jev-key");
  const decisionsLogPath = join(temp, "decisions", "plugin.jsonl");
  await writeFile(jevKeyFile, "fake-jev-key");

  await writeFile(join(temp, "opencode.json"), JSON.stringify({
    plugin: [[pluginPath, { jevApiKey: `{file:${jevKeyFile}}`, upstreamBaseURL: `http://127.0.0.1:${upstreamPort}/v1`, upstreamApiKey: "{env:SMOKE_UPSTREAM_KEY}", anthropicUpstreamBaseURL: `http://127.0.0.1:${anthropicPort}/v1`, anthropicUpstreamApiKey: "{env:SMOKE_ANTHROPIC_KEY}", decisionsLogPath }]],
    enabled_providers: ["jev-router"],
    autoupdate: false,
    share: "disabled",
  }, null, 2));

  const env = {
    HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache,
    OPENCODE_CONFIG: join(temp, "opencode.json"), OPENCODE_CONFIG_DIR: join(temp, "empty-config-dir"),
    HTTPS_PROXY: `http://127.0.0.1:${fake.port}`, HTTP_PROXY: `http://127.0.0.1:${fake.port}`,
    NODE_EXTRA_CA_CERTS: fake.cert, SSL_CERT_FILE: fake.cert, SMOKE_UPSTREAM_KEY: "fake-upstream-key", SMOKE_ANTHROPIC_KEY: "fake-anthropic-key",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    PATH: process.env.PATH, LANG: "C", TERM: "dumb",
  };
  child = spawn(opencode, ["run", "--format", "json", "--model", "jev-router/gpt-6-astra", "Reply with smoke."], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exit = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exit, 0, `OpenCode failed:\n${output}`);
  assert.match(output, /smoke/, "OpenCode did not consume the fake Responses SSE completion");
  assert.equal(observed.blocked, undefined, `blocked non-fake outbound hosts: ${observed.blocked}`);
  assert.ok(observed.upstreams.every((request) => request.method === "POST" && request.url === "/v1/responses"));
  assert.ok(observed.jev, "the fake Jev classifier received no SDK request");
  assert.match(observed.jev.requestLine, /^POST /);
  assert.equal(observed.jev.body.questions.effort.type, "choice");
  assert.ok(observed.upstream, "the fake Responses upstream received no request");
  assert.equal(observed.upstream.body.model, "gpt-6-astra");
  assert.deepEqual(observed.upstream.body.reasoning, { effort: "medium" });
  assert.equal(observed.upstream.body.input.at(-2)?.type, "configuration_update");
  assert.equal(observed.upstream.body.input.at(-2)?.reasoning?.effort, "high");
  assert.equal(observed.upstream.headers["x-jev-session-id"], undefined);
  assert.equal(observed.upstream.headers["x-jev-turn-id"], undefined);
  assert.equal(observed.upstream.headers.authorization, "Bearer fake-upstream-key");
  child = spawn(opencode, ["run", "--format", "json", "--model", "jev-router/claude-opus-5-5", "Reply with smoke."], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] });
  let claudeOutput = "";
  child.stdout.on("data", (chunk) => { claudeOutput += chunk; });
  child.stderr.on("data", (chunk) => { claudeOutput += chunk; });
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0, `OpenCode Claude failed:\n${claudeOutput}`);
  assert.match(claudeOutput, /smoke/);
  assert.equal(observed.anthropic?.url, "/v1/messages");
  assert.equal(observed.anthropic?.method, "POST");
  assert.equal(observed.anthropic?.headers["x-api-key"], "fake-anthropic-key");
  assert.equal(observed.anthropic?.headers.authorization, undefined);
  assert.match(observed.anthropic?.headers["anthropic-beta"] ?? "", /mid-conversation-output-config/);
  assert.ok(observed.anthropic?.body.messages.some((message) => message.role === "system" && message.output_config?.effort === "high"));
  const decisions = (await readFile(decisionsLogPath, "utf8")).trim().split("\n");
  assert.equal(decisions.length, observed.upstreamCount + observed.anthropicCount, "each request should produce one decision");
  const events = decisions.map((line) => JSON.parse(line));
  assert.equal(new Set(events.map((event) => event.request_id)).size, events.length);
  for (const decision of events) {
    assert.equal(decision.event, "JevDecision");
    assert.match(decision.session, /^ses_/);
    assert.match(decision.turn_id, /^[0-9a-f-]{36}$/i);
    assert.equal(decision.effort, "high");
    assert.equal(decision.fallback, null);
    assert.equal(decision.outcome, "completed");
    assert.equal(decision.input_tokens, 1);
    assert.equal(decision.output_tokens, 1);
  }
  assert.ok(!decisions.join("\n").includes("fake-upstream-key"));
  assert.ok(!(await exists(join(data, "opencode", "auth.json"))), "smoke must not create an auth.json credential store");
  console.log("PASS OpenCode 1.18.32 plugin smoke: Responses and Claude Messages SSE, fake Jev, correlated JevDecision, and no auth.json.");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (child && child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(2_000)]);
  if (upstream) await close(upstream);
  if (anthropic) await close(anthropic);
  if (proxy) await close(proxy);
  if (tls) await close(tls);
  if (temp) await rm(temp, { recursive: true, force: true });
}
