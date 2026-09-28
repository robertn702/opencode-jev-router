import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

import plugin from "../src/plugin.js";
import type { Plugin } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { SessionHttpRequest, SessionHttpResponse } from "@opencode/plugin/promise/session";

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
  const added: Parameters<ProviderEditor["add"]>[0][] = [];
  const hooks: { request?: (event: SessionHttpRequest) => Promise<void> | void; response?: (event: SessionHttpResponse) => Promise<void> | void } = {};
  const scopedHooks = new Map<string, typeof hooks>();
  const scopes: string[] = [];
  const ctx = {
    options,
    provider: { async transform(callback: (editor: ProviderEditor) => void) { callback({ add: (input: Parameters<ProviderEditor["add"]>[0]) => { added.push(input); } } as unknown as ProviderEditor); return {}; } },
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
  } as unknown as Plugin.Context;
  const cleanup = await plugin.setup(ctx);
  /** Mirrors OpenCode: run the request hook, fetch the (possibly replaced) Request, then run the response hook. */
  const exchange = async (body: unknown, init: { signal?: AbortSignal; url?: string; sessionID?: string; headers?: Record<string, string> } = {}) => {
    const event = {
      sessionID: init.sessionID ?? "ses_v2test", kind: "primary",
      request: new Request(init.url ?? upstreamURL, { method: "POST", headers: { authorization: "Bearer resolved", "content-type": "application/json", ...init.headers }, body: JSON.stringify(body), signal: init.signal }),
    } as SessionHttpRequest;
    const selected = scopedHooks.get("jev-router")!;
    await selected.request!(event);
    const response = { sessionID: event.sessionID, kind: event.kind, request: event.request, response: await fetch(event.request) } as SessionHttpResponse;
    await selected.response!(response);
    return { sent: event.request, response: response.response };
  };
  return { added, hooks, scopedHooks, scopes, cleanup, exchange };
}

async function withLog<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jev-v2-"));
  try { return await run(join(dir, "nested", "decisions.jsonl")); } finally { await rm(dir, { recursive: true, force: true }); }
}
/** Forces collection so weakly held abort links break deterministically (workers run with --expose-gc). */
const collectGarbage = async () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error("vitest workers must run with --expose-gc");
  gc(); await new Promise((resolve) => setTimeout(resolve, 10)); gc();
};
const decisions = async (path: string) => {
  await vi.waitFor(async () => expect((await readFile(path, "utf8").catch(() => "")).trim()).not.toBe(""));
  return (await readFile(path, "utf8")).trim().split("\n");
};

afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("jev-router OpenCode V2 plugin", () => {
  it("exposes only the V2 entrypoint", () => {
    expect(plugin.id).toBe("jev-router");
    expect(typeof plugin.setup).toBe("function");
    expect(plugin).not.toHaveProperty("server");
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

  it("registers native Anthropic Messages only when opted in through plugin options and routes both hooks", async () => {
    const options = { fixedEffort: "high", ...upstreamOptions, anthropicUpstreamApiKey: "anthropic" };
    const { added, scopes, exchange, cleanup } = await host(options);
    expect(added).toHaveLength(1);
    expect(added[0]!.models.slice(3).map((model) => [model.id, model.providerID, model.package])).toEqual([
      ["claude-fable-5-1", "jev-router", "@opencode/ai/providers/anthropic"],
      ["claude-mythos-5-1", "jev-router", "@opencode/ai/providers/anthropic"],
      ["claude-opus-5-5", "jev-router", "@opencode/ai/providers/anthropic"],
      ["claude-opus-5", "jev-router", "@opencode/ai/providers/anthropic"],
    ]);
    expect(scopes).toEqual(["jev-router", "jev-router"]);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const sent = input as Request;
      expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
      expect(sent.headers.get("x-api-key")).toBe("anthropic");
      expect(sent.headers.get("authorization")).toBeNull();
      expect(sent.headers.get("anthropic-beta")).toContain("mid-conversation-output-config-2026-07-01");
      expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
      expect((await sent.json()).messages).toEqual([{ role: "system", content: [], output_config: { effort: "high" } }, { role: "user", content: "hi" }]);
      return new Response('data: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const body = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], stream: true };
    const url = `${upstreamOptions.upstreamBaseURL}/messages`;
    await expect(exchange(request, { url })).rejects.toThrow("invalid_request (400)");
    const { response } = await exchange(body, { url, headers: { "x-api-key": "tenant" } });
    expect(await response.text()).toContain("message_stop");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    cleanup();
    const configured = await host({ fixedEffort: "high", ...upstreamOptions, providers: { "jev-router-anthropic": { settings: { apiKey: "user" } } } });
    expect(configured.added).toHaveLength(1);
    expect(configured.scopes).toEqual(["jev-router", "jev-router"]);
    configured.cleanup();
    const byURL = await host({ fixedEffort: "high", ...upstreamOptions, anthropicUpstreamBaseURL: "https://api.anthropic.com/v1" });
    expect(byURL.added).toHaveLength(1);
    expect(byURL.added[0]!.models).toHaveLength(7);
    byURL.cleanup();
  });

  it("rejects both cross-provider model/route mismatches before fetching", async () => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const { exchange, cleanup } = await host({ fixedEffort: "high", ...upstreamOptions, anthropicUpstreamApiKey: "key" });
    await expect(exchange({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("invalid_request (400)");
    await expect(exchange(request, { url: "https://api.anthropic.com/v1/messages" })).rejects.toThrow("invalid_request (400)");
    expect(fetcher).not.toHaveBeenCalled();
    cleanup();
  });

  it("keeps provider headers separate and normalizes a blank Anthropic version", async () => {
    const sent: Request[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      sent.push(input as Request);
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { exchange, cleanup } = await host({ fixedEffort: "high", ...upstreamOptions, anthropicUpstreamApiKey: "key" });
    await (await exchange(request, { headers: { "x-api-key": "wrong", "anthropic-version": "  ", "anthropic-beta": "other", "anthropic-extra": "no" } })).response.text();
    // The OpenAI route forwards incoming headers unchanged, as before Anthropic support.
    expect(sent[0]!.headers.get("x-api-key")).toBe("wrong");
    expect(sent[0]!.headers.get("anthropic-beta")).toBe("other");
    await (await exchange({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { url: "https://api.anthropic.com/v1/messages", headers: { "x-api-key": "tenant", "anthropic-version": "  ", "anthropic-beta": "other", "openai-project": "no", "openai-beta": "no", "openai-extra": "no" } })).response.text();
    expect(sent[1]!.headers.get("authorization")).toBeNull();
    expect(sent[1]!.headers.get("x-api-key")).toBe("key");
    expect(sent[1]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent[1]!.headers.get("anthropic-beta")).toBe("other,mid-conversation-output-config-2026-07-01");
    expect([...sent[1]!.headers.keys()].filter((name) => name.startsWith("openai-"))).toEqual([]);
    cleanup();
  });

  it("sets manual redirect mode for Anthropic without changing OpenAI", async () => {
    const leaked: string[] = [];
    const target = createServer((req, res) => { leaked.push(String(req.headers["x-api-key"] ?? "")); res.end(); });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetURL = `http://127.0.0.1:${(target.address() as { port: number }).port}/v1/messages`;
    const upstream = createServer((_req, res) => { res.writeHead(307, { location: targetURL }); res.end(); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { exchange, cleanup } = await host({ fixedEffort: "high", ...upstreamOptions, anthropicUpstreamBaseURL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, anthropicUpstreamApiKey: "key" });
    try {
      const anthropic = await exchange({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/messages`, headers: { "x-api-key": "secret" } });
      expect(anthropic.sent.redirect).toBe("manual");
      expect(anthropic.response.status).toBe(307);
      expect(leaked).toEqual([]);
      globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
      const openai = await exchange(request);
      expect(openai.sent.redirect).toBe("follow");
    } finally { cleanup(); upstream.close(); target.close(); }
  });

  it("leaves an omitted upstream key to OpenCode credential resolution", async () => {
    const { added, cleanup } = await host({ jevApiKey: "jev", upstreamBaseURL: "https://example.test/v1" });
    expect(added[0]!.info.settings).toEqual({ baseURL: "https://example.test/v1", transport: "http" });
    cleanup();
  });

  it("rejects Messages before Jev when Claude is disabled", async () => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const { exchange, cleanup } = await host({ jevApiKey: "jev", ...upstreamOptions });
    await expect(exchange({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { url: `${upstreamOptions.upstreamBaseURL}/messages` })).rejects.toThrow("invalid_request (400)");
    expect(fetcher).not.toHaveBeenCalled(); cleanup();
  });

  it.each([
    [{ jevApiKey: "jev" }, "upstreamBaseURL is required"],
    [{ jevApiKey: "jev", upstreamBaseURL: "http://example.test/v1" }, "requires HTTPS"],
    [{ jevApiKey: "jev", upstreamBaseURL: "https://user:pass@example.test/v1" }, "without credentials"],
    [{ jevApiKey: "jev", ...upstreamOptions, upstreamApiKey: " " }, "upstreamApiKey"],
    [{ ...upstreamOptions }, "JEV_API_KEY is required"],
    [{ jevApiKey: "jev", ...upstreamOptions, decisionsLogPath: "relative.jsonl" }, "absolute path"],
  ])("rejects invalid options during setup: %j", async (options, message) => {
    vi.stubEnv("JEV_API_KEY", "");
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
    [1, "request.model"],
    [[], "request.model"],
    ["request", "request.model"],
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

  it("enforces declared body limits without classifying", async () => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const { hooks, cleanup } = await host({ jevApiKey: "jev", maxRequestBytes: 2, ...upstreamOptions });
    const event = { sessionID: "ses_v2test", kind: "primary", request: new Request(upstreamURL, { method: "POST", headers: { "content-length": "999" }, body: "{}" }) } as SessionHttpRequest;
    await expect(hooks.request!(event)).rejects.toThrow("request_too_large (413)");
    expect(fetcher).not.toHaveBeenCalled(); cleanup();
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
    // The host drops the original request after the hook; cancellation must survive its collection.
    await collectGarbage();
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

  it("preserves provider headers while dropping internal and hop-by-hop headers at a header timeout", async () => {
    let received: Headers | undefined;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      if (isJev(input)) return Promise.resolve(jevAnswer("high"));
      received = (input as Request).headers;
      return new Promise<Response>((_resolve, reject) => (input as Request).signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }) as typeof fetch;
    const { exchange, cleanup } = await host({ jevApiKey: "jev", upstreamHeaderTimeoutMs: 5, ...upstreamOptions });
    await expect(exchange(request, { headers: { "openai-project": "project", "openai-organization": "org", "x-jev-session-id": "ses_secret", "x-opencode-session-id": "private", connection: "x-hop", "x-hop": "no", "x-random": "kept" } })).rejects.toThrow();
    expect(received!.get("openai-project")).toBe("project");
    expect(received!.get("openai-organization")).toBe("org");
    expect(received!.get("x-random")).toBe("kept");
    for (const header of ["x-jev-session-id", "x-opencode-session-id", "connection", "x-hop"]) expect(received!.get(header)).toBeNull();
    cleanup();
  });

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

  it("commits Anthropic lineage on message_stop followed by consumer cancellation", async () => withLog(async (path) => {
    const bodies: Record<string, unknown>[] = [];
    let effort = "high";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isJev(input)) return jevAnswer(effort);
      bodies.push(await new Request(input, init).json());
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const { exchange, cleanup } = await host({ jevApiKey: "jev", decisionsLogPath: path, ...upstreamOptions, anthropicUpstreamApiKey: "key" });
    const url = "https://api.anthropic.com/v1/messages";
    const first = { role: "user", content: "first" };
    const body = { model: "claude-opus-5-5", messages: [first], stream: true };
    const response = (await exchange(body, { url, headers: { "x-api-key": "tenant" } })).response;
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("message_stop");
    await reader.cancel();
    expect(JSON.parse((await decisions(path))[0]!)).toMatchObject({ effort: "high", outcome: "completed" });
    effort = "low";
    const history = [first, { role: "assistant", content: "done" }, { role: "user", content: "next" }];
    await (await exchange({ ...body, messages: history }, { url, headers: { "x-api-key": "tenant" } })).response.body!.cancel();
    expect(bodies[1]!.messages).toEqual([{ role: "system", content: [], output_config: { effort: "high" } }, first, history[1], { role: "system", content: [], output_config: { effort: "low" } }, history[2]]);
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
    const event = { sessionID: "ses_other", kind: "primary", request: new Request(upstreamURL), response: original } as SessionHttpResponse;
    await hooks.response!(event);
    expect(event.response).toBe(original);
    cleanup();
  });

  it("rejects a response that arrives after the header deadline settled the exchange", async () => withLog(async (path) => {
    let upstreamCancelled = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => isJev(input) ? jevAnswer("high") : new Response(new ReadableStream({ cancel() { upstreamCancelled = true; } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const { hooks, cleanup } = await host({ jevApiKey: "jev", maxInFlight: 1, upstreamHeaderTimeoutMs: 5, decisionsLogPath: path, ...upstreamOptions });
    const event = { sessionID: "ses_v2test", kind: "primary", request: new Request(upstreamURL, { method: "POST", body: JSON.stringify(request) }) } as SessionHttpRequest;
    await hooks.request!(event);
    const late = await fetch(event.request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect((async () => hooks.response!({ ...event, response: late } as SessionHttpResponse))()).rejects.toThrow("upstream_timeout (504)");
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
    const pending = { sessionID: "ses_v2test", kind: "primary", request: new Request(upstreamURL, { method: "POST", body: JSON.stringify(request) }) } as SessionHttpRequest;
    await hooks.request!(pending);
    cleanup();
    expect(aborted).toBe(1);
    expect(pending.request.signal.aborted).toBe(true);
    await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2));
    expect((await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line).outcome)).toEqual(["failed", "failed"]);
    await expect(exchange(request)).rejects.toThrow("unavailable (503)");
  }));

  it("routes fixed effort without Jev and logs usage after downstream reads", async () => withLog(async (path) => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(isJev(input)).toBe(false);
      const body = await (input as Request).json();
      expect(body.reasoning).toEqual({ effort: "medium" });
      expect(body.input[0]).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
      return new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 3, output_tokens: 2 } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { exchange, cleanup } = await host({ fixedEffort: "high", decisionsLogPath: path, ...upstreamOptions });
    const { response } = await exchange(request);
    expect(await readFile(path, "utf8").catch(() => "")).toBe("");
    await response.text();
    expect(JSON.parse((await decisions(path))[0]!)).toMatchObject({ effort: "high", jev_latency_ms: 0, fallback: null, input_tokens: 3, output_tokens: 2 });
    cleanup();
  }));

  it("isolates Anthropic lineage by key, beta, and version", async () => withLog(async (path) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ type: "message", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    const { exchange, cleanup } = await host({ fixedEffort: "high", decisionsLogPath: path, ...upstreamOptions, anthropicUpstreamBaseURL: "https://upstream.test/v1" });
    const first = { role: "user", content: "first" };
    const send = async (key: string, messages: unknown[], headers: Record<string, string> = {}) => {
      const { response } = await exchange({ model: "claude-opus-5-5", messages }, { url: "https://upstream.test/v1/messages", headers: { "x-api-key": key, authorization: "Bearer shared", ...headers } });
      await response.text();
    };
    await send("tenant-a", [first]);
    const history = [first, { role: "assistant", content: "done" }, { role: "user", content: "next" }];
    await send("tenant-a", history);
    await send("tenant-b", history);
    await send("tenant-a", history, { "anthropic-beta": "extra" });
    await send("tenant-a", history, { "anthropic-version": "2024-01-01" });
    await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(5));
    expect((await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line).lineage_status)).toEqual(["new", "preserved", "new", "new", "new"]);
    cleanup();
  }));

  it("rejects missing cross-origin Anthropic key and filters unrelated headers", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })); globalThis.fetch = fetcher as typeof fetch;
    const body = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] };
    const without = await host({ fixedEffort: "high", ...upstreamOptions, anthropicUpstreamBaseURL: "https://api.anthropic.com/v1" });
    await expect(without.exchange(body, { url: `${upstreamOptions.upstreamBaseURL}/messages` })).rejects.toThrow("anthropicUpstreamApiKey is required");
    expect(fetcher).not.toHaveBeenCalled(); without.cleanup();
    const withKey = await host({ fixedEffort: "high", ...upstreamOptions, anthropicUpstreamApiKey: "anthropic-key" });
    const { sent } = await withKey.exchange(body, { url: `${upstreamOptions.upstreamBaseURL}/messages`, headers: { authorization: "Bearer openai-key", "x-gateway-secret": "s", cookie: "c=1", "x-api-key": "openai-key", "anthropic-version": "2023-06-01", "user-agent": "ai-sdk" } });
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect([...sent.headers.keys()].sort()).toEqual(["anthropic-beta", "anthropic-version", "content-type", "user-agent", "x-api-key"]);
    expect(sent.headers.get("x-api-key")).toBe("anthropic-key"); withKey.cleanup();
  });

  it("discards failed attempts before routing a different-effort retry", async () => {
    let effort = "high"; let attempts = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (isJev(input)) return jevAnswer(effort);
      if (++attempts === 1) throw new Error("offline");
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { exchange, cleanup } = await host({ jevApiKey: "jev", ...upstreamOptions });
    await expect(exchange(request)).rejects.toThrow();
    effort = "low";
    expect((await exchange(request)).response.status).toBe(200);
    cleanup();
  });

  it("records one fallback failure without logging raw upstream errors", async () => withLog(async (path) => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (isJev(input)) return jevAnswer("invalid");
      throw new Error("secret upstream error");
    }) as typeof fetch;
    const { exchange, cleanup } = await host({ jevApiKey: "jev", upstreamHeaderTimeoutMs: 5, decisionsLogPath: path, ...upstreamOptions });
    await expect(exchange(request)).rejects.toThrow();
    const lines = await decisions(path);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ effort: "high", fallback: "jev_invalid_output", outcome: "failed" });
    expect(lines[0]).not.toContain("secret upstream error"); cleanup();
  }));

  it("does not interrupt generation when decision logging fails", async () => withLog(async (path) => {
    const blocked = join(path, "decisions.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not a directory");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })) as typeof fetch;
    const { exchange, cleanup } = await host({ fixedEffort: "high", decisionsLogPath: blocked, ...upstreamOptions });
    expect(await (await exchange(request)).response.text()).toBe("{}");
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith('{"event":"decision_log_failed"}'));
    cleanup();
  }));

  it("records a cancelled stream only once even if cancelled twice", async () => withLog(async (path) => {
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("chunk")); } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const { exchange, cleanup } = await host({ fixedEffort: "high", decisionsLogPath: path, ...upstreamOptions });
    const reader = (await exchange(request)).response.body!.getReader();
    await reader.read(); await reader.cancel(); await reader.cancel();
    const lines = await decisions(path);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).outcome).toBe("failed"); cleanup();
  }));
});
