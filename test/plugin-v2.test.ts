import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../src/plugin.js";
import type { V2Context, V2HttpRequest, V2HttpResponse, V2ProviderEditor } from "../src/plugin-v2.js";

const originalFetch = globalThis.fetch;
const request = {
  model: "gpt-6-astra",
  prompt_cache_key: "ses_v2test",
  store: false,
  stream: true,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "private prompt" }] }],
};
const upstreamOptions = { upstreamBaseURL: "http://127.0.0.1:8080/v1", upstreamApiKey: "upstream" };
const upstreamURL = "http://127.0.0.1:8080/v1/responses";
const jevAnswer = (effort: string) => new Response(JSON.stringify({ answers: { effort: { choice: effort } } }));
const isJev = (input: RequestInfo | URL) => (input instanceof Request ? input.url : String(input)).includes("api.typesafe.ai");

/** A minimal OpenCode V2 host: records registrations and replays a native HTTP exchange through them. */
async function host(options: Record<string, unknown>) {
  const added: Parameters<V2ProviderEditor["add"]>[0][] = [];
  const hooks: { request?: (event: V2HttpRequest) => Promise<void> | void; response?: (event: V2HttpResponse) => Promise<void> | void } = {};
  const scopedHooks = new Map<string, typeof hooks>();
  const scopes: string[] = [];
  const ctx: V2Context = {
    options,
    provider: { async transform(callback) { callback({ add: (input) => added.push(input), get: (id) => options.providers && (options.providers as Record<string, unknown>)[id] }); return {}; } },
    session: {
      async hook(name: string, callback: (event: never) => Promise<void> | void, scope: { providerID: string }) {
        scopes.push(scope.providerID);
        const selected = scopedHooks.get(scope.providerID) ?? {};
        scopedHooks.set(scope.providerID, selected);
        if (name === "http.request") selected.request = callback as typeof hooks.request;
        if (name === "http.response") selected.response = callback as typeof hooks.response;
        if (scope.providerID === "jev-router") Object.assign(hooks, selected);
        return {};
      },
    },
  };
  const cleanup = await plugin.setup(ctx);
  /** Mirrors OpenCode: run the request hook, fetch the (possibly replaced) Request, then run the response hook. */
  const exchange = async (body: unknown, init: { signal?: AbortSignal; url?: string; sessionID?: string; headers?: Record<string, string> } = {}) => {
    const event: V2HttpRequest = {
      sessionID: init.sessionID ?? "ses_v2test", kind: "primary",
      request: new Request(init.url ?? upstreamURL, { method: "POST", headers: { authorization: "Bearer resolved", "content-type": "application/json", ...init.headers }, body: JSON.stringify(body), signal: init.signal }),
    };
    const selected = scopedHooks.get(init.url?.endsWith("/messages") ? "jev-router-anthropic" : "jev-router")!;
    await selected.request!(event);
    const response: V2HttpResponse = { sessionID: event.sessionID, kind: event.kind, request: event.request, response: await fetch(event.request) };
    await selected.response!(response);
    return { sent: event.request, response: response.response };
  };
  return { added, hooks, scopedHooks, scopes, cleanup, exchange };
}

async function withLog<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jev-v2-"));
  try { return await run(join(dir, "nested", "decisions.jsonl")); } finally { await rm(dir, { recursive: true, force: true }); }
}
const decisions = async (path: string) => {
  await vi.waitFor(async () => expect((await readFile(path, "utf8").catch(() => "")).trim()).not.toBe(""));
  return (await readFile(path, "utf8")).trim().split("\n");
};

afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("jev-router OpenCode V2 plugin", () => {
  it("exposes one stable V2 definition beside the V1 server entrypoint", () => {
    expect(plugin.id).toBe("jev-router");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });

  it("registers the provider, native Responses package, HTTP transport, and three model profiles", async () => {
    const { added, scopes, cleanup } = await host({ jevApiKey: "jev", ...upstreamOptions });
    expect(added).toHaveLength(1);
    expect(added[0]!.info).toEqual({
      id: "jev-router", name: "Jev Router", activation: "enabled", package: "@opencode/ai/providers/openai/responses",
      settings: { baseURL: "http://127.0.0.1:8080/v1", apiKey: "upstream", transport: "http" },
    });
    expect(added[0]!.models.map((model) => [model.id, model.modelID, model.providerID, model.name])).toEqual([
      ["gpt-6-astra", "gpt-6-astra", "jev-router", "GPT-6 Astra"],
      ["gpt-6-luna", "gpt-6-luna", "jev-router", "GPT-6 Luna"],
      ["gpt-6-sol", "gpt-6-sol", "jev-router", "GPT-6 Sol"],
    ]);
    expect(scopes).toEqual(["jev-router", "jev-router"]);
    cleanup();
  });

  it("registers native Anthropic Messages only when opted in or already configured and routes both hooks", async () => {
    const options = { fixedEffort: "high", ...upstreamOptions, anthropicUpstreamApiKey: "anthropic" };
    const { added, scopes, exchange, cleanup } = await host(options);
    expect(added).toHaveLength(2);
    expect(added[1]!.info).toEqual({ id: "jev-router-anthropic", name: "Jev Router Anthropic", activation: "enabled", package: "@opencode/ai/providers/anthropic", settings: { baseURL: "https://api.anthropic.com/v1", apiKey: "anthropic", transport: "http" } });
    expect(added[1]!.models.map((model) => model.id)).toEqual(["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-opus-5"]);
    expect(scopes).toEqual(["jev-router", "jev-router", "jev-router-anthropic", "jev-router-anthropic"]);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const sent = input as Request;
      expect(sent.headers.get("anthropic-beta")).toContain("mid-conversation-output-config-2026-07-01");
      expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
      expect((await sent.json()).messages).toEqual([{ role: "system", content: [], output_config: { effort: "high" } }, { role: "user", content: "hi" }]);
      return new Response('data: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const body = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], stream: true };
    const url = "https://api.anthropic.com/v1/messages";
    await expect(exchange(request, { url })).rejects.toThrow("invalid_request (400)");
    const { response } = await exchange(body, { url, headers: { "x-api-key": "tenant" } });
    expect(await response.text()).toContain("message_stop");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    cleanup();
    const configured = await host({ fixedEffort: "high", ...upstreamOptions, providers: { "jev-router-anthropic": { settings: { apiKey: "user" } } } });
    expect(configured.added).toHaveLength(2);
    configured.cleanup();
  });

  it("leaves an omitted upstream key to OpenCode credential resolution", async () => {
    const { added, cleanup } = await host({ jevApiKey: "jev", upstreamBaseURL: "https://example.test/v1" });
    expect(added[0]!.info.settings).toEqual({ baseURL: "https://example.test/v1", transport: "http" });
    cleanup();
  });

  it.each([
    [{ jevApiKey: "jev" }, "upstreamBaseURL is required"],
    [{ jevApiKey: "jev", upstreamBaseURL: "http://example.test/v1" }, "requires HTTPS"],
    [{ jevApiKey: "jev", upstreamBaseURL: "https://user:pass@example.test/v1" }, "without credentials"],
    [{ jevApiKey: "jev", ...upstreamOptions, upstreamApiKey: " " }, "upstreamApiKey"],
    [{ ...upstreamOptions }, "JEV_ROUTER_API_KEY is required"],
    [{ jevApiKey: "jev", ...upstreamOptions, decisionsLogPath: "relative.jsonl" }, "absolute path"],
  ])("rejects invalid options during setup: %j", async (options, message) => {
    vi.stubEnv("JEV_ROUTER_API_KEY", "");
    await expect(host(options)).rejects.toThrow(message);
    vi.unstubAllEnvs();
  });

  it("rewrites the native request with Jev's selection and logs one correlated metadata-only decision after SSE completion", async () => withLog(async (path) => {
    let received: { headers: Headers; body: Record<string, unknown> } | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isJev(input)) return jevAnswer("high");
      const sent = new Request(input, init);
      received = { headers: sent.headers, body: await sent.json() };
      return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"input_tokens_details":{"cached_tokens":3},"output_tokens":2}}}\n\n', { headers: { "content-type": "text/event-stream", "x-leak": "no" } });
    }) as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", decisionsLogPath: path, ...upstreamOptions });
    const { response } = await exchange(request);
    expect(received!.body.model).toBe("gpt-6-astra");
    expect(received!.body.reasoning).toEqual({ effort: "medium" });
    expect(received!.body.input).toEqual([{ type: "configuration_update", reasoning: { effort: "high" } }, request.input[0]]);
    expect(received!.headers.get("authorization")).toBe("Bearer resolved");
    expect(response.headers.get("x-leak")).toBeNull();
    expect(await readFile(path, "utf8").catch(() => "")).toBe("");
    expect(await response.text()).toContain("response.completed");
    const lines = await decisions(path);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "JevDecision", session: "ses_v2test", model: "gpt-6-astra", effort: "high", fallback: null, outcome: "completed", input_tokens: 7, cached_input_tokens: 3, output_tokens: 2 });
    expect(JSON.parse(lines[0]!).turn_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines[0]).not.toMatch(/private|resolved|upstream|authorization|prompt_cache_key/);
    cleanup();
  }));

  it.each([
    [null, "request.model"],
    [{ ...request, model: "gpt-5" }, "request.model"],
    [{ ...request, truncation: "auto" }, "truncation"],
    [{ ...request, reasoning: { mode: "pro" } }, "reasoning.mode"],
  ])("rejects unsupported input locally before Jev or the upstream: %j", async (body, message) => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", ...upstreamOptions });
    await expect(exchange(body)).rejects.toThrow(message);
    await expect(exchange(body)).rejects.toThrow(/^jev-router invalid_request \(400\)/);
    expect(fetcher).not.toHaveBeenCalled();
    cleanup();
  });

  it.each([
    ["http://127.0.0.1:8080/v1/chat/completions", "POST /v1/responses or /v1/messages only"],
    ["http://upstream.example/v1/responses", "requires HTTPS"],
  ])("rejects a user override that bypasses the HTTPS Responses route: %s", async (url, message) => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", ...upstreamOptions });
    await expect(exchange(request, { url })).rejects.toThrow(message);
    expect(fetcher).not.toHaveBeenCalled();
    cleanup();
  });

  it("enforces the request size limit before classification", async () => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", maxRequestBytes: 16, ...upstreamOptions });
    await expect(exchange(request)).rejects.toThrow("request_too_large (413)");
    expect(fetcher).not.toHaveBeenCalled();
    cleanup();
  });

  it("falls back to a validated effort when Jev times out", async () => withLog(async (path) => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isJev(input)) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      body = await new Request(input, init).json();
      return new Response(JSON.stringify({ status: "completed" }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", jevTimeoutMs: 5, maxRetries: 0, fallbackEffort: "low", decisionsLogPath: path, ...upstreamOptions });
    const { response } = await exchange(request);
    await response.text();
    expect(body!.input).toEqual([{ type: "configuration_update", reasoning: { effort: "low" } }, request.input[0]]);
    expect(JSON.parse((await decisions(path))[0]!)).toMatchObject({ effort: "low", fallback: "jev_timeout", outcome: "completed" });
    cleanup();
  }));

  it("aborts classification on session cancellation without starting upstream generation", async () => {
    const upstream = vi.fn();
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (isJev(input)) return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return upstream(input, init);
    }) as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", ...upstreamOptions });
    const abort = new AbortController();
    const call = exchange(request, { signal: abort.signal });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    abort.abort();
    await expect(call).rejects.toThrow("cancelled (499)");
    expect(upstream).not.toHaveBeenCalled();
    cleanup();
  });

  it("records a pre-header cancellation once and releases capacity", async () => withLog(async (path) => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (isJev(input)) return Promise.resolve(jevAnswer("high"));
      const signal = input instanceof Request ? input.signal : init!.signal!;
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }) as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", maxInFlight: 1, decisionsLogPath: path, ...upstreamOptions });
    const abort = new AbortController();
    const call = exchange(request, { signal: abort.signal });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    abort.abort();
    await expect(call).rejects.toThrow();
    expect(JSON.parse((await decisions(path))[0]!)).toMatchObject({ effort: "high", outcome: "failed" });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => isJev(input) ? jevAnswer("low") : new Response("{}", { headers: { "content-type": "application/json" } })) as typeof fetch;
    expect((await exchange(request)).response.status).toBe(200);
    cleanup();
  }));

  it("aborts the native fetch at the header timeout and records the failure", async () => withLog(async (path) => {
    let aborted = false;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      if (isJev(input)) return Promise.resolve(jevAnswer("high"));
      const signal = (input as Request).signal;
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }));
    }) as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", upstreamHeaderTimeoutMs: 5, decisionsLogPath: path, ...upstreamOptions });
    await expect(exchange(request)).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(JSON.parse((await decisions(path))[0]!)).toMatchObject({ effort: "high", outcome: "failed" });
    cleanup();
  }));

  it("passes streaming bytes through incrementally and cancels upstream when the consumer cancels", async () => {
    let upstreamCancelled = false; let push!: (value: Uint8Array) => void;
    const upstreamBody = new ReadableStream<Uint8Array>({ start(controller) { push = (value) => controller.enqueue(value); }, cancel() { upstreamCancelled = true; } });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => isJev(input) ? jevAnswer("high") : new Response(upstreamBody, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", ...upstreamOptions });
    const { response } = await exchange(request);
    const reader = response.body!.getReader();
    const bytes = new TextEncoder().encode("data: {\"type\":\"response.output_text.delta\"}\n\n");
    push(bytes);
    expect((await reader.read()).value).toEqual(bytes);
    await reader.cancel();
    expect(upstreamCancelled).toBe(true);
    cleanup();
  });

  it("completes and commits lineage when OpenCode cancels the body after the terminal event", async () => withLog(async (path) => {
    const bodies: Record<string, unknown>[] = [];
    let effort = "high";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isJev(input)) return jevAnswer(effort);
      bodies.push(await new Request(input, init).json());
      // An open stream: the consumer, not EOF, ends the exchange.
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":1}}}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", decisionsLogPath: path, ...upstreamOptions });
    const first = await exchange(request);
    const reader = first.response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.completed");
    await reader.cancel();
    expect(JSON.parse((await decisions(path))[0]!)).toMatchObject({ effort: "high", outcome: "completed", input_tokens: 4, output_tokens: 1 });
    effort = "low";
    const history = [...request.input, { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }];
    await (await exchange({ ...request, input: history })).response.body!.cancel();
    // The committed turn keeps its update in place; the new selection precedes the new user message.
    expect(bodies[1]!.input).toEqual([{ type: "configuration_update", reasoning: { effort: "high" } }, history[0], history[1], { type: "configuration_update", reasoning: { effort: "low" } }, history[2]]);
    cleanup();
  }));

  it("passes upstream error status and body through unchanged", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => isJev(input) ? jevAnswer("high") : new Response('{"error":{"message":"bad"}}', { status: 429, headers: { "content-type": "application/json", "retry-after": "3" } })) as typeof fetch;
    const { cleanup, exchange } = await host({ jevApiKey: "jev", ...upstreamOptions });
    const { response } = await exchange(request);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe('{"error":{"message":"bad"}}');
    cleanup();
  });

  it("ignores responses for requests it did not route", async () => {
    const { hooks, cleanup } = await host({ jevApiKey: "jev", ...upstreamOptions });
    const original = new Response("untouched");
    const event: V2HttpResponse = { sessionID: "ses_other", kind: "primary", request: new Request(upstreamURL), response: original };
    await hooks.response!(event);
    expect(event.response).toBe(original);
    cleanup();
  });

  it("rejects a response that arrives after the header deadline settled the exchange", async () => withLog(async (path) => {
    let upstreamCancelled = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => isJev(input) ? jevAnswer("high") : new Response(new ReadableStream({ cancel() { upstreamCancelled = true; } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const { hooks, cleanup } = await host({ jevApiKey: "jev", maxInFlight: 1, upstreamHeaderTimeoutMs: 5, decisionsLogPath: path, ...upstreamOptions });
    const event: V2HttpRequest = { sessionID: "ses_v2test", kind: "primary", request: new Request(upstreamURL, { method: "POST", body: JSON.stringify(request) }) };
    await hooks.request!(event);
    const late = await fetch(event.request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect((async () => hooks.response!({ sessionID: event.sessionID, kind: event.kind, request: event.request, response: late }))()).rejects.toThrow("upstream_timeout (504)");
    expect(upstreamCancelled).toBe(true);
    const lines = await decisions(path);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ effort: "high", outcome: "failed" });
    cleanup();
  }));

  it("aborts in-flight work, records each open exchange once, and rejects new work on cleanup", async () => withLog(async (path) => {
    let aborted = 0;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      if (isJev(input)) return Promise.resolve(jevAnswer("high"));
      (input as Request).signal.addEventListener("abort", () => { aborted += 1; });
      return Promise.resolve(new Response(new ReadableStream()));
    }) as typeof fetch;
    const { hooks, cleanup, exchange } = await host({ jevApiKey: "jev", decisionsLogPath: path, ...upstreamOptions });
    await exchange(request);
    // A second exchange whose native fetch never produces a response event.
    const pending: V2HttpRequest = { sessionID: "ses_v2test", kind: "primary", request: new Request(upstreamURL, { method: "POST", body: JSON.stringify(request) }) };
    await hooks.request!(pending);
    cleanup();
    expect(aborted).toBe(1);
    expect(pending.request.signal.aborted).toBe(true);
    await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2));
    expect((await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line).outcome)).toEqual(["failed", "failed"]);
    await expect(exchange(request)).rejects.toThrow("unavailable (503)");
  }));
});
