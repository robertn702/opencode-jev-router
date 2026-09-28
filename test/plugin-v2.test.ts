import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ["claude", { provider: { id: "claude", package: ANTHROPIC, integrationID: "claude", settings: { baseURL: "https://claude.test/v1" } }, models: new Map([["claude-opus-5-5", { id: "claude-opus-5-5", modelID: "claude-opus-5-5", limit: { context: 456 } }]]) }],
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
  const reload = () => {
    aliases.clear();
    providerTransform({ add(registration: any) { registrations.push(registration); for (const model of registration.models) aliases.set(model.id, { ...model }); } } as ProviderEditor);
    modelTransform({
      get(providerID: string, modelID: string) { return (source.get(providerID)?.models.get(modelID) ?? aliases.get(modelID)) as never; },
      provider: { get(providerID: string) { return source.get(providerID) as never; } },
      update(_providerID: string, modelID: string, update: (model: any) => void) { update(aliases.get(modelID)); },
      remove(_providerID: string, modelID: string) { aliases.delete(modelID); },
    } as unknown as ModelEditor);
  };
  reload();
  const exchange = async (data: unknown = body, init: { model?: string; kind?: string; url?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const model = init.model ?? "gpt-6-astra";
    const event = { model: { providerID: "jev-router", id: model }, sessionID: "ses_test", kind: init.kind ?? "primary", request: new Request(init.url ?? "https://a.test/v1/responses", { method: "POST", headers: { authorization: "Bearer config-key", "content-type": "application/json", ...init.headers }, body: JSON.stringify(data), signal: init.signal }) } as SessionHttpRequest;
    await hooks.get("http.request")!(event);
    const response = { ...event, response: await fetch(event.request) } as SessionHttpResponse;
    await hooks.get("http.response")!(response);
    return { request: event.request, response: response.response };
  };
  return { registrations, aliases, hooks, cleanup, reload, exchange };
}

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
    expect((h.registrations[0] as any).models).toHaveLength(7);
    expect([...h.aliases.keys()].sort()).toEqual(["claude-opus-5-5", "gpt-6-astra"]);
    expect(h.aliases.get("gpt-6-astra")).toMatchObject({ name: "GPT-6 Astra", modelID: "gpt-6-astra", limit: { context: 123 }, cost: [1], variants: [], settings: { baseURL: "https://a.test/v1", apiKey: "config-key", extra: 1 }, headers: { "x-source": "provider", "x-model": "yes" }, body: { top: true, model: true } });
    expect(h.aliases.get("gpt-6-astra")?.settings).not.toHaveProperty("transport");
    h.reload(); expect([...h.aliases.keys()].sort()).toEqual(["claude-opus-5-5", "gpt-6-astra"]); h.cleanup();
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

  it("injects stored keys, rejects OAuth and missing keys, and leaves auxiliary calls unchanged", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
    const h = await host(base, sources(), { gw: { type: "key", key: "stored" }, claude: { type: "key", key: "claude-key" } });
    const title = await h.exchange(body, { kind: "title", headers: { authorization: "" } });
    expect(title.request.headers.get("authorization")).toBe("Bearer stored");
    expect(await title.request.clone().json()).toEqual(body);
    const compact = await h.exchange(body, { url: "https://a.test/v1/responses/compact", headers: { authorization: "" } });
    expect(await compact.request.clone().json()).toEqual(body);
    const claude = await h.exchange({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { model: "claude-opus-5-5", url: "https://claude.test/v1/messages", headers: { authorization: "", "x-api-key": "" } });
    expect(claude.request.headers.get("x-api-key")).toBe("claude-key");
    expect(claude.request.redirect).toBe("manual"); h.cleanup();
    const oauth = await host(base, sources(), { gw: { type: "oauth", access: "token" } });
    await expect(oauth.exchange()).rejects.toThrow("uses OAuth"); oauth.cleanup();
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

  it("filters private headers, streams incrementally, and cancels the upstream on consumer cancellation", async () => {
    let push!: (chunk: Uint8Array) => void;
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { push = (chunk) => controller.enqueue(chunk); }, cancel() { cancelled = true; } });
    let received: Request | undefined;
    globalThis.fetch = vi.fn(async (request: Request) => { received = request; return new Response(upstream, { headers: { "content-type": "text/event-stream", "x-private": "no" } }); }) as typeof fetch;
    const h = await host();
    const result = await h.exchange(body, { headers: { "x-jev-session-id": "ses_secret", "x-opencode-session-id": "private", "openai-project": "p" } });
    expect(received!.headers.get("x-jev-session-id")).toBeNull();
    expect(received!.headers.get("x-opencode-session-id")).toBeNull();
    expect(received!.headers.get("openai-project")).toBe("p");
    expect(result.response.headers.get("x-private")).toBeNull();
    const bytes = new TextEncoder().encode("data: chunk\n\n");
    push(bytes);
    const reader = result.response.body!.getReader();
    expect((await reader.read()).value).toEqual(bytes);
    await reader.cancel(); expect(cancelled).toBe(true); h.cleanup();
  });
});
