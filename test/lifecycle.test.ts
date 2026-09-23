import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAppServer, shutdownAppServer, type AppServerOptions } from "../src/server.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (!server.listening) continue;
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function app(options: Partial<AppServerOptions> = {}): http.Server {
  return createAppServer({ upstreamBaseUrl: "http://127.0.0.1:9", upstreamAuth: { mode: "cliproxyapi" }, upstreamModel: "astra",
    baseEffort: "medium", ...options });
}

const input = JSON.stringify({ input: [{ role: "user", content: "hi" }] });

describe("lifecycle and readiness", () => {
  it("reports ready, missing configuration and unavailable dependencies without probing health", async () => {
    let probes = 0;
    const server = app({ probeDependency: async () => { probes++; return true; } });
    const url = await listen(server);
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: "ok" });
    expect(probes).toBe(0);
    expect(await (await fetch(`${url}/ready`)).json()).toEqual({ status: "ready" });
    expect(probes).toBe(1);
    await (await fetch(`${url}/ready`)).text();
    expect(probes).toBe(1);

    const missing = await listen(app({ configurationValid: false }));
    const unavailable = await listen(app({ probeDependency: async () => false }));
    expect(await (await fetch(`${missing}/ready`)).json()).toEqual({ status: "not_ready", reason: "missing_configuration" });
    const result = await fetch(`${unavailable}/ready`);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ status: "not_ready", reason: "dependency_unavailable" });
  });

  it("bounds a stalled dependency probe", async () => {
    const url = await listen(app({ probeDependency: () => new Promise(() => {}) }));
    const started = Date.now();
    const result = await fetch(`${url}/ready`);
    expect(result.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("switches readiness to draining while a probe is in progress", async () => {
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    let finish!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { finish = resolve; });
    const server = app({ probeDependency: () => { probeStarted(); return gate; } });
    const url = await listen(server);
    const readiness = fetch(`${url}/ready`);
    await started;
    const draining = shutdownAppServer(server, 2_000);
    finish(true);
    const result = await readiness;
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ status: "not_ready", reason: "draining" });
    await draining;
  });

  it("drains active work, rejects new work, and ignores repeated shutdown calls", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: (value: { effort: "medium"; jevLatencyMs: number; fallback: null }) => void;
    const decision = new Promise<{ effort: "medium"; jevLatencyMs: number; fallback: null }>((resolve) => { finish = resolve; });
    const upstream = http.createServer((_request, response) => response.end("ok"));
    const upstreamUrl = await listen(upstream);
    const server = app({ upstreamBaseUrl: upstreamUrl, selectEffort: () => { entered(); return decision; } });
    const url = await listen(server);
    const agent = new http.Agent({ keepAlive: true });
    try {
      const pending = fetch(`${url}/v1/responses`, { method: "POST", body: input });
      await started;
      const shutdown = shutdownAppServer(server, 2_000);
      expect(shutdownAppServer(server, 1)).toBe(shutdown);
      // A request already accepted on an existing connection is rejected at the gate.
      const blocked = await new Promise<number>((resolve, reject) => {
        http.get(`${url}/v1/models`, { agent }, (response) => {
          response.resume(); response.on("end", () => resolve(response.statusCode!));
        }).on("error", reject);
      }).catch(() => 503); // listener may already have stopped accepting connections
      expect(blocked).toBe(503);
      finish({ effort: "medium", jevLatencyMs: 0, fallback: null });
      expect((await pending).status).toBe(200);
      await shutdown;
      expect(server.listening).toBe(false);
    } finally { agent.destroy(); }
  });

  it("closes idle keep-alive sockets promptly", async () => {
    const server = app();
    const url = await listen(server);
    const agent = new http.Agent({ keepAlive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        http.get(`${url}/health`, { agent }, (response) => { response.resume(); response.on("end", resolve); }).on("error", reject);
      });
      const started = Date.now();
      await shutdownAppServer(server, 2_000);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally { agent.destroy(); }
  });

  it("aborts a classifier that outlives the deadline without starting generation", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let aborted = false;
    const server = app({ selectEffort: ({ signal }) => {
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        aborted = true; reject(new Error("cancelled"));
      }, { once: true }));
    } });
    const url = await listen(server);
    const pending = fetch(`${url}/v1/responses`, { method: "POST", body: input }).catch(() => null);
    await started;
    await shutdownAppServer(server, 40);
    await pending;
    expect(aborted).toBe(true);
  });

  it("lets an active SSE stream finish within grace and aborts one past deadline", async () => {
    let endStream!: () => void;
    let upstreamClosed = false;
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      endStream = () => response.end("data: last\n\n");
      response.on("close", () => { if (!response.writableEnded) upstreamClosed = true; });
    });
    const upstreamUrl = await listen(upstream);
    const server = app({ upstreamBaseUrl: upstreamUrl });
    const url = await listen(server);
    const first = await fetch(`${url}/v1/responses`, { method: "POST", body: input });
    const reader = first.body!.getReader();
    await reader.read();
    const draining = shutdownAppServer(server, 2_000);
    endStream();
    expect((await reader.read()).done).toBe(false);
    await draining;

    const second = app({ upstreamBaseUrl: upstreamUrl });
    const secondUrl = await listen(second);
    const stream = await fetch(`${secondUrl}/v1/responses`, { method: "POST", body: input });
    const secondReader = stream.body!.getReader();
    await secondReader.read();
    await shutdownAppServer(second, 40);
    await expect(secondReader.read()).rejects.toThrow();
    expect(upstreamClosed).toBe(true);
  });
});
