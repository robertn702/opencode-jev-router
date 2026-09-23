import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createTlsServer } from "node:tls";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginPath = join(root, "dist", "plugin.js");
const opencode = process.env.OPENCODE_BIN ?? "opencode";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

// OpenCode's plugin config only permits the production TypeSafe URLs.  This
// CONNECT proxy terminates TLS for that exact hostname, so the SDK exercises
// its actual wire protocol while every connection remains on loopback.
async function fakeJevProxy(caDir, observed) {
  const key = join(caDir, "key.pem");
  const cert = join(caDir, "cert.pem");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.typesafe.ai", "-addext", "subjectAltName=DNS:api.typesafe.ai,DNS:models.opencode.ai,DNS:registry.npmjs.org", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const tls = createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, (socket) => {
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk;
      if (!raw.includes("\r\n\r\n")) return;
      const [head, body = ""] = raw.split("\r\n\r\n", 2);
      const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(`\r\n${head}`)?.[1] ?? 0);
      if (body.length < length) return;
      const requestLine = head.split("\r\n")[0];
      if (socket.servername === "models.opencode.ai") {
        observed.catalog = requestLine;
        const response = "[]";
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(response)}\r\nconnection: close\r\n\r\n${response}`);
        return;
      }
      if (socket.servername === "registry.npmjs.org") {
        observed.registry = requestLine;
        const response = "{}";
        socket.end(`HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(response)}\r\nconnection: close\r\n\r\n${response}`);
        return;
      }
      observed.jev = { requestLine, body: JSON.parse(body) };
      const response = JSON.stringify({ answers: { effort: { choice: "high" } } });
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(response)}\r\nconnection: close\r\n\r\n${response}`);
    });
  });
  const tlsPort = await listen(tls);
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    assert.ok(["api.typesafe.ai:443", "models.opencode.ai:443", "registry.npmjs.org:443"].includes(request.url), `blocked non-fake outbound host: ${request.url}`);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    tls.emit("connection", socket);
  });
  return { proxy, tls, port: await listen(proxy), cert };
}

const observed = {};
let upstream;
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

  upstream = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    observed.upstream = { headers: request.headers, body: JSON.parse(raw) };
    const events = [
      { type: "response.created", response: { id: "resp_smoke", object: "response", created_at: 0, status: "in_progress", model: "gpt-6-astra", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_smoke", type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: "msg_smoke", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg_smoke", output_index: 0, content_index: 0, delta: "smoke" },
      { type: "response.completed", response: { id: "resp_smoke", object: "response", created_at: 0, status: "completed", model: "gpt-6-astra", output: [{ id: "msg_smoke", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "smoke", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  const upstreamPort = await listen(upstream);
  const fake = await fakeJevProxy(ca, observed);
  ({ proxy, tls } = fake);
  const jevKeyFile = join(temp, "jev-key");
  await writeFile(jevKeyFile, "fake-jev-key");

  await writeFile(join(temp, "opencode.json"), JSON.stringify({
    plugin: [[pluginPath, { jevApiKey: `{file:${jevKeyFile}}`, upstreamBaseURL: `http://127.0.0.1:${upstreamPort}/v1`, upstreamApiKey: "{env:SMOKE_UPSTREAM_KEY}" }]],
    enabled_providers: ["jev-router"],
    autoupdate: false,
    share: "disabled",
  }, null, 2));

  const env = {
    HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache,
    OPENCODE_CONFIG: join(temp, "opencode.json"), OPENCODE_CONFIG_DIR: join(temp, "empty-config-dir"),
    HTTPS_PROXY: `http://127.0.0.1:${fake.port}`, HTTP_PROXY: `http://127.0.0.1:${fake.port}`,
    NODE_EXTRA_CA_CERTS: fake.cert, SSL_CERT_FILE: fake.cert, SMOKE_UPSTREAM_KEY: "fake-upstream-key",
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
  assert.ok(!(await exists(join(data, "opencode", "auth.json"))), "smoke must not create an auth.json credential store");
  console.log("PASS OpenCode 1.18.32 minimal plugin smoke: generated model, file/env options, fake Jev, rewritten Responses SSE, and no auth.json.");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (child && child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(2_000)]);
  if (upstream) await close(upstream);
  if (proxy) await close(proxy);
  if (tls) await close(tls);
  if (temp) await rm(temp, { recursive: true, force: true });
}
