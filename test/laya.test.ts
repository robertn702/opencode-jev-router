import { describe, expect, it, vi } from "vitest";

import { createLayaClassifier, mapLayaAnswer, type LayaInstance } from "../src/laya.js";
import { findModel } from "../src/models.js";

const model = findModel("gpt-6-astra")!;
const body = { model: model.id, prompt_cache_key: "cache", input: [{ role: "user", content: "keep this local" }] };
const args = (signal = new AbortController().signal) => ({ model, body, signal });
const answer = (value: unknown) => ({ answers: { effort: value } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function instance(systemOne: LayaInstance["systemOne"]): LayaInstance {
  return { systemOne, close: vi.fn(async () => undefined) };
}

describe("Laya effort mapping", () => {
  it("maps choice, score, and noul typed answers to supported efforts", () => {
    expect(mapLayaAnswer({ type: "choice", choice: "xhigh" }, model)).toBe("xhigh");
    expect(mapLayaAnswer({ type: "score", score: 2.6 }, model)).toBe("xhigh");
    expect(mapLayaAnswer({ type: "noul", noul: 0 }, model)).toBe("low");
    expect(mapLayaAnswer({ type: "noul", noul: 1 }, model)).toBe("max");
    expect(mapLayaAnswer({ type: "score", score: Number.NaN }, model)).toBeNull();
    expect(mapLayaAnswer({ type: "choice", choice: "none" }, model)).toBeNull();
  });
});

describe("Laya classifier", () => {
  it("loads once, classifies locally, and supports concurrent requests", async () => {
    const firstRun = deferred<unknown>();
    const secondRun = deferred<unknown>();
    const pending = [firstRun, secondRun];
    const local = instance(vi.fn(() => pending.shift()!.promise));
    const load = vi.fn(async () => local);
    const classifier = createLayaClassifier({ timeoutMs: 1_000, load });

    const first = classifier.select(args());
    const second = classifier.select(args());
    await vi.waitFor(() => expect(local.systemOne).toHaveBeenCalledTimes(2));
    firstRun.resolve(answer({ type: "score", score: 0 }));
    secondRun.resolve(answer({ type: "score", score: 4 }));

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { effort: "low", fallback: null },
      { effort: "max", fallback: null },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(local.systemOne).toHaveBeenCalledWith(expect.objectContaining({ recent_user_text: "keep this local", model: model.id }), expect.objectContaining({ effort: expect.objectContaining({ type: "score" }) }));
  });

  it("falls back when initialization fails without retrying or leaking the error", async () => {
    const load = vi.fn(async () => { throw new Error("private model path"); });
    const classifier = createLayaClassifier({ timeoutMs: 1_000, load, fallbackEffort: "high" });

    await expect(classifier.select(args())).resolves.toMatchObject({ effort: "high", fallback: "jev_error", jevErrorCategory: "unknown" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("times out a hanging local inference and ignores its late result", async () => {
    const run = deferred<unknown>();
    let calls = 0;
    const local = instance(() => calls++ === 0 ? run.promise : new Promise(() => undefined));
    const classifier = createLayaClassifier({ timeoutMs: 20, load: async () => local, fallbackEffort: "medium" });

    await expect(classifier.select(args())).resolves.toMatchObject({ effort: "medium", fallback: "jev_timeout" });
    run.resolve(answer({ type: "score", score: 4 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(classifier.select(args())).resolves.toMatchObject({ effort: "medium", fallback: "jev_timeout" });
  });

  it("cancels without fallback and closes a loaded model", async () => {
    const run = deferred<unknown>();
    const local = instance(() => run.promise);
    const classifier = createLayaClassifier({ timeoutMs: 1_000, load: async () => local });
    const controller = new AbortController();
    const selected = classifier.select(args(controller.signal));
    controller.abort();

    await expect(selected).rejects.toThrow("cancelled");
    await classifier.close();
    expect(local.close).toHaveBeenCalledTimes(1);
  });
});
