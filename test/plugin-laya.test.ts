import { afterEach, describe, expect, it, vi } from "vitest";

const laya = vi.hoisted(() => {
  const close = vi.fn(async () => undefined);
  const systemOne = vi.fn(async () => ({ answers: { effort: { type: "score", score: 0 } } }));
  const load = vi.fn(async () => ({ systemOne, close }));
  return { close, systemOne, load };
});
vi.mock("@receptron/laya", () => ({ Laya: { load: laya.load } }));

import { createPluginRuntime } from "../src/plugin-runtime.js";

const originalKey = process.env.JEV_API_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = originalKey;
});

describe("plugin classifier backend selection", () => {
  it("allows explicit local Laya mode without a hosted classifier key", () => {
    delete process.env.JEV_API_KEY;
    const runtime = createPluginRuntime({ classifierBackend: "laya" });
    runtime.dispose();
  });

  it("rejects unknown classifier backends", () => {
    expect(() => createPluginRuntime({ classifierBackend: "local" as "laya" })).toThrow("classifierBackend");
  });

  it("routes one request through Laya without a hosted classifier request and closes the model", async () => {
    delete process.env.JEV_API_KEY;
    const runtime = createPluginRuntime({ classifierBackend: "laya", jevTimeoutMs: 1_000 });
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer upstream-only" },
      body: JSON.stringify({ model: "gpt-6-astra", input: [{ role: "user", content: "private prompt" }] }),
    });

    const exchange = await runtime.start(request, { session: null, turnId: null }, "openai");
    expect(laya.load).toHaveBeenCalledOnce();
    expect(laya.systemOne).toHaveBeenCalledWith(expect.objectContaining({ recent_user_text: "private prompt" }), expect.anything());
    expect(JSON.parse(exchange.body).input).toContainEqual(expect.objectContaining({ reasoning: { effort: "low" } }));
    runtime.dispose();
    await vi.waitFor(() => expect(laya.close).toHaveBeenCalledOnce());
  });
});
