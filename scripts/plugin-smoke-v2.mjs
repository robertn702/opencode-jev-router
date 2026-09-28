import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { close, exists, fakeAnthropicUpstream, fakeJevProxy, fakeRegistry, fakeResponsesUpstream, listen, run, sleep } from "./smoke-helpers.mjs";

// Pass a tarball to test a release artifact, or a version and binary to test
// another V2 runtime. CI defaults to 2.0.18.
const VERSION = process.env.OPENCODE_V2_VERSION ?? "2.0.18";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const observed = {};
let upstream;
let anthropic;
let registry;
let proxy;
let tls;
let child;
let temp;
try {
  // /tmp/opencode is deliberately outside this checkout. Its parent must exist
  // before this smoke creates its throwaway project, per the isolation contract.
  assert.ok(await exists("/tmp/opencode"), "/tmp/opencode must exist before running this smoke");
  temp = await mkdtemp("/tmp/opencode/jev-plugin-v2-");
  const dirs = Object.fromEntries(["home", "config", "data", "cache", "state", "ca", "project", "install", "cli"].map((name) => [name, join(temp, name)]));
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));

  const tarball = process.argv[2] ?? join(temp, JSON.parse(run("npm", ["--silent", "pack", "--json", "--pack-destination", temp], { cwd: root }))[0].filename);
  let opencode = process.env.OPENCODE_V2_BIN;
  if (!opencode) {
    run("npm", ["install", "--prefix", dirs.cli, "--no-audit", "--no-fund", `@opencode/cli@${VERSION}`], { stdio: "ignore" });
    opencode = join(dirs.cli, "node_modules", ".bin", "opencode");
  }
  assert.equal(run(opencode, ["--version"]).trim(), `opencode v${VERSION}`, `expected OpenCode ${VERSION}`);

  // OpenCode installs package plugins by name with Bun. Serve the packed
  // plugin and its production dependencies from a loopback registry.
  run("npm", ["install", "--prefix", dirs.install, "--omit=dev", "--no-audit", "--no-fund", tarball], { stdio: "ignore" });
  const installed = JSON.parse(await readFile(join(dirs.install, "node_modules", "@robertn702", "opencode-jev-router", "package.json"), "utf8"));
  const dependencies = Object.keys(installed.dependencies ?? {}).map((name) => join(dirs.install, "node_modules", name));
  for (const dependency of dependencies) {
    const manifest = JSON.parse(await readFile(join(dependency, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], `${manifest.name} has transitive dependencies the fake registry does not serve`);
  }
  const dependencyTarballs = dependencies.map((dependency) => join(temp, JSON.parse(run("npm", ["--silent", "pack", "--json", "--pack-destination", temp, dependency]))[0].filename));
  const fakeNpm = await fakeRegistry([tarball, ...dependencyTarballs], observed);
  registry = fakeNpm.server;

  upstream = fakeResponsesUpstream(observed);
  const upstreamPort = await listen(upstream);
  anthropic = fakeAnthropicUpstream(observed);
  const anthropicPort = await listen(anthropic);
  const fake = await fakeJevProxy(dirs.ca, observed);
  ({ proxy, tls } = fake);
  const jevKeyFile = join(temp, "jev-key");
  const decisionsLogPath = join(temp, "decisions", "plugin.jsonl");
  await writeFile(jevKeyFile, "fake-jev-key");

  const env = {
    HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
    HTTPS_PROXY: `http://127.0.0.1:${fake.port}`, HTTP_PROXY: `http://127.0.0.1:${fake.port}`,
    NODE_EXTRA_CA_CERTS: fake.cert, SSL_CERT_FILE: fake.cert,
    NPM_CONFIG_REGISTRY: fakeNpm.url, npm_config_registry: fakeNpm.url, BUN_CONFIG_REGISTRY: fakeNpm.url,
    SMOKE_UPSTREAM_KEY: "fake-upstream-key", OPENAI_API_KEY: "fake-user-key", ANTHROPIC_API_KEY: "fake-anthropic-key",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    PATH: process.env.PATH, LANG: "C", TERM: "dumb",
  };
  const plugins = [{ package: `${installed.name}@${installed.version}`, options: { jevApiKey: `{file:${jevKeyFile}}`, wrap: { openai: ["gw/gpt-6-astra", "gw/gpt-6-luna", "openai/gpt-6-sol"], anthropic: ["anthropic/claude-opus-5-5"] }, decisionsLogPath } }];
  const providers = {
    gw: { package: "@opencode/ai/providers/openai/responses", settings: { baseURL: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "{env:SMOKE_UPSTREAM_KEY}" }, models: Object.fromEntries(["gpt-6-astra", "gpt-6-luna"].map((id) => [id, { name: id, limit: { context: 200000, output: 32000 } }])) },
    openai: { package: "@opencode/ai/providers/openai/responses", settings: { baseURL: `http://127.0.0.1:${upstreamPort}/v1` }, models: { "gpt-6-sol": { name: "Sol", limit: { context: 200000, output: 32000 } } } },
    anthropic: { package: "@opencode/ai/providers/anthropic", settings: { baseURL: `http://127.0.0.1:${anthropicPort}/v1` }, models: { "claude-opus-5-5": { name: "Opus", limit: { context: 200000, output: 32000 } } } },
  };

  async function opencodeRun(model, config = {}) {
    await writeFile(join(dirs.project, "opencode.json"), JSON.stringify({ plugins, providers, autoupdate: false, share: "disabled", ...config }, null, 2));
    const before = observed.upstreamCount ?? 0;
    child = spawn(opencode, ["run", "--standalone", "--format", "json", "--model", model.includes("/") ? model : `jev-router/${model}`, "Reply with smoke."], { cwd: dirs.project, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exit = await new Promise((resolve) => child.once("exit", resolve));
    if (exit !== 0) {
      const log = await readFile(join(dirs.data, "opencode", "log", "opencode.log"), "utf8").catch(() => "");
      output += `\n${log.split("\n").filter((line) => /plugin|level=(WARN|ERROR)/.test(line)).join("\n")}`;
    }
    assert.equal(exit, 0, `OpenCode failed:\n${output}`);
    assert.doesNotMatch(output, /"type":"error"/, `OpenCode reported an error:\n${output}`);
    assert.match(output, /smoke/, "OpenCode did not consume the fake Responses SSE completion");
    return observed.upstreams.slice(before);
  }

  // Plugin defaults: generated provider, plugin credential, and Jev rewrite.
  const requests = await opencodeRun("gpt-6-astra");
  assert.ok(requests.length > 0, "the fake Responses upstream received no request");
  assert.ok(observed.jev, "the fake Jev classifier received no SDK request");
  assert.match(observed.jev.requestLine, /^POST /);
  assert.match(observed.jev.authorization ?? "", /fake-jev-key/, "the {file:} Jev key option was not resolved");
  assert.equal(observed.jev.body.questions.effort.type, "choice");
  const primary = requests.filter((request) => request.body.input?.some((item) => item.type === "configuration_update"));
  assert.ok(primary.length > 0, "no primary request received a Jev update");
  assert.equal((await readFile(decisionsLogPath, "utf8")).trim().split("\n").length, primary.length, "title requests must not log decisions");
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.body.model, "gpt-6-astra");
    if (primary.includes(request)) {
      assert.deepEqual(request.body.reasoning, { effort: "medium" });
      assert.equal(request.body.input.at(-2)?.type, "configuration_update");
      assert.equal(request.body.input.at(-2)?.reasoning?.effort, "high");
    } else assert.ok(!request.body.input?.some((item) => item.type === "configuration_update"));
    assert.equal(request.headers.authorization, "Bearer fake-upstream-key");
  }

  // The built-in provider supplies its integration credential, without an alias key.
  const overridden = await opencodeRun("gpt-6-sol");
  for (const request of overridden) {
    assert.equal(request.body.model, "gpt-6-sol");
    assert.equal(request.headers.authorization, "Bearer fake-user-key");
    if (request.body.input?.some((item) => item.type === "configuration_update")) assert.equal(request.body.input.at(-2)?.reasoning?.effort, "high");
  }

  // V2 also normalizes the legacy tuple config and routes the same way.
  for (const request of await opencodeRun("gpt-6-luna", { plugins: undefined, plugin: [[plugins[0].package, plugins[0].options]] })) {
    assert.equal(request.body.model, "gpt-6-luna");
    if (request.body.input?.some((item) => item.type === "configuration_update")) assert.equal(request.body.input.at(-2)?.reasoning?.effort, "high");
  }

  await opencodeRun("claude-opus-5-5");
  assert.equal(observed.anthropic?.url, "/v1/messages", "Claude did not use the Messages endpoint");
  assert.equal(observed.anthropic?.method, "POST");
  assert.equal(observed.anthropic?.headers["x-api-key"], "fake-anthropic-key");
  assert.equal(observed.anthropic?.headers.authorization, undefined);
  assert.match(observed.anthropic?.headers["anthropic-beta"] ?? "", /mid-conversation-output-config/);
  assert.ok(observed.anthropic?.body.messages.some((message) => message.role === "system" && message.output_config?.effort === "high"));

  const beforeDirect = { jev: observed.jevCount, decisions: (await readFile(decisionsLogPath, "utf8")).trim().split("\n").length };
  const direct = await opencodeRun("gw/gpt-6-astra");
  assert.ok(direct.length > 0 && direct.every((request) => !request.body.input?.some((item) => item.type === "configuration_update")));
  assert.equal(observed.jevCount, beforeDirect.jev, "the source model must not call Jev");
  assert.equal((await readFile(decisionsLogPath, "utf8")).trim().split("\n").length, beforeDirect.decisions);

  assert.ok(observed.registryRequests?.includes(installed.name), "OpenCode did not install the plugin from the fake registry");
  assert.equal(observed.blocked, undefined, `blocked non-fake outbound hosts: ${observed.blocked}`);
  const decisions = (await readFile(decisionsLogPath, "utf8")).trim().split("\n");
  assert.ok(decisions.length > 0 && decisions.length < observed.upstreamCount + observed.anthropicCount, "only wrapped primary requests should produce decisions");
  const events = decisions.map((line) => JSON.parse(line));
  assert.equal(new Set(events.map((event) => event.request_id)).size, events.length);
  for (const decision of events) {
    assert.equal(decision.event, "JevDecision");
    assert.match(decision.session, /^ses_/);
    assert.match(decision.turn_id, /^[0-9a-f-]{36}$/i);
    assert.match(decision.model, /^(gpt-6-(astra|luna|sol)|claude-opus-5-5)$/);
    assert.equal(decision.effort, "high");
    assert.equal(decision.fallback, null);
    assert.equal(decision.outcome, "completed");
    assert.equal(decision.input_tokens, 1);
    assert.equal(decision.output_tokens, 1);
  }
  const log = decisions.join("\n");
  assert.ok(!/fake-upstream-key|fake-user-key|fake-jev-key|Reply with smoke/.test(log), "decision log leaked a credential or prompt");
  console.log(`PASS OpenCode ${VERSION} packaged plugin smoke (${installed.name}@${installed.version}): Responses and Claude Messages SSE, fake Jev, correlated JevDecision.`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (child && child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(2_000)]);
  if (upstream) await close(upstream);
  if (anthropic) await close(anthropic);
  if (registry) await close(registry);
  if (proxy) await close(proxy);
  if (tls) await close(tls);
  if (temp) await rm(temp, { recursive: true, force: true });
}
