import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

export async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

export async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/** A fake Responses upstream that streams one completed SSE response per request. */
export function fakeResponsesUpstream(observed) {
  return createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    observed.upstreamCount = (observed.upstreamCount ?? 0) + 1;
    observed.upstreams = [...(observed.upstreams ?? []), { method: request.method, url: request.url, headers: request.headers, body: JSON.parse(raw) }];
    observed.upstream = observed.upstreams.at(-1);
    const events = [
      { type: "response.created", response: { id: "resp_smoke", object: "response", created_at: 0, status: "in_progress", model: "gpt-6-astra", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_smoke", type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: "msg_smoke", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg_smoke", output_index: 0, content_index: 0, delta: "smoke" },
      { type: "response.output_text.done", item_id: "msg_smoke", output_index: 0, content_index: 0, text: "smoke" },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_smoke", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "smoke", annotations: [] }] } },
      { type: "response.completed", response: { id: "resp_smoke", object: "response", created_at: 0, status: "completed", model: "gpt-6-astra", output: [{ id: "msg_smoke", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "smoke", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
}

/** A local Anthropic Messages SSE endpoint for both OpenCode plugin smokes. */
export function fakeAnthropicUpstream(observed) {
  return createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    observed.anthropicCount = (observed.anthropicCount ?? 0) + 1;
    observed.anthropic = { method: request.method, url: request.url, headers: request.headers, body: JSON.parse(raw) };
    const events = [
      { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "smoke" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
}

// OpenCode's plugin config only permits the production TypeSafe URLs.  This
// CONNECT proxy terminates TLS for that exact hostname, so the SDK exercises
// its actual wire protocol while every connection remains on loopback. Other
// hosts OpenCode contacts get canned local answers; anything else is refused
// and recorded in `observed.blocked`.
export async function fakeJevProxy(caDir, observed) {
  const key = join(caDir, "key.pem");
  const cert = join(caDir, "cert.pem");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.typesafe.ai", "-addext", "subjectAltName=DNS:api.typesafe.ai,DNS:models.opencode.ai,DNS:registry.npmjs.org,DNS:models.dev", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const tls = createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, (socket) => {
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk;
      if (!raw.includes("\r\n\r\n")) return;
      const [head, body = ""] = raw.split("\r\n\r\n", 2);
      const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(`\r\n${head}`)?.[1] ?? 0);
      if (body.length < length) return;
      const requestLine = head.split("\r\n")[0];
      const reply = (status, text) => socket.end(`HTTP/1.1 ${status}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
      if (socket.servername === "models.opencode.ai" || socket.servername === "models.dev") {
        observed.catalog = requestLine;
        reply("200 OK", socket.servername === "models.dev" ? "{}" : "[]");
        return;
      }
      if (socket.servername === "registry.npmjs.org") {
        observed.registry = requestLine;
        reply("503 Service Unavailable", "{}");
        return;
      }
      observed.jevCount = (observed.jevCount ?? 0) + 1;
      observed.jev = { requestLine, authorization: /\r\nauthorization:\s*([^\r]*)/i.exec(`\r\n${head}`)?.[1] ?? null, body: JSON.parse(body) };
      reply("200 OK", JSON.stringify({ answers: { effort: { choice: "high" } } }));
    });
  });
  const tlsPort = await listen(tls);
  void tlsPort;
  const allowed = ["api.typesafe.ai:443", "models.opencode.ai:443", "registry.npmjs.org:443", "models.dev:443"];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    if (!allowed.includes(request.url)) {
      observed.blocked = [...(observed.blocked ?? []), request.url];
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    tls.emit("connection", socket);
  });
  return { proxy, tls, port: await listen(proxy), cert };
}

/**
 * A loopback npm registry serving only the given tarballs, so OpenCode V2 can
 * install a plugin by package name without reaching the public registry.
 */
export async function fakeRegistry(tarballs, observed) {
  const packages = new Map();
  for (const path of tarballs) {
    const manifest = JSON.parse(run("tar", ["-xzOf", path, "package/package.json"]));
    const data = await readFile(path);
    packages.set(manifest.name, { manifest, data, integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`, shasum: createHash("sha1").update(data).digest("hex") });
  }
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://registry").pathname).replace(/^\//, "");
    observed.registryRequests = [...(observed.registryRequests ?? []), path];
    const tarball = /^(.+)\/-\/[^/]+\.tgz$/.exec(path);
    const entry = packages.get(tarball ? tarball[1] : path);
    if (!entry) { response.writeHead(404, { "content-type": "application/json" }).end("{}"); return; }
    if (tarball) { response.writeHead(200, { "content-type": "application/octet-stream" }).end(entry.data); return; }
    const { name, version } = entry.manifest;
    const base = `http://127.0.0.1:${server.address().port}`;
    const packument = { name, "dist-tags": { latest: version }, versions: { [version]: { ...entry.manifest, dist: { tarball: `${base}/${name}/-/${name.split("/").at(-1)}-${version}.tgz`, integrity: entry.integrity, shasum: entry.shasum } } } };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(packument));
  });
  return { server, url: `http://127.0.0.1:${await listen(server)}/` };
}
