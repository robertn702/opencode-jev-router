import { describe, expect, it, vi } from "vitest";

import { createClassifierBackend } from "../src/classifier-backend.js";
import type { LayaInstance } from "../src/laya.js";

const common = { timeoutMs: 1_000, maxRetries: 0, fallbackMode: "fixed" as const, fallbackEffort: "high" as const };

describe("classifier backend selection", () => {
  it("keeps hosted Jev as the default backend implementation", () => {
    const hosted = { select: vi.fn(), client: {} };
    const createJev = vi.fn(() => hosted as never);
    const backend = createClassifierBackend({
      ...common,
      backend: "jev",
      jev: { apiKey: "key", baseURL: "https://api.typesafe.ai", model: "jev-latest" },
      createJev,
    });

    expect(createJev).toHaveBeenCalledOnce();
    expect(backend.select).toBe(hosted.select);
  });

  it("does not construct or transmit to TypeSafe/Jev in local mode", async () => {
    const createJev = vi.fn(() => { throw new Error("hosted backend must stay unused"); });
    const local: LayaInstance = {
      systemOne: vi.fn(async () => ({ answers: { effort: { type: "score", score: 0 } } })),
      close: vi.fn(async () => undefined),
    };
    const backend = createClassifierBackend({ ...common, backend: "laya", load: async () => local, createJev });

    expect(createJev).not.toHaveBeenCalled();
    await backend.close();
    expect(local.close).not.toHaveBeenCalled();
  });
});
