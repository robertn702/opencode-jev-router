import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJevClassifier as createClassifier, buildJevState } from "../src/jev.js";
import { findModel } from "../src/models.js";

function createJevClassifier(options: Omit<Parameters<typeof createClassifier>[0], "baseURL" | "model"> & Partial<Pick<Parameters<typeof createClassifier>[0], "baseURL" | "model">>) {
  const classifier = createClassifier({ baseURL: "https://api.typesafe.ai", model: "jev-latest", maxRetries: 0, fallbackMode: "previous", fallbackEffort: "medium", ...options });
  return { ...classifier, select: (args: Omit<Parameters<typeof classifier.select>[0], "model">) =>
    classifier.select({ ...args, model: findModel(args.body.model ?? "gpt-6-astra")! }) };
}
import { createAppServer } from "../src/server.js";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

type FetchArgs = [input: string, init?: RequestInit];

function okResponse(choice: string): Response {
  return new Response(
    JSON.stringify({
      model: "jev-latest",
      answers: {
        effort: {
          type: "choice",
          choice,
          confidence: 0.9,
          probabilities: {},
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function hangingFetch(onAbort: () => void): (input: string, init?: RequestInit) => Promise<Response> {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          onAbort();
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
}

const cacheBody = (promptCacheKey: unknown) => ({
  model: "gpt-6-astra",
  prompt_cache_key: promptCacheKey,
  input: [{ role: "user", content: "hi" }],
});

describe("Jev classifier", () => {
  it("sends the direct TypeSafe model and classifier credential", async () => {
    let sent: FetchArgs | undefined;
    const { select } = createJevClassifier({
      apiKey: "direct-key", timeoutMs: 1000,
      fetch: async (input, init) => { sent = [input, init]; return okResponse("medium"); },
    });
    await select({ body: cacheBody("direct"), signal: new AbortController().signal });
    expect(sent?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(sent?.[1]?.headers).get("authorization")).toBe("Bearer direct-key");
    expect(JSON.parse(String(sent?.[1]?.body)).model).toBe("jev-latest");
  });

  it("returns the validated effort from a successful classification", async () => {
    const seen: FetchArgs[] = [];
    const { select, client } = createJevClassifier({
      apiKey: "k",
      baseURL: "https://ai-gateway.vercel.sh/typesafe",
      model: "typesafe-ai/jev",
      timeoutMs: 1000,
      fetch: async (input: string, init?: RequestInit) => {
        seen.push([input, init]);
        return okResponse("high");
      },
    });

    const decision = await select({
      body: cacheBody("k1"),
      signal: new AbortController().signal,
    });

    expect(decision).toEqual({
      effort: "high",
      jevLatencyMs: expect.any(Number),
      jevAttempts: 1,
      fallback: null,
    });
    expect(client.retry.maxRetries).toBe(0);
    expect(client.logLevel).toBe("off");
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(new Headers(seen[0]![1]?.headers).get("authorization")).toBe("Bearer k");
    expect(JSON.parse(String(seen[0]![1]?.body)).model).toBe("typesafe-ai/jev");
  });

  it("reuses the previous effort for the same usable cache key on invalid output, errors, and timeout", async () => {
    let mode: "ok" | "invalid" | "error" | "hang" = "ok";
    let attempts = 0;
    const { select } = createJevClassifier({
      apiKey: "k",
      timeoutMs: 40,
      fetch: async (_input: string, init?: RequestInit) => {
        attempts += 1;
        if (mode === "ok") return okResponse("xhigh");
        if (mode === "invalid") return okResponse("extreme");
        if (mode === "error") {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const signal = new AbortController().signal;

    const first = await select({ body: cacheBody("k1"), signal });
    expect(first.effort).toBe("xhigh");
    expect(first.fallback).toBeNull();

    mode = "invalid";
    const invalid = await select({ body: cacheBody("k1"), signal });
    expect(invalid.effort).toBe("xhigh");
    expect(invalid.fallback).toBe("jev_invalid_output");

    mode = "error";
    const errored = await select({ body: cacheBody("k1"), signal });
    expect(errored.effort).toBe("xhigh");
    expect(errored.fallback).toBe("jev_error");
    expect(errored.jevErrorCategory).toBe("http_5xx");

    mode = "hang";
    const timedOut = await select({ body: cacheBody("k1"), signal });
    expect(timedOut.effort).toBe("xhigh");
    expect(timedOut.fallback).toBe("jev_timeout");

    mode = "error";
    const otherKey = await select({ body: cacheBody("k2"), signal });
    expect(otherKey.effort).toBe("medium");
    expect(otherKey.fallback).toBe("jev_error");
    expect(otherKey.jevErrorCategory).toBe("http_5xx");
  });

  it("categorizes SDK HTTP and connection errors without retaining their messages", async () => {
    let response: Response | null = null;
    const { select } = createJevClassifier({
      apiKey: "k", timeoutMs: 1000,
      fetch: async () => {
        if (response) return response;
        throw new Error("secret connection detail");
      },
    });
    const signal = new AbortController().signal;
    const decide = () => select({ body: cacheBody("k1"), signal });
    expect((await decide()).jevErrorCategory).toBe("connection");
    response = new Response("secret auth detail", { status: 401 });
    expect((await decide()).jevErrorCategory).toBe("http_auth");
    response = new Response("secret rate limit detail", { status: 429 });
    expect((await decide()).jevErrorCategory).toBe("http_rate_limit");
  });

  it("yields medium for missing or unusable cache keys and keys without prior values", async () => {
    const { select } = createJevClassifier({
      apiKey: "k",
      timeoutMs: 40,
      fetch: async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    });
    const signal = new AbortController().signal;

    for (const key of [undefined, "", "   ", null, 42]) {
      const decision = await select({ body: cacheBody(key), signal });
      expect(decision.effort).toBe("medium");
      expect(decision.fallback).toBe("jev_error");
    }
  });

  it("aborts a hanging classifier at the total deadline with exactly one SDK attempt", async () => {
    let attempts = 0;
    let aborted = false;
    const { select } = createJevClassifier({
      apiKey: "k",
      timeoutMs: 30,
      fetch: async (_input: string, init?: RequestInit) => {
        attempts += 1;
        return hangingFetch(() => {
          aborted = true;
        })(_input, init);
      },
    });

    const decision = await select({
      body: cacheBody("k1"),
      signal: new AbortController().signal,
    });

    expect(decision.fallback).toBe("jev_timeout");
    expect(attempts).toBe(1);
    expect(aborted).toBe(true);
  });

  it("makes no retries on retryable failures", async () => {
    let attempts = 0;
    const { select } = createJevClassifier({
      apiKey: "k",
      timeoutMs: 1000,
      fetch: async () => {
        attempts += 1;
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      },
    });

    const decision = await select({
      body: cacheBody("k1"),
      signal: new AbortController().signal,
    });

    expect(decision.fallback).toBe("jev_error");
    expect(attempts).toBe(1);
  });

  it("ignores late results after the fallback selection and starts no duplicate generation", async () => {
    let attempts = 0;
    const upstreamRequests: string[] = [];
    const { select } = createJevClassifier({
      apiKey: "k",
      timeoutMs: 30,
      fetch: async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
        return okResponse("max");
      },
    });

    // Point at a stub upstream that records requests.
    const stub = await (async () => {
      const http = await import("node:http");
      const stubServer = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          upstreamRequests.push(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        });
      });
      stubServer.listen(0, "127.0.0.1");
      await once(stubServer, "listening");
      return stubServer;
    })();
    const stubPort = (stub.address() as AddressInfo).port;

    const app = createAppServer({
      upstreamBaseUrl: `http://127.0.0.1:${stubPort}/v1`,
      upstreamAuth: { policy: "forward" },
      baseEffort: "medium",
      selectEffort: select,
    });
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    const appPort = (app.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${appPort}/v1/responses`, {
      method: "POST",
      body: JSON.stringify(cacheBody("late-key")),
    });
    expect(response.status).toBe(200);

    // Wait past the late classification result.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(upstreamRequests).toHaveLength(1);
    const forwarded = JSON.parse(upstreamRequests[0]!) as {
      input: Array<{ reasoning?: { effort?: string } }>;
    };
    expect(forwarded.input.find((item) => item.reasoning?.effort === "medium")?.reasoning?.effort).toBe("medium");
    expect(attempts).toBe(1);

    // The late result must not have been stored as a prior effort.
    const after = await select({
      body: cacheBody("late-key"),
      signal: new AbortController().signal,
    });
    expect(after.effort).toBe("medium");

    app.closeAllConnections();
    stub.closeAllConnections();
    const appClosed = once(app, "close");
    const stubClosed = once(stub, "close");
    app.close();
    stub.close();
    await appClosed;
    await stubClosed;
  });

  it("never fails open into generation for a cancelled client", async () => {
    const { select } = createJevClassifier({
      apiKey: "k",
      timeoutMs: 1000,
      fetch: async (_input: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });

    const controller = new AbortController();
    const pending = select({ body: cacheBody("k1"), signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/);
  });
});

describe("Jev state bounds", () => {
  it("builds bounded state from user text, assistant progress, tool results, and failures", () => {
    const state = buildJevState([
      { role: "user", content: "U".repeat(5000) },
      { role: "assistant", content: "A".repeat(5000) },
      { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "c1",
        output: "T".repeat(5000),
        status: "failed",
      },
      { type: "function_call", call_id: "c2", name: "write", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "c2",
        output: "ok",
        status: "completed",
      },
    ]);

    expect(state.recent_user_text.length).toBeLessThanOrEqual(2000);
    expect(state.assistant_progress.length).toBeLessThanOrEqual(2000);
    expect(state.tool_results).toHaveLength(2);
    expect(state.tool_results[0]).toMatchObject({ name: "read", ok: false });
    expect(state.tool_results[1]).toMatchObject({ name: "write", ok: true });
    expect(state.tool_results[0]!.excerpt.length).toBeLessThanOrEqual(1600);
    expect(state.failure_state.failed_count).toBe(1);
  });

  it("caps retained tool results at eight", () => {
    const input = [];
    for (let i = 0; i < 12; i += 1) {
      input.push({ type: "function_call", call_id: `c${i}`, name: `t${i}`, arguments: "{}" });
      input.push({
        type: "function_call_output",
        call_id: `c${i}`,
        output: "ok",
        status: "completed",
      });
    }
    const state = buildJevState(input);
    expect(state.tool_results).toHaveLength(8);
  });
});

describe("evidence privacy under inherited debug logging", () => {
  const MARKERS = [
    "SECRET_PROMPT_MARKER",
    "SECRET_TOOL_MARKER",
    "SECRET_CACHE_MARKER",
    "SECRET_ERROR_MARKER",
  ];

  let captured: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };

  beforeEach(() => {
    captured = [];
    process.env.TYPESAFE_LOG_LEVEL = "debug";
    for (const name of ["log", "info", "warn", "error", "debug"] as const) {
      console[name] = (...args: unknown[]) => {
        captured.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg)).join(" "));
      };
    }
    process.stdout.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    delete process.env.TYPESAFE_LOG_LEVEL;
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
    console.debug = originals.debug;
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  });

  it("leaks no prompt, tool, cache-key, credential, or raw error content on SDK success or error", async () => {
    const body = {
      prompt_cache_key: `key-${MARKERS[2]}`,
      input: [
        { role: "user", content: `please ${MARKERS[0]}` },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "c1",
          output: `tool says ${MARKERS[1]}`,
          status: "completed",
        },
      ],
    };

    let mode: "ok" | "error" = "ok";
    const { select } = createJevClassifier({
      apiKey: `sk-${MARKERS[3]}`,
      timeoutMs: 500,
      fetch: async (_input: string, init?: RequestInit) => {
        if (mode === "ok") return okResponse("high");
        void init;
        return new Response(
          JSON.stringify({ error: `upstream ${MARKERS[3]}` }),
          { status: 500 },
        );
      },
    });

    const signal = new AbortController().signal;
    await select({ body, signal });
    mode = "error";
    await select({ body, signal });

    for (const marker of MARKERS) {
      for (const line of captured) {
        expect(line).not.toContain(marker);
      }
    }
  });

  it("emits metadata restricted to the explicit allowlist", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    let failJev = false;
    const { select } = createJevClassifier({
      apiKey: "k",
      timeoutMs: 500,
      fetch: async () => failJev
        ? new Response("secret server detail", { status: 503 })
        : okResponse("high"),
    });

    const upstream = await (async () => {
      const http = await import("node:http");
      const server = http.createServer((_request, response) => {
        response.end("{}");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return server;
    })();
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const app = createAppServer({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      upstreamAuth: { policy: "forward" },
      baseEffort: "medium",
      selectEffort: select,
      onEvidence: (record) => evidence.push({ ...record }),
    });
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    const appPort = (app.address() as AddressInfo).port;

    await fetch(`http://127.0.0.1:${appPort}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-6-astra",
        prompt_cache_key: `key-${MARKERS[2]}`,
        input: [{ role: "user", content: `please ${MARKERS[0]}` }],
      }),
    });

    expect(evidence).toHaveLength(1);
    expect(Object.keys(evidence[0]!).sort()).toEqual([
      "cached_input_tokens",
      "effort",
      "fallback",
      "history_updates_replayed",
      "input_tokens",
      "jev_attempts",
      "jev_error_category",
      "jev_latency_ms",
      "lineage_status",
      "model",
      "outcome",
      "output_tokens",
      "previous_effort",
      "request_id",
      "session",
      "turn_id",
    ]);
    expect(evidence[0]).toMatchObject({
      model: "gpt-6-astra",
      effort: "high",
      fallback: null,
      outcome: "completed",
      session: null,
      turn_id: null,
    });
    for (const marker of MARKERS) {
      expect(JSON.stringify(evidence[0])).not.toContain(marker);
    }

    failJev = true;
    await fetch(`http://127.0.0.1:${appPort}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-astra", input: [{ role: "user", content: "hi" }] }),
    });
    expect(evidence[1]).toMatchObject({ fallback: "jev_error", jev_error_category: "http_5xx" });
    expect(JSON.stringify(evidence[1])).not.toContain("secret server detail");

    app.closeAllConnections();
    upstream.closeAllConnections();
    const appClosed = once(app, "close");
    const upstreamClosed = once(upstream, "close");
    app.close();
    upstream.close();
    await appClosed;
    await upstreamClosed;
  });
});
