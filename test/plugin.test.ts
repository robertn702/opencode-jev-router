import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/plugin.js";

const originalFetch = globalThis.fetch;
const request = {
  model: "gpt-6-astra",
  prompt_cache_key: "cache",
  input: [{ type: "message", role: "user", content: "hello" }],
};
const upstreamOptions = { upstreamBaseURL: "http://127.0.0.1:8317/v1", upstreamApiKey: "upstream" };

afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("jev-router plugin", () => {
  it("rewrites Responses requests, consumes internal headers, and commits only after downstream reads", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const sent = new Request(input, _init);
      expect(sent.headers.get("x-jev-session-id")).toBeNull();
      const body = await sent.json() as Record<string, unknown>;
      expect(body.model).toBe("gpt-6-astra");
      expect(body.reasoning).toEqual({ effort: "medium" });
      expect(body.input).toEqual([
        { type: "configuration_update", reasoning: { effort: "high" } },
        request.input[0],
      ]);
      return new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 2, output_tokens: 1 } }), { headers: { "content-type": "application/json", "x-leak": "no" } });
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.typesafe.ai")) return new Response(JSON.stringify({ answers: { effort: { choice: "high" } } }));
      return upstream(input, init);
    }) as typeof fetch;
    const hooks = await plugin({}, { jevApiKey: "jev", ...upstreamOptions });
    const config: any = {};
    hooks.config(config);
    const response = await config.provider["jev-router"].options.fetch("https://upstream.test/v1/responses", {
      method: "POST", headers: { authorization: "Bearer tenant", "x-jev-session-id": "ses_test" }, body: JSON.stringify(request),
    });
    expect(response.headers.get("x-leak")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ status: "completed" });
    hooks.dispose();
  });

  it("registers the shared model catalog with plugin upstream defaults", async () => {
    const hooks = await plugin({}, { jevApiKey: "jev", upstreamBaseURL: "http://127.0.0.1:8317/v1", upstreamApiKey: "upstream" });
    const config: any = {};
    hooks.config(config);
    const provider = config.provider["jev-router"];
    expect(provider).toMatchObject({ npm: "@ai-sdk/openai", name: "Jev Router", options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "upstream" } });
    expect(Object.keys(provider.models)).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"]);
    expect(provider.models["gpt-6-astra"]).toMatchObject({ name: "GPT-6 Astra", reasoning: true, options: { useResponses: true } });
    expect(provider.models["gpt-6-luna"]).toMatchObject({ name: "GPT-6 Luna", reasoning: true, options: { useResponses: true } });
    expect(provider.models["gpt-6-sol"]).toMatchObject({ name: "GPT-6 Sol", reasoning: true, options: { useResponses: true } });
    hooks.dispose();
  });

  it("keeps explicit upstream and model metadata overrides while enforcing the Responses interceptor", async () => {
    const hooks = await plugin({}, { jevApiKey: "jev", upstreamBaseURL: "http://127.0.0.1:8317/v1", upstreamApiKey: "default" });
    const config: any = { provider: { "jev-router": { options: { baseURL: "http://127.0.0.1:8318/v1", apiKey: "custom" }, models: { "gpt-6-astra": { name: "Custom Astra", reasoning: false, options: {} }, "astra-alias": { provider: { npm: "@ai-sdk/openai" }, options: {} } } } } };
    hooks.config(config);
    expect(config.provider["jev-router"].options).toMatchObject({ baseURL: "http://127.0.0.1:8318/v1", apiKey: "custom" });
    expect(config.provider["jev-router"].models["gpt-6-astra"]).toMatchObject({ name: "Custom Astra", reasoning: false, options: { useResponses: true } });
    expect(config.provider["jev-router"].models["astra-alias"]).toMatchObject({ provider: { npm: "@ai-sdk/openai", options: { useResponses: true } }, options: { useResponses: true } });
    hooks.dispose();
  });

  it("allows OpenCode to resolve an omitted upstream key but rejects invalid explicit keys", async () => {
    const hooks = await plugin({}, { jevApiKey: "jev", upstreamBaseURL: "http://127.0.0.1:8317/v1" });
    const config: any = {};
    hooks.config(config);
    expect(config.provider["jev-router"].options.apiKey).toBeUndefined();
    hooks.dispose();
    const invalid = await plugin({}, { jevApiKey: "jev", upstreamBaseURL: "http://127.0.0.1:8317/v1", upstreamApiKey: " " });
    expect(() => invalid.config({})).toThrow("upstreamApiKey");
    invalid.dispose();
  });

  it.each([
    { provider: { "jev-router": { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "key" } } } },
    { provider: { "jev-router": { options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "key", fetch: () => new Response() } } } },
    { provider: { "jev-router": { options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "key" }, models: { "astra-alias": { options: { useResponses: false } } } } } },
    { provider: { "jev-router": { options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "key" }, models: { "astra-alias": { provider: { npm: "@ai-sdk/openai-compatible" } } } } } },
    { provider: { "jev-router": { options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "key" }, models: { "astra-alias": { provider: { options: { useResponses: false } } } } } } },
    { provider: { "jev-router": { options: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "key" }, models: { "astra-alias": { provider: { options: { fetch: () => new Response() } } } } } } },
  ])("rejects SDK, Responses, and fetch bypass overrides", async (config: any) => {
    const hooks = await plugin({}, { jevApiKey: "jev", ...upstreamOptions });
    expect(() => hooks.config(config)).toThrow();
    hooks.dispose();
  });

  it("does not generate upstream work when classification is aborted", async () => {
    const upstream = vi.fn();
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.typesafe.ai")) return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return upstream(input, init);
    }) as typeof fetch;
    const hooks = await plugin({}, { jevApiKey: "jev", ...upstreamOptions });
    const config: any = {}; hooks.config(config);
    const abort = new AbortController();
    const call = config.provider["jev-router"].options.fetch("https://upstream.test/v1/responses", { method: "POST", signal: abort.signal, body: JSON.stringify(request) });
    abort.abort();
    expect((await call).status).toBe(499);
    expect(upstream).not.toHaveBeenCalled();
    hooks.dispose();
  });

  it.each([null, 1, [], "request"])("rejects invalid JSON shapes locally before Jev", async (body) => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const hooks = await plugin({}, { jevApiKey: "jev", ...upstreamOptions }); const config: any = {}; hooks.config(config);
    const response = await config.provider["jev-router"].options.fetch("https://upstream.test/v1/responses", { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(400); expect(fetcher).not.toHaveBeenCalled(); hooks.dispose();
  });

  it("rejects non-Responses endpoints rather than bypassing the dedicated provider", async () => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const hooks = await plugin({}, { jevApiKey: "jev", ...upstreamOptions }); const config: any = {}; hooks.config(config);
    expect((await config.provider["jev-router"].options.fetch("https://upstream.test/v1/chat/completions", { method: "POST" })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled(); hooks.dispose();
  });

  it("discards a failed attempt so a different-effort retry is routable", async () => {
    let effort = "high"; let attempts = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.typesafe.ai")) return new Response(JSON.stringify({ answers: { effort: { choice: effort } } }));
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return new Response(JSON.stringify({ status: "completed" }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const hooks = await plugin({}, { jevApiKey: "jev", ...upstreamOptions }); const config: any = {}; hooks.config(config);
    const init = { method: "POST", headers: { "x-jev-session-id": "ses_retry" }, body: JSON.stringify(request) };
    expect((await config.provider["jev-router"].options.fetch("https://upstream.test/v1/responses", init)).status).toBe(502);
    effort = "low";
    const retry = await config.provider["jev-router"].options.fetch("https://upstream.test/v1/responses", init);
    expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ status: "completed" }); hooks.dispose();
  });

  it("preserves streaming bytes incrementally and aborts/releases on consumer cancellation", async () => {
    let upstreamCancelled = false; let push!: (value: Uint8Array) => void;
    const upstreamBody = new ReadableStream<Uint8Array>({ start(controller) { push = (value) => controller.enqueue(value); }, cancel() { upstreamCancelled = true; } });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes("api.typesafe.ai")
      ? new Response(JSON.stringify({ answers: { effort: { choice: "high" } } }))
      : new Response(upstreamBody, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const hooks = await plugin({}, { jevApiKey: "jev", ...upstreamOptions }); const config: any = {}; hooks.config(config);
    const response = await config.provider["jev-router"].options.fetch("https://upstream.test/v1/responses", { method: "POST", body: JSON.stringify(request) });
    const reader = response.body!.getReader(); push(new TextEncoder().encode("data: {\"type\":\"response.completed\"}\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.completed");
    await reader.cancel(); expect(upstreamCancelled).toBe(true); hooks.dispose();
  });

  it("aborts an unconsumed upstream stream on disposal", async () => {
    let aborted = false;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.typesafe.ai")) return Promise.resolve(new Response(JSON.stringify({ answers: { effort: { choice: "high" } } })));
      init!.signal!.addEventListener("abort", () => { aborted = true; });
      return Promise.resolve(new Response(new ReadableStream()));
    }) as typeof fetch;
    const hooks = await plugin({}, { jevApiKey: "jev", ...upstreamOptions }); const config: any = {}; hooks.config(config);
    await config.provider["jev-router"].options.fetch("https://upstream.test/v1/responses", { method: "POST", body: JSON.stringify(request) });
    hooks.dispose(); expect(aborted).toBe(true);
  });

  it("enforces declared body limits without reading or classifying", async () => {
    const fetcher = vi.fn(); globalThis.fetch = fetcher as typeof fetch;
    const hooks = await plugin({}, { jevApiKey: "jev", maxRequestBytes: 2, ...upstreamOptions }); const config: any = {}; hooks.config(config);
    const response = await config.provider["jev-router"].options.fetch("https://upstream.test/v1/responses", { method: "POST", headers: { "content-length": "999" }, body: "{}" });
    expect(response.status).toBe(413); expect(fetcher).not.toHaveBeenCalled(); hooks.dispose();
  });

  it("times out before upstream headers while preserving configured provider headers", async () => {
    let received: Headers | undefined;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.typesafe.ai")) return Promise.resolve(new Response(JSON.stringify({ answers: { effort: { choice: "high" } } })));
      received = new Headers(init!.headers); return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }) as typeof fetch;
    const hooks = await plugin({}, { jevApiKey: "jev", upstreamHeaderTimeoutMs: 1, ...upstreamOptions }); const config: any = {}; hooks.config(config);
    const response = await config.provider["jev-router"].options.fetch("https://upstream.test/v1/responses", { method: "POST", headers: { authorization: "Bearer a", "openai-project": "project", "openai-organization": "org", "x-jev-session-id": "ses_secret", "x-opencode-session-id": "private", connection: "x-hop", "x-hop": "no", "transfer-encoding": "chunked", "x-random": "kept" }, body: JSON.stringify(request) });
    expect(response.status).toBe(504); expect(received!.get("authorization")).toBe("Bearer a"); expect(received!.get("openai-project")).toBe("project"); expect(received!.get("openai-organization")).toBe("org"); expect(received!.get("x-random")).toBe("kept"); expect(received!.get("x-jev-session-id")).toBeNull(); expect(received!.get("x-opencode-session-id")).toBeNull(); expect(received!.get("connection")).toBeNull(); expect(received!.get("x-hop")).toBeNull(); expect(received!.get("transfer-encoding")).toBeNull(); hooks.dispose();
  });

  it("adds provider-gated session and turn correlation headers", async () => {
    const hooks = await plugin({}, { jevApiKey: "jev", ...upstreamOptions });
    const output = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]({ sessionID: "ses_chat", model: { providerID: "jev-router" }, provider: {} }, output);
    expect(output.headers["x-jev-session-id"]).toBe("ses_chat"); expect(output.headers["x-jev-turn-id"]).toMatch(/^[0-9a-f-]{36}$/);
    hooks.dispose();
  });
});
