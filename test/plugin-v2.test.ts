import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import type { Plugin } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { ModelEditor } from "@opencode/plugin/promise/model";
import type { SessionHttpRequest, SessionHttpResponse } from "@opencode/plugin/promise/session";

import plugin from "../src/plugin.js";

const originalFetch = globalThis.fetch;
const OPENAI = "@opencode/ai/providers/openai/responses";
const ANTHROPIC = "@opencode/ai/providers/anthropic";
const base = { fixedEffort: "high", wrap: { openai: ["gw/gpt-6-astra"], anthropic: ["claude/claude-opus-5-5"] } };
const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] }];
const body = { model: "gpt-6-astra", input, stream: true, prompt_cache_key: "ses_test" };
const sources = () => new Map([
  ["gw", { provider: { id: "gw", package: OPENAI, integrationID: "gw", settings: { baseURL: "https://a.test/v1", apiKey: "config-key", transport: "websocket" }, headers: { "x-source": "provider" }, body: { top: true } }, models: new Map([["gpt-6-astra", { id: "gpt-6-astra", modelID: "gpt-6-astra", settings: { extra: 1 }, headers: { "x-model": "yes" }, body: { model: true }, limit: { context: 123 }, cost: [1], variants: ["high"] }]]) }],
  ["claude", { provider: { id: "claude", package: ANTHROPIC, integrationID: "claude", settings: { baseURL: "https://claude.test/v1" } }, models: new Map([["claude-opus-5-5", { id: "claude-opus-5-5", modelID: "claude-opus-5-5", limit: { context: 456 } }], ["claude-sonnet-5-5", { id: "claude-sonnet-5-5", modelID: "claude-sonnet-5-5", limit: { context: 456 } }]]) }],
]);

