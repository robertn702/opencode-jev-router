import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createAppServer } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function listen(
  server: http.Server,
): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  cleanups.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  return `http://127.0.0.1:${port}`;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startUpstream(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    recorded: RecordedRequest,
  ) => void,
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const recorded: RecordedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      handler(request, response, recorded);
    });
  });
  const url = await listen(server);
  return { url, requests };
}

function startApp(upstreamBaseUrl: string, selectEffort?: Parameters<typeof createAppServer>[0]["selectEffort"], upstreamAuth: Parameters<typeof createAppServer>[0]["upstreamAuth"] = { policy: "forward" }) {
  const server = createAppServer({
    upstreamBaseUrl,
    upstreamAuth,
    baseEffort: "medium",
    selectEffort,
  });
  return listen(server);
}

function startLimitedApp(upstreamBaseUrl: string, limits: Partial<Parameters<typeof createAppServer>[0]>) {
  return listen(createAppServer({
    upstreamBaseUrl, upstreamAuth: { policy: "forward" }, baseEffort: "medium", ...limits,
  }));
}

const simpleInput = JSON.stringify({
  model: "gpt-6-astra",
  input: [{ role: "user", content: "hi" }],
});

describe("forwarding lifecycle", () => {
  it.each(["forward", "bearer"] as const)("isolates concurrent models and same-model continuations with %s auth", async (policy) => {
    const models = ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"];
    const evidence: unknown[] = [];
    const upstream = await startUpstream((_request, response, recorded) => {
      const body = JSON.parse(recorded.body);
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        setTimeout(() => response.end("data: last\n\n"), 30);
      } else response.end(JSON.stringify({ model: body.model, output: [{ type: "function_call", call_id: "c", name: "test", arguments: "{}" }] }));
    });
    const completed: string[] = [];
    const app = await startLimitedApp(upstream.url, {
      upstreamAuth: policy === "forward" ? { policy } : { policy, apiKey: "router-secret" },
      onEvidence: (item) => evidence.push(item),
      selectEffort: async ({ model }) => {
        await new Promise((resolve) => setTimeout(resolve, (3 - models.indexOf(model.id)) * 30));
        completed.push(model.id);
        return { effort: model.id === models[0] ? "high" : "none", jevLatencyMs: 0, fallback: null };
      },
    });
    await Promise.all(models.map(async (model) => {
      const post = (input: unknown[], stream = false) => fetch(`${app}/v1/responses`, { method: "POST", headers: { authorization: "Bearer client-secret" }, body: JSON.stringify({ model, input, stream, prompt_cache_key: "private-key" }) });
      const first = await post([{ role: "user", content: "private-prompt" }]);
      expect(first.status).toBe(200);
      const result = await first.json() as { model: string; output: unknown[] };
      expect(result.model).toBe(model);
      const next = await post([...result.output, { type: "function_call_output", call_id: "c", output: "private-output" }], true);
      const reader = next.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: last\n\n");
      await reader.read();
    }));
    expect(completed[0]).toBe("gpt-6-sol");
    for (const request of upstream.requests) {
      const body = JSON.parse(request.body);
      expect(request.headers.authorization).toBe(policy === "forward" ? "Bearer client-secret" : "Bearer router-secret");
      expect(body.reasoning.effort).toBe("medium");
      expect(body.input.find((item: { reasoning?: { effort?: string } }) => item.reasoning?.effort === (body.model === models[0] ? "high" : "none"))).toBeDefined();
      expect(body.prompt_cache_key).toBe("private-key");
    }
    const logs = JSON.stringify(evidence);
    for (const model of models) expect(logs).toContain(model);
    for (const secret of ["private-key", "private-prompt", "private-output", "client-secret", "router-secret"]) expect(logs).not.toContain(secret);
  });
  it("replays prior updates across effort changes and records request usage", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":4000,"input_tokens_details":{"cached_tokens":3072},"output_tokens":12}}}\n\n');
    });
    let calls = 0;
    const records: Record<string, unknown>[] = [];
    const app = await startLimitedApp(upstream.url, {
      selectEffort: async () => ({ effort: calls++ ? "high" : "low", jevLatencyMs: 1, fallback: null }),
      onEvidence: (entry) => records.push({ ...entry }),
    });
    const initial = [{ role: "user", content: "hi" }];
    for (const input of [initial, [...initial, { type: "configuration_update", reasoning: { effort: "low" } }, { role: "assistant", content: "hello" }, { role: "user", content: "continue" }]]) {
      const response = await fetch(`${app}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", prompt_cache_key: "test-lineage", input }) });
      expect(await response.text()).toContain('"cached_tokens":3072');
    }
    const first = JSON.parse(upstream.requests[0]!.body);
    const second = JSON.parse(upstream.requests[1]!.body);
    expect(first.input).toEqual([{ type: "configuration_update", reasoning: { effort: "low" } }, ...initial]);
    expect(second.input).toEqual([
      { type: "configuration_update", reasoning: { effort: "low" } },
      ...initial,
      { type: "configuration_update", reasoning: { effort: "low" } },
      { role: "assistant", content: "hello" },
      { type: "configuration_update", reasoning: { effort: "high" } },
      { role: "user", content: "continue" },
    ]);
    expect(records[1]).toMatchObject({ effort: "high", previous_effort: "low", lineage_status: "preserved", history_updates_replayed: 1, input_tokens: 4000, cached_input_tokens: 3072, output_tokens: 12 });
  });

  it("does not commit lineage when the upstream rejects a request", async () => {
    let calls = 0;
    const evidence: Array<{ lineage_status: string | null; history_updates_replayed: number }> = [];
    const upstream = await startUpstream((_request, response) => {
      calls++;
      response.writeHead(calls === 1 ? 400 : 200, { "content-type": "application/json" });
      response.end("{}");
    });
    const app = await startLimitedApp(upstream.url, {
      selectEffort: async () => ({ effort: "low", jevLatencyMs: 0, fallback: null }),
      onEvidence: (item) => evidence.push(item),
    });
    const first = await fetch(`${app}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", prompt_cache_key: "lineage", input: [{ role: "user", content: "one" }] }) });
    expect(first.status).toBe(400);
    await first.text();
    const second = await fetch(`${app}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", prompt_cache_key: "lineage", input: [{ role: "user", content: "one" }, { role: "assistant", content: "no" }, { role: "user", content: "two" }] }) });
    expect(second.status).toBe(200);
    await second.text();
    expect(evidence[1]).toMatchObject({ lineage_status: "new", history_updates_replayed: 0 });
  });

  it("logs validated session and turn IDs without forwarding correlation headers", async () => {
    const upstream = await startUpstream((_request, response) => response.end("{}"));
    const evidence: Array<{ session: string | null; turn_id: string | null }> = [];
    const app = await startLimitedApp(upstream.url, { onEvidence: (entry) => evidence.push(entry) });
    const turnId = "57e52d14-5cfa-4db3-a35a-48e9fcb9567d";
    for (const headers of [
      { "x-jev-session-id": "ses_abc123", "x-jev-turn-id": turnId },
      { "x-jev-session-id": "invalid", "x-jev-turn-id": "invalid" },
    ]) {
      const response = await fetch(`${app}/v1/responses`, { method: "POST", headers, body: simpleInput });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(evidence.map(({ session, turn_id }) => ({ session, turn_id }))).toEqual([
      { session: "ses_abc123", turn_id: turnId },
      { session: null, turn_id: null },
    ]);
    expect(upstream.requests[0]!.headers["x-jev-session-id"]).toBeUndefined();
    expect(upstream.requests[0]!.headers["x-jev-turn-id"]).toBeUndefined();
  });

  it("accepts the byte boundary and rejects a chunked body beyond it before classification", async () => {
    let calls = 0;
    const upstream = await startUpstream((_request, response) => response.end("{}"));
    const app = await startLimitedApp(upstream.url, {
      maxRequestBytes: Buffer.byteLength(simpleInput),
      selectEffort: async () => { calls++; return { effort: "medium", jevLatencyMs: 0, fallback: null }; },
    });
    const exact = await fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput });
    expect(exact.status).toBe(200);
    await exact.text();

    const oversized = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${app}/v1/responses`);
      const request = http.request(url, { method: "POST" }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject);
      request.write(simpleInput);
      request.end(" ");
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({ error: "request_too_large" });
    expect(calls).toBe(1);
    expect(upstream.requests).toHaveLength(1);
  });

  it("rejects overload before classification and frees the slot after client cancellation", async () => {
    let calls = 0;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const upstream = await startUpstream((_request, response) => response.end("{}"));
    const app = await startLimitedApp(upstream.url, {
      maxInFlight: 1,
      selectEffort: ({ signal }) => {
        calls++;
        started();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      },
    });
    const controller = new AbortController();
    const first = fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput, signal: controller.signal }).catch(() => null);
    await entered;
    const rejected = await fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput });
    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toEqual({ error: "overloaded" });
    expect(calls).toBe(1);
    controller.abort();
    await first;
    const health = await fetch(`${app}/health`);
    expect(health.status).toBe(200);
    // Wait for the server-side close event to release the occupied slot.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const next = new AbortController();
    const pending = fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput, signal: next.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(2);
    expect(upstream.requests).toHaveLength(0);
    next.abort();
    await pending;
  });

  it("returns 504 when upstream headers stall, without exposing upstream errors", async () => {
    const upstream = await startUpstream(() => {});
    const app = await startLimitedApp(upstream.url, { upstreamHeaderTimeoutMs: 40 });
    const response = await fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput });
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({ error: "upstream_timeout" });
  });

  it("keeps a healthy SSE stream alive past the header deadline, then times out on idle", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: one\n\n");
      setTimeout(() => response.write("data: two\n\n"), 70);
    });
    const app = await startLimitedApp(upstream.url, { upstreamHeaderTimeoutMs: 30, upstreamIdleTimeoutMs: 120 });
    const response = await fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("one");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("two");
    await expect(reader.read()).rejects.toThrow();
  });
  it("uses only the configured bearer key for responses and models", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const app = await startApp(upstream.url, undefined, { policy: "bearer", apiKey: "server-test-key" });

    for (const [method, path, body] of [["POST", "responses", simpleInput], ["GET", "models", undefined]] as const) {
      const response = await fetch(`${app}/v1/${path}`, {
        method,
        headers: { authorization: "Bearer client-secret" },
        body,
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(upstream.requests.map(({ headers }) => headers.authorization))
      .toEqual(["Bearer server-test-key", "Bearer server-test-key"]);

    const response = await fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput });
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.requests[2]!.headers.authorization).toBe("Bearer server-test-key");
  });

  it("forwards the client's bearer credential under the forward policy", async () => {
    const upstream = await startUpstream((_request, response) => response.end("{}"));
    const app = await startApp(upstream.url);
    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer client-test-key" },
      body: simpleInput,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.requests[0]!.headers.authorization).toBe("Bearer client-test-key");
  });

  it("forwards to a bracketed IPv6 loopback upstream", async () => {
    const upstream = http.createServer((_request, response) => response.end("ipv6-ok"));
    try {
      upstream.listen(0, "::1");
      await once(upstream, "listening");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAFNOSUPPORT" || (error as NodeJS.ErrnoException).code === "EADDRNOTAVAIL") return;
      throw error;
    }
    cleanups.push(async () => {
      upstream.closeAllConnections();
      upstream.close();
      await once(upstream, "close");
    });
    const app = await startApp(`http://[::1]:${(upstream.address() as AddressInfo).port}/v1`);
    const response = await fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ipv6-ok");
  });

  it("proxies a bearer-policy tool continuation with the selected effort", async () => {
    const upstream = await startUpstream((_request, response, recorded) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, seen: JSON.parse(recorded.body) }));
    });
    const app = await startApp(upstream.url, async () => ({ effort: "high", jevLatencyMs: 1, fallback: null }), { policy: "bearer", apiKey: "server-test-key" });
    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-astra", input: [
        { role: "user", content: "call tool" },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ] }),
    });
    expect(response.status).toBe(200);
    const { seen } = await response.json() as { seen: { model: string; reasoning: { effort: string }; input: unknown[] } };
    expect(seen.model).toBe("gpt-6-astra");
    expect(seen.reasoning.effort).toBe("medium");
    expect(seen.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
    expect(seen.input.at(-2)).toEqual({ type: "function_call_output", call_id: "c1", output: "done" });
  });

  it("streams SSE under the bearer policy without client authorization", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      setTimeout(() => response.end("data: second\n\n"), 10);
    });
    const app = await startApp(upstream.url, undefined, { policy: "bearer", apiKey: "server-test-key" });
    const response = await fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
    expect(upstream.requests[0]!.headers.authorization).toBe("Bearer server-test-key");
  });

  it("pins the outbound model to gpt-6-astra with a fresh content-length", async () => {
    const upstream = await startUpstream((_request, response, recorded) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, seen: JSON.parse(recorded.body) }));
    });
    const app = await startApp(upstream.url);

    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
    });
    const forwarded = (await response.json()) as {
      ok: boolean;
      seen: Record<string, unknown>;
    };

    expect(forwarded.ok).toBe(true);
    expect(forwarded.seen.model).toBe("gpt-6-astra");
    const sent = upstream.requests[0]!;
    expect(sent.headers["content-length"]).toBe(
      String(Buffer.byteLength(sent.body)),
    );
    expect(sent.headers["content-length"]).not.toBe(
      String(Buffer.byteLength(simpleInput)),
    );
    expect(sent.headers["transfer-encoding"]).toBeUndefined();
  });

  it("rejects unsupported shapes and incompatible modes before classifier or upstream calls", async () => {
    let classifierCalls = 0;
    const upstream = await startUpstream((_request, response) => {
      response.end("{}");
    });
    const app = await startApp(upstream.url, async () => {
      classifierCalls += 1;
      return { effort: "high", jevLatencyMs: 1, fallback: null };
    });

    for (const body of [
      JSON.stringify({ model: "gpt-5.1", input: [{ role: "user", content: "x" }] }),
      JSON.stringify({ input: [{ role: "user", content: "x" }] }),
      JSON.stringify({ input: "plain string" }),
      JSON.stringify({ input: [{ type: "mystery" }] }),
      JSON.stringify({
        reasoning: { mode: "pro" },
        input: [{ role: "user", content: "x" }],
      }),
      JSON.stringify({
        model: "gpt-6-astra-pro",
        input: [{ role: "user", content: "x" }],
      }),
    ]) {
      const response = await fetch(`${app}/v1/responses`, {
        method: "POST",
        body,
      });
      expect(response.status).toBe(400);
    }

    expect(classifierCalls).toBe(0);
    expect(upstream.requests).toHaveLength(0);
  });

  it("accepts registered models through the same endpoint", async () => {
    let calls = 0;
    const upstream = await startUpstream((_request, response, recorded) => response.end(recorded.body));
    const app = await startLimitedApp(upstream.url, {
      selectEffort: async () => { calls++; return { effort: "high", jevLatencyMs: 0, fallback: null }; },
    });
    const wrong = await fetch(`${app}/v1/responses`, { method: "POST", body: simpleInput });
    expect(wrong.status).toBe(200);
    expect(calls).toBe(1);
    expect(upstream.requests).toHaveLength(1);

    const right = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "hi" }] }),
    });
    expect(right.status).toBe(200);
    expect((await right.json() as { model: string }).model).toBe("gpt-6-luna");
    expect(calls).toBe(2);
  });

  it("keeps genuine upstream HTTP errors, statuses, bodies, and safe headers", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(429, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "7",
        "x-request-id": "req-upstream",
        etag: '"stale"',
        "content-encoding": "identity-stale",
        server: "fake",
      });
      response.end(JSON.stringify({ error: "rate_limited" }));
    });
    const app = await startApp(upstream.url);

    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("x-request-id")).toBe("req-upstream");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("server")).toBeNull();
  });

  it("excludes allowlisted headers nominated by the upstream Connection header", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, {
        connection: "x-request-id",
        "x-request-id": "nominated",
        "content-type": "application/json",
      });
      response.end("{}");
    });
    const app = await startApp(upstream.url);

    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
    });

    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("returns a fixed local 502 on connection failure before response headers", async () => {
    const app = await startApp("http://127.0.0.1:9");

    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "upstream_unavailable",
    });
  });

  it("terminates mid-stream failures without appended JSON or replacement status", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: chunk-one\n\n");
      setTimeout(() => response.socket?.destroy(), 20);
    });
    const app = await startApp(upstream.url);

    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
    });
    expect(response.status).toBe(200);

    let text = "";
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
      if (part.done) break;
      text += decoder.decode(part.value);
    }
    expect(text.startsWith("data: chunk-one\n\n")).toBe(true);
    expect(text).not.toContain("{");
  });

  it("streams SSE chunks to the client before upstream completion", async () => {
    let releaseUpstream!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      void gate.then(() => {
        response.write("data: second\n\n");
        response.end();
      });
    });
    const app = await startApp(upstream.url);

    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("first");

    releaseUpstream();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toContain("second");
  });

  it("applies backpressure instead of buffering an unconsumed upstream", async () => {
    const chunkCount = 256;
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let upstreamFinished = false;
    let blockedWrite = false;
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let index = 0;
      const pump = (): void => {
        while (index < chunkCount) {
          index += 1;
          const flushed = response.write(chunk);
          if (!flushed) {
            blockedWrite = true;
            response.once("drain", pump);
            return;
          }
        }
        upstreamFinished = true;
        response.end();
      };
      pump();
    });
    const app = await startApp(upstream.url);

    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
    });
    const reader = response.body!.getReader();

    let received = 0;
    const first = await reader.read();
    received += first.value?.byteLength ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(upstreamFinished).toBe(false);

    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value?.byteLength ?? 0;
    }
    expect(received).toBe(chunkCount * chunk.byteLength);
    expect(blockedWrite).toBe(true);
    expect(upstreamFinished).toBe(true);
  });

  it("aborts the upstream when the client disconnects while waiting for headers", async () => {
    let upstreamClosed = false;
    const upstream = await startUpstream((request, response) => {
      request.on("close", () => {
        upstreamClosed = true;
      });
      response.on("close", () => {
        upstreamClosed = true;
      });
    });
    const app = await startApp(upstream.url);

    const controller = new AbortController();
    const pending = fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(pending).resolves.toBeInstanceOf(Error);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(upstreamClosed).toBe(true);
  });

  it("aborts the upstream when the client disconnects during streaming", async () => {
    let upstreamClosed = false;
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      response.on("close", () => {
        if (!response.writableEnded) upstreamClosed = true;
      });
    });
    const app = await startApp(upstream.url);

    const controller = new AbortController();
    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    const drained = (async () => {
      for (;;) {
        const part = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
        if (part.done) break;
      }
    })();
    controller.abort();
    await drained;

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(upstreamClosed).toBe(true);
  });

  it("does not treat normal request-body completion as a client disconnect", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const app = await startApp(upstream.url);

    const response = await fetch(`${app}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-6-astra",
        input: [
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
          {
            type: "function_call",
            call_id: "c1",
            name: "read",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "c1", output: "ok" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("aborts classification and starts no generation when the client disconnects", async () => {
    let classifierAborted = false;
    const upstream = await startUpstream((_request, response) => {
      response.end("{}");
    });
    const app = await startApp(upstream.url, ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            classifierAborted = true;
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }),
    );

    const controller = new AbortController();
    const pending = fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(pending).resolves.toBeInstanceOf(Error);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(classifierAborted).toBe(true);
    expect(upstream.requests).toHaveLength(0);
  });

  it("never fails open into generation at the timeout-to-fallback boundary", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.end("{}");
    });
    let resolveFallback!: (decision: {
      effort: "medium";
      jevLatencyMs: number;
      fallback: "jev_timeout";
    }) => void;
    const fallbackReady = new Promise<{
      effort: "medium";
      jevLatencyMs: number;
      fallback: "jev_timeout";
    }>((resolve) => {
      resolveFallback = resolve;
    });
    const app = await startApp(upstream.url, () => fallbackReady);

    const controller = new AbortController();
    const pending = fetch(`${app}/v1/responses`, {
      method: "POST",
      body: simpleInput,
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The classifier falls back right as the client disconnects: the fallback
    // result lands after the disconnect is observable.
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveFallback({ effort: "medium", jevLatencyMs: 4000, fallback: "jev_timeout" });
    await expect(pending).resolves.toBeInstanceOf(Error);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstream.requests).toHaveLength(0);
  });

  it("starts no generation when the client is already gone before forwarding", async () => {
    let connected = false;
    const deadServer = await startUpstream(() => {
      connected = true;
    });
    const deadUrl = deadServer.url;
    deadServer.requests.length = 0;
    const controller = new AbortController();
    controller.abort();

    const { forwardUpstream } = await import("../src/forward.js");
    const stubResponse = {
      writableEnded: false,
      destroyed: false,
      destroy() {
        stubResponse.destroyed = true;
      },
    };
    const response = stubResponse as unknown as Parameters<typeof forwardUpstream>[0];

    const outcome = await forwardUpstream(response, {
      method: "POST",
      url: new URL("responses", `${deadUrl}/`),
      authorization: "Bearer x",
      body: "{}",
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outcome).toBe("client_disconnected");
    expect(connected).toBe(false);
  });
});
