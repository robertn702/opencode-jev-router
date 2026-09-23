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

function startApp(upstreamBaseUrl: string, selectEffort?: Parameters<typeof createAppServer>[0]["selectEffort"]) {
  const server = createAppServer({
    upstreamBaseUrl,
    upstreamModel: "gpt-6-astra",
    baseEffort: "medium",
    selectEffort,
  });
  return listen(server);
}

function startLimitedApp(upstreamBaseUrl: string, limits: Partial<Parameters<typeof createAppServer>[0]>) {
  return listen(createAppServer({
    upstreamBaseUrl, upstreamModel: "gpt-6-astra", baseEffort: "medium", ...limits,
  }));
}

const simpleInput = JSON.stringify({
  model: "gpt-5.1",
  input: [{ role: "user", content: "hi" }],
});

describe("forwarding lifecycle", () => {
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
  it("rewrites the outbound model to gpt-6-astra with a fresh content-length", async () => {
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
        model: "any",
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