async function host(options: Record<string, unknown> = base, source = sources(), credentials: Record<string, unknown> = {}) {
  const registrations: unknown[] = [];
  const aliases = new Map<string, Record<string, unknown>>();
  const hooks = new Map<string, (event: any) => Promise<void> | void>();
  let providerTransform!: (editor: ProviderEditor) => void;
  let modelTransform!: (editor: ModelEditor) => void;
  const ctx = {
    options,
    provider: { async transform(callback: typeof providerTransform) { providerTransform = callback; } },
    model: { async transform(callback: typeof modelTransform) { modelTransform = callback; } },
    integration: { connection: { async active(id: string) { return credentials[id] ? { id } : undefined; }, async resolve(connection: { id: string }) { return credentials[connection.id]; } } },
    session: { async hook(name: string, callback: (event: any) => void, scope: { providerID: string }) { expect(scope.providerID).toBe("jev-router"); hooks.set(name, callback); } },
  } as unknown as Plugin.Context;
  const cleanup = await plugin.setup(ctx);
  const providerPass = () => {
    aliases.clear();
    providerTransform({ add(registration: any) { registrations.push(registration); for (const model of registration.models) aliases.set(model.id, { ...model }); } } as ProviderEditor);
  };
  const modelPass = () => {
    modelTransform({
      get(providerID: string, modelID: string) { return (source.get(providerID)?.models.get(modelID) ?? aliases.get(modelID)) as never; },
      provider: { get(providerID: string) { return source.get(providerID) as never; } },
      update(_providerID: string, modelID: string, update: (model: any) => void) { update(aliases.get(modelID)); },
      remove(_providerID: string, modelID: string) { aliases.delete(modelID); },
    } as unknown as ModelEditor);
  };
  const reload = () => { providerPass(); modelPass(); };
  reload();
  const event = (data: unknown = body, init: { model?: string; kind?: string; url?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => ({
    model: { providerID: "jev-router", id: init.model ?? "gpt-6-astra" }, sessionID: "ses_test", kind: init.kind ?? "primary",
    request: new Request(init.url ?? "https://a.test/v1/responses", { method: "POST", headers: { authorization: "Bearer config-key", "content-type": "application/json", ...init.headers }, body: JSON.stringify(data), signal: init.signal }),
  }) as SessionHttpRequest;
  const exchange = async (data: unknown = body, init: { model?: string; kind?: string; url?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const call = event(data, init);
    await hooks.get("http.request")!(call);
    const response = { ...call, response: await fetch(call.request) } as SessionHttpResponse;
    await hooks.get("http.response")!(response);
    return { request: call.request, response: response.response };
  };
  return { registrations, aliases, hooks, cleanup, reload, providerPass, modelPass, event, exchange };
}

async function withLog<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jev-v2-"));
  try { return await run(join(dir, "nested", "decisions.jsonl")); } finally { await rm(dir, { recursive: true, force: true }); }
}
const decisions = async (path: string) => {
  await vi.waitFor(async () => expect((await readFile(path, "utf8").catch(() => "")).trim()).not.toBe(""));
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
};
const collectGarbage = async () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("vitest workers must run with --expose-gc");
  gc(); await new Promise((resolve) => setTimeout(resolve, 10)); gc();
};

afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("V2 wrap aliases", () => {
  const invalidOptions: [Record<string, unknown>, string][] = [
    [{}, "wrap must"], [{ wrap: {} }, "wrap must"], [{ wrap: { unknown: ["gw/gpt-6-astra"] } }, "unknown wrap group"],
    [{ wrap: { openai: [] } }, "nonempty array"], [{ wrap: { openai: ["invalid"] } }, "provider/model refs"],
    ...["upstreamBaseURL", "upstreamApiKey", "anthropicUpstreamBaseURL", "anthropicUpstreamApiKey"].map((key): [Record<string, unknown>, string] => [{ ...base, [key]: "old" }, `${key} was removed`]),
  ];
  it.each(invalidOptions)("rejects invalid setup options %j", async (options, error) => { await expect(host(options)).rejects.toThrow(error); });

  it("registers placeholders, copies late source metadata, removes unused aliases and survives reload", async () => {
    const h = await host();
    expect((h.registrations[0] as any).info).toMatchObject({ id: "jev-router", settings: { transport: "http" } });
    expect((h.registrations[0] as any).models).toHaveLength(9);
    expect([...h.aliases.keys()].sort()).toEqual(["claude-opus-5-5", "gpt-6-astra"]);
    expect(h.aliases.get("gpt-6-astra")).toMatchObject({ name: "GPT-6 Astra", modelID: "gpt-6-astra", limit: { context: 123 }, cost: [1], variants: [], settings: { baseURL: "https://a.test/v1", apiKey: "config-key", extra: 1 }, headers: { "x-source": "provider", "x-model": "yes" }, body: { top: true, model: true } });
    expect(h.aliases.get("gpt-6-astra")).toMatchObject({ transport: "http" });
    expect(h.aliases.get("gpt-6-astra")?.settings).not.toHaveProperty("transport");
    h.reload(); expect([...h.aliases.keys()].sort()).toEqual(["claude-opus-5-5", "gpt-6-astra"]); h.cleanup();
  });

  it("wraps Claude Sonnet 5.5 from a native Anthropic provider", async () => {
    const h = await host({ ...base, wrap: { anthropic: ["claude/claude-sonnet-5-5"] } });
    expect(h.aliases.get("claude-sonnet-5-5")).toMatchObject({ modelID: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" });
    h.cleanup();
  });

  it.each([
    ["missing", { openai: ["absent/gpt-6-astra"] }, "not found"],
    ["non-profile", { openai: ["gw/other"] }, "not found"],
    ["duplicate", { openai: ["gw/gpt-6-astra", "gw/gpt-6-astra"] }, "duplicate wrap profile"],
  ])("reports %s registry errors on request", async (_label, wrap, error) => {
    const h = await host({ ...base, wrap });
    await expect(h.exchange()).rejects.toThrow(error); h.cleanup();
  });

  it("validates the resolved API model ID and package, not just the source ref", async () => {
    const source = sources() as any;
    source.get("gw")!.models.set("other", { id: "other", modelID: "other" });
    const unsupported = await host({ ...base, wrap: { openai: ["gw/other"] } }, source);
    await expect(unsupported.exchange()).rejects.toThrow("not a registered openai profile"); unsupported.cleanup();
    source.get("gw")!.models.get("gpt-6-astra")!.package = ANTHROPIC;
    const mismatch = await host({ ...base, wrap: { openai: ["gw/gpt-6-astra"] } }, source);
    await expect(mismatch.exchange()).rejects.toThrow(`requires package ${OPENAI}`); mismatch.cleanup();
    source.get("gw")!.models.set("alias", { id: "alias", modelID: "gpt-6-astra" });
    source.get("gw")!.models.get("alias")!.package = OPENAI;
    const resolved = await host({ ...base, wrap: { openai: ["gw/alias"] } }, source);
    expect([...resolved.aliases.keys()]).toEqual(["gpt-6-astra"]); resolved.cleanup();
  });

  it("accepts the built-in OpenAI package without changing its source model", async () => {
    const source = sources();
    source.get("gw")!.provider.package = "@opencode/ai/providers/openai";
    const h = await host(base, source);
    expect(h.aliases.get("gpt-6-astra")?.package).toBe("@opencode/ai/providers/openai");
    globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
    expect((await h.exchange()).request.url).toBe("https://a.test/v1/responses"); h.cleanup();
  });

  it("rejects primary non-generation routes without forwarding or classifying", async () => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const h = await host();
    await expect(h.exchange(body, { url: "https://a.test/v1/chat/completions" })).rejects.toThrow("alias requires /responses");
    expect(fetcher).not.toHaveBeenCalled(); h.cleanup();
  });

  it("passes a non-generation route through for auxiliary calls", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
    const h = await host();
    const sent = await h.exchange(body, { kind: "title", url: "https://a.test/v1/chat/completions" });
    expect(sent.request.url).toBe("https://a.test/v1/chat/completions"); h.cleanup();
  });

  it("reports the typo, not a duplicate of a valid profile, and rejects every alias", async () => {
    const h = await host({ ...base, wrap: { openai: ["gw/typo", "gw/gpt-6-astra"], anthropic: ["claude/claude-opus-5-5"] } });
    await expect(h.exchange()).rejects.toThrow("source model gw/typo not found");
    await expect(h.exchange({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { model: "claude-opus-5-5" })).rejects.toThrow("source model gw/typo not found");
    expect(h.aliases.has("gpt-6-astra")).toBe(true);
    h.cleanup();
  });

  it("keeps active aliases during provider-transform reload, then atomically updates them", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
    const h = await host();
    h.providerPass();
    expect((await h.exchange()).response.status).toBe(200);
    h.modelPass();
    expect((await h.exchange()).response.status).toBe(200);
    h.cleanup();
  });

  it("pins HTTP transport over a source model's top-level websocket preference", async () => {
    const source = sources() as any;
    source.get("gw").models.get("gpt-6-astra").transport = "websocket";
    const h = await host(base, source);
    expect(h.aliases.get("gpt-6-astra")?.transport).toBe("http"); h.cleanup();
  });

  it("uses a present wire auth header unchanged without resolving an OAuth integration", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
    const h = await host(base, sources(), { gw: { type: "oauth", access: "token" } });
    const call = h.event(); const original = call.request;
    await h.hooks.get("http.request")!(call);
    expect(call.request.headers.get("authorization")).toBe("Bearer config-key");
    expect(call.request).not.toBe(original); // Only routing replaces the original.
    h.cleanup();
  });

  it("injects an integration key into the original Request headers for auxiliary calls", async () => {
    const h = await host(base, sources(), { gw: { type: "key", key: "stored" } });
    const call = h.event(body, { kind: "title", headers: { authorization: "" } });
    const original = call.request;
    await h.hooks.get("http.request")!(call);
    expect(call.request).toBe(original);
    expect(original.headers.get("authorization")).toBe("Bearer stored");
    h.cleanup();
  });

  it("rewrites primary requests, logs correlated metadata, and preserves origin and credential lineage isolation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-wrap-"));
    try {
      const path = join(dir, "events.jsonl");
      const bodies: any[] = [];
      globalThis.fetch = vi.fn(async (request: Request) => { bodies.push(await request.json()); return new Response(JSON.stringify({ status: "completed" }), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
      const h = await host({ ...base, decisionsLogPath: path });
      const send = async (url: string, authorization: string, data: any) => (await h.exchange(data, { url, headers: { authorization } })).response.text();
      await send("https://a.test/v1/responses", "Bearer a", body);
      const next = { ...body, input: [...input, { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }] };
      await send("https://a.test/v1/responses", "Bearer a", next);
      await send("https://b.test/v1/responses", "Bearer a", next);
      await send("https://a.test/v1/responses", "Bearer b", next);
      expect(bodies[0].input[0].type).toBe("configuration_update");
      expect(bodies[1].input.filter((item: any) => item.type === "configuration_update")).toHaveLength(1);
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(4));
      expect((await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line).lineage_status)).toEqual(["new", "preserved", "new", "new"]);
      expect(JSON.parse((await readFile(path, "utf8")).trim().split("\n")[0]!)).toMatchObject({ session: "ses_test", effort: "high", event: "JevDecision" });
      h.cleanup();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("injects a stored OpenAI key into an auxiliary title request", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
    const h = await host(base, sources(), { gw: { type: "key", key: "stored" } });
    const title = await h.exchange(body, { kind: "title", headers: { authorization: "" } });
    expect(title.request.headers.get("authorization")).toBe("Bearer stored");
    expect(await title.request.clone().json()).toEqual(body); h.cleanup();
  });

  it("leaves compaction requests untouched", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
    const h = await host();
    const compact = await h.exchange(body, { kind: "compaction", url: "https://a.test/v1/responses/compact" });
    expect(await compact.request.clone().json()).toEqual(body); h.cleanup();
  });

  it("injects an Anthropic integration key and avoids redirects", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
    const h = await host(base, sources(), { claude: { type: "key", key: "claude-key" } });
    const claude = await h.exchange({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { model: "claude-opus-5-5", url: "https://claude.test/v1/messages", headers: { authorization: "", "x-api-key": "" } });
    expect(claude.request.headers.get("x-api-key")).toBe("claude-key");
    expect(claude.request.redirect).toBe("manual"); h.cleanup();
  });

  it("rejects an OAuth source without an existing wire credential", async () => {
    const oauth = await host(base, sources(), { gw: { type: "oauth", access: "token" } });
    await expect(oauth.exchange(body, { headers: { authorization: "" } })).rejects.toThrow("uses OAuth"); oauth.cleanup();
  });

  it("rejects a source without an API key", async () => {
    const missing = await host();
    await expect(missing.exchange(body, { headers: { authorization: "" } })).rejects.toThrow("has no API key"); missing.cleanup();
  });

  it("rejects mismatched primary wire and guards websocket overrides", async () => {
    const h = await host();
    await expect(h.exchange(body, { url: "https://a.test/v1/messages" })).rejects.toThrow("alias requires /responses");
    expect(() => h.hooks.get("experimental.ws.handshake")!({})).toThrow("jev-router requires transport: http");
    h.cleanup();
  });

  it.each([
    [{ ...body, truncation: "auto" }, "truncation"],
    [{ ...body, reasoning: { mode: "pro" } }, "reasoning.mode"],
    [{ ...body, model: "other" }, "request.model"],
  ])("rejects unsupported primary input before fetching", async (data, message) => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const h = await host();
    await expect(h.exchange(data)).rejects.toThrow(message);
    expect(fetcher).not.toHaveBeenCalled(); h.cleanup();
  });

  it("streams chunks incrementally and cancels the upstream on consumer cancellation", async () => {
    let push!: (chunk: Uint8Array) => void;
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { push = (chunk) => controller.enqueue(chunk); }, cancel() { cancelled = true; } });
    globalThis.fetch = vi.fn(async () => new Response(upstream, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const h = await host();
    const result = await h.exchange();
    const bytes = new TextEncoder().encode("data: chunk\n\n");
    push(bytes);
    const reader = result.response.body!.getReader();
    expect((await reader.read()).value).toEqual(bytes);
    await reader.cancel(); expect(cancelled).toBe(true); h.cleanup();
  });

  it("limits actual request bytes before classification", async () => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const h = await host({ ...base, maxRequestBytes: 16 });
    await expect(h.exchange()).rejects.toThrow("request_too_large (413)");
    expect(fetcher).not.toHaveBeenCalled(); h.cleanup();
  });

  it("rejects declared oversize content-length before classification", async () => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const h = await host({ ...base, maxRequestBytes: 2 });
    const call = h.event(body, { headers: { "content-length": "999" } });
    await expect(h.hooks.get("http.request")!(call)).rejects.toThrow("request_too_large (413)");
    expect(fetcher).not.toHaveBeenCalled(); h.cleanup();
  });

  it("falls back to a validated effort when Jev times out", async () => withLog(async (path) => {
    const upstream: any[] = [];
    globalThis.fetch = vi.fn((request: RequestInfo | URL, init?: RequestInit) => (request instanceof Request ? request.url : String(request)).includes("api.typesafe.ai")
      ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      : (async () => { upstream.push(await (request as Request).json()); return new Response("{}", { headers: { "content-type": "application/json" } }); })()) as typeof fetch;
    const h = await host({ jevApiKey: "jev", wrap: base.wrap, jevTimeoutMs: 5, maxRetries: 0, fallbackEffort: "low", decisionsLogPath: path });
    await (await h.exchange()).response.text();
    expect(upstream[0].input[0]).toEqual({ type: "configuration_update", reasoning: { effort: "low" } });
    expect((await decisions(path))[0]).toMatchObject({ effort: "low", fallback: "jev_timeout", outcome: "completed" }); h.cleanup();
  }));

  it("session cancellation aborts classification without starting upstream generation", async () => {
    const upstream = vi.fn();
    globalThis.fetch = vi.fn((request: RequestInfo | URL, init?: RequestInit) => (request instanceof Request ? request.url : String(request)).includes("api.typesafe.ai")
      ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      : upstream(request, init)) as typeof fetch;
    const h = await host({ jevApiKey: "jev", wrap: base.wrap });
    const controller = new AbortController(); const call = h.exchange(body, { signal: controller.signal });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled()); controller.abort();
    await expect(call).rejects.toThrow("cancelled (499)"); expect(upstream).not.toHaveBeenCalled(); h.cleanup();
  });

  it.each([false, true])("retains original Request across forced GC during pre-header cancellation (injected=%s)", async (inject) => withLog(async (path) => {
    globalThis.fetch = vi.fn((request: RequestInfo | URL) => (request instanceof Request ? request.url : String(request)).includes("api.typesafe.ai")
      ? Promise.resolve(new Response(JSON.stringify({ answers: { effort: { choice: "high" } } })))
      : new Promise<Response>((_resolve, reject) => (request as Request).signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    const h = await host({ jevApiKey: "jev", wrap: base.wrap, maxRetries: 0, maxInFlight: 1, decisionsLogPath: path }, sources(), inject ? { gw: { type: "key", key: "stored" } } : {});
    const controller = new AbortController();
    const event = h.event(body, { signal: controller.signal, ...(inject ? { headers: { authorization: "" } } : {}) });
    let original: Request | null = event.request;
    const retained = new WeakRef(original);
    await h.hooks.get("http.request")!(event);
    expect(event.request).not.toBe(original);
    original = null;
    const call = fetch(event.request);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    await collectGarbage();
    expect(retained.deref()).toBeDefined();
    controller.abort();
    await expect(call).rejects.toThrow();
    expect((await decisions(path))[0]).toMatchObject({ effort: "high", outcome: "failed" });
    globalThis.fetch = vi.fn(async (request: RequestInfo | URL) => (request instanceof Request ? request.url : String(request)).includes("api.typesafe.ai")
      ? new Response(JSON.stringify({ answers: { effort: { choice: "low" } } })) : new Response("{}")) as typeof fetch;
    expect((await h.exchange()).response.status).toBe(200); h.cleanup();
  }));

  it("header deadline aborts upstream and records one failure", async () => withLog(async (path) => {
    let aborted = false;
    globalThis.fetch = vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }))) as typeof fetch;
    const h = await host({ ...base, upstreamHeaderTimeoutMs: 5, decisionsLogPath: path });
    await expect(h.exchange()).rejects.toThrow();
    expect(aborted).toBe(true); expect((await decisions(path))[0].outcome).toBe("failed"); h.cleanup();
  }));

  it("preserves provider headers but drops internal and hop-by-hop headers", async () => {
    let received: Headers | undefined;
    globalThis.fetch = vi.fn(async (request: Request) => { received = request.headers; return new Response("{}"); }) as typeof fetch;
    const h = await host();
    await h.exchange(body, { headers: { "openai-project": "project", "openai-organization": "org", "x-jev-session-id": "ses_secret", "x-opencode-session-id": "private", connection: "x-hop", "x-hop": "no", "x-random": "kept" } });
    expect(received!.get("openai-project")).toBe("project"); expect(received!.get("openai-organization")).toBe("org"); expect(received!.get("x-random")).toBe("kept");
    for (const name of ["x-jev-session-id", "x-opencode-session-id", "connection", "x-hop"]) expect(received!.get(name)).toBeNull(); h.cleanup();
  });

  it("passes upstream errors with status and body unchanged", async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"error":{"message":"bad"}}', { status: 429, headers: { "content-type": "application/json", "retry-after": "3" } })) as typeof fetch;
    const h = await host(); const { response } = await h.exchange();
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe('{"error":{"message":"bad"}}'); h.cleanup();
  });

  it("ignores responses for requests it did not route", async () => {
    const h = await host(); const original = new Response("untouched");
    const event = { ...h.event(), response: original } as SessionHttpResponse;
    await h.hooks.get("http.response")!(event);
    expect(event.response).toBe(original); h.cleanup();
  });

  it("rejects and cancels a late response after the header deadline", async () => withLog(async (path) => {
    let cancelled = false;
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const h = await host({ ...base, upstreamHeaderTimeoutMs: 5, decisionsLogPath: path });
    const call = h.event(); await h.hooks.get("http.request")!(call);
    const late = await fetch(call.request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect((async () => h.hooks.get("http.response")!({ ...call, response: late }))()).rejects.toThrow("upstream_timeout (504)");
    expect(cancelled).toBe(true); expect((await decisions(path))[0].outcome).toBe("failed"); h.cleanup();
  }));

  it("commits OpenAI lineage when consumer cancels after response.completed", async () => withLog(async (path) => {
    const bodies: any[] = []; let effort = "high";
    globalThis.fetch = vi.fn(async (request: Request) => {
      bodies.push(await request.json());
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":1}}}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const h = await host({ ...base, fixedEffort: effort, decisionsLogPath: path });
    const reader = (await h.exchange()).response.body!.getReader(); await reader.read(); await reader.cancel();
    expect((await decisions(path))[0]).toMatchObject({ outcome: "completed", input_tokens: 4 });
    const next = { ...body, input: [...input, { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }] };
    await (await h.exchange(next)).response.body!.cancel();
    expect(bodies[1].input.filter((item: any) => item.type === "configuration_update")).toHaveLength(1); h.cleanup();
  }));

  it("commits Anthropic lineage when consumer cancels after message_stop", async () => withLog(async (path) => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (request: Request) => {
      bodies.push(await request.json());
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const h = await host({ ...base, decisionsLogPath: path });
    const first = { role: "user", content: "first" };
    const send = async (messages: unknown[]) => h.exchange({ model: "claude-opus-5-5", messages, stream: true }, { model: "claude-opus-5-5", url: "https://claude.test/v1/messages", headers: { "x-api-key": "tenant" } });
    const reader = (await send([first])).response.body!.getReader(); await reader.read(); await reader.cancel();
    expect((await decisions(path))[0].outcome).toBe("completed");
    await (await send([first, { role: "assistant", content: "done" }, { role: "user", content: "next" }])).response.body!.cancel();
    expect(bodies[1].messages.filter((item: any) => item.output_config?.effort)).toHaveLength(1); h.cleanup();
  }));

  it("cleanup aborts in-flight work, records each once and rejects new work", async () => withLog(async (path) => {
    let aborted = 0;
    globalThis.fetch = vi.fn(async (request: Request) => {
      request.signal.addEventListener("abort", () => { aborted++; });
      return new Response(new ReadableStream());
    }) as typeof fetch;
    const h = await host({ ...base, decisionsLogPath: path });
    await h.exchange();
    const pending = h.event(); await h.hooks.get("http.request")!(pending);
    h.cleanup(); expect(aborted).toBe(1); expect(pending.request.signal.aborted).toBe(true);
    await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2));
    expect((await decisions(path)).map((line) => line.outcome)).toEqual(["failed", "failed"]);
    await expect(h.exchange()).rejects.toThrow("unavailable (503)");
  }));

  it("fixed effort avoids Jev and logs usage only after downstream reads", async () => withLog(async (path) => {
    globalThis.fetch = vi.fn(async (request: Request) => {
      expect(request.url).not.toContain("api.typesafe.ai");
      expect((await request.json()).reasoning).toEqual({ effort: "medium" });
      return new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 3, output_tokens: 2 } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const h = await host({ ...base, decisionsLogPath: path });
    const { response } = await h.exchange(); expect(await readFile(path, "utf8").catch(() => "")).toBe("");
    await response.text(); expect((await decisions(path))[0]).toMatchObject({ effort: "high", input_tokens: 3, output_tokens: 2 }); h.cleanup();
  }));

  it("isolates Anthropic lineage by key, beta and version", async () => withLog(async (path) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ type: "message", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    const h = await host({ ...base, decisionsLogPath: path });
    const first = { role: "user", content: "first" };
    const send = async (key: string, messages: unknown[], headers: Record<string, string> = {}) => {
      const { response } = await h.exchange({ model: "claude-opus-5-5", messages }, { model: "claude-opus-5-5", url: "https://claude.test/v1/messages", headers: { "x-api-key": key, ...headers } }); await response.text();
    };
    await send("tenant-a", [first]);
    const history = [first, { role: "assistant", content: "done" }, { role: "user", content: "next" }];
    await send("tenant-a", history); await send("tenant-b", history);
    await send("tenant-a", history, { "anthropic-beta": "extra" });
    await send("tenant-a", history, { "anthropic-version": "2024-01-01" });
    await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(5));
    expect((await decisions(path)).map((line) => line.lineage_status)).toEqual(["new", "preserved", "new", "new", "new"]); h.cleanup();
  }));

  it("normalizes blank Anthropic version and merges beta without rewriting auth", async () => {
    let received: Request | undefined;
    globalThis.fetch = vi.fn(async (request: Request) => { received = request; return new Response("{}"); }) as typeof fetch;
    const h = await host();
    await h.exchange({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { model: "claude-opus-5-5", url: "https://claude.test/v1/messages", headers: { "x-api-key": "tenant", "anthropic-version": "  ", "anthropic-beta": "other", "openai-project": "no" } });
    expect(received!.headers.get("x-api-key")).toBe("tenant");
    expect(received!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(received!.headers.get("anthropic-beta")).toBe("other,mid-conversation-output-config-2026-07-01");
    expect(received!.headers.get("openai-project")).toBeNull(); h.cleanup();
  });

  it("uses manual redirects for Anthropic but not OpenAI", async () => {
    const leaked: string[] = [];
    const target = createServer((req, res) => { leaked.push(String(req.headers["x-api-key"] ?? "")); res.end(); });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetURL = `http://127.0.0.1:${(target.address() as { port: number }).port}/v1/messages`;
    const upstream = createServer((_req, res) => { res.writeHead(307, { location: targetURL }); res.end(); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const h = await host();
    try {
      const anth = await h.exchange({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { model: "claude-opus-5-5", url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/messages`, headers: { "x-api-key": "secret" } });
      expect(anth.request.redirect).toBe("manual"); expect(anth.response.status).toBe(307); expect(leaked).toEqual([]);
      globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
      expect((await h.exchange()).request.redirect).toBe("follow");
    } finally { h.cleanup(); upstream.close(); target.close(); }
  });

  it("discards failed attempts before routing a different-effort retry", async () => {
    let effort = "high"; let attempts = 0;
    globalThis.fetch = vi.fn(async (request: RequestInfo | URL) => (request instanceof Request ? request.url : String(request)).includes("api.typesafe.ai")
      ? new Response(JSON.stringify({ answers: { effort: { choice: effort } } }))
      : ++attempts === 1 ? Promise.reject(new Error("offline")) : new Response("{}")) as typeof fetch;
    const h = await host({ jevApiKey: "jev", wrap: base.wrap });
    await expect(h.exchange()).rejects.toThrow(); effort = "low";
    expect((await h.exchange()).response.status).toBe(200); h.cleanup();
  });

  it("logs one fallback failure without a raw upstream error", async () => withLog(async (path) => {
    globalThis.fetch = vi.fn(async (request: RequestInfo | URL) => {
      if ((request instanceof Request ? request.url : String(request)).includes("api.typesafe.ai")) return new Response(JSON.stringify({ answers: { effort: { choice: "invalid" } } }));
      throw new Error("secret upstream error");
    }) as typeof fetch;
    const h = await host({ jevApiKey: "jev", wrap: base.wrap, upstreamHeaderTimeoutMs: 5, decisionsLogPath: path });
    await expect(h.exchange()).rejects.toThrow();
    const lines = await decisions(path); expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ fallback: "jev_invalid_output", outcome: "failed" });
    expect(JSON.stringify(lines)).not.toContain("secret upstream error"); h.cleanup();
  }));

  it("does not interrupt generation when decision logging fails", async () => withLog(async (path) => {
    const blocked = join(path, "decisions.jsonl");
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, "not a directory");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })) as typeof fetch;
    const h = await host({ ...base, decisionsLogPath: blocked });
    expect(await (await h.exchange()).response.text()).toBe("{}");
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith('{"event":"decision_log_failed"}')); h.cleanup();
  }));

  it("records a mid-stream cancellation only once as failed", async () => withLog(async (path) => {
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("chunk")); } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const h = await host({ ...base, decisionsLogPath: path });
    const reader = (await h.exchange()).response.body!.getReader();
    await reader.read(); await reader.cancel(); await reader.cancel();
    const lines = await decisions(path); expect(lines).toHaveLength(1); expect(lines[0].outcome).toBe("failed"); h.cleanup();
  }));

  it.each([null, 1, [], "request", { ...body, model: "gpt-5" }, { ...body, truncation: "auto" }])("rejects malformed JSON shapes before Jev: %j", async (data) => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const h = await host(); await expect(h.exchange(data)).rejects.toThrow("invalid_request (400)");
    expect(fetcher).not.toHaveBeenCalled(); h.cleanup();
  });
});
