import { describe, it, expect } from "vitest";
import { createJevClassifier } from "../src/jev.js";
import { classificationPolicy } from "../src/classification-policy.js";
import { MODELS } from "../src/models.js";
import { ResponsesRouter } from "../src/router.js";

const options = { apiKey: "test", baseURL: "https://api.typesafe.ai", model: "jev-latest", timeoutMs: 5000 };
const args = () => ({ model: MODELS[0]!, body: { model: MODELS[0]!.id, input: [{ role: "user", content: "test" }] }, signal: new AbortController().signal });
const ok = () => new Response(JSON.stringify({ model: "jev-latest", answers: { effort: { type: "choice", choice: "low", confidence: 1, probabilities: {} } }, usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });

describe("classification policy", () => {
  it("defaults to one retry and fixed high; rejects invalid configuration", () => {
    expect(classificationPolicy({})).toEqual({ maxRetries: 1, fallbackMode: "fixed", fallbackEffort: "high" });
    for (const maxRetries of [-1, 1.5, NaN, 11]) expect(() => classificationPolicy({ maxRetries })).toThrow();
    expect(() => classificationPolicy({ fallbackMode: "bad" as any })).toThrow();
    expect(() => classificationPolicy({ fallbackEffort: "none" as any })).toThrow();
  });
  it("recovers on the fourth attempt with three retries", async () => {
    let n = 0;
    const classifier = createJevClassifier({ ...options, maxRetries: 3, fallbackMode: "error", fetch: async () => ++n < 4 ? new Response("secret", { status: 503 }) : ok() });
    expect(await classifier.select(args())).toMatchObject({ effort: "low", fallback: null });
    expect(n).toBe(4);
  });
  it("does not retry auth errors and defaults to high despite a previous low", async () => {
    let n = 0;
    const classifier = createJevClassifier({ ...options, fetch: async () => ++n === 1 ? ok() : new Response("secret", { status: 401 }) });
    const request = args(); request.body = { ...request.body, prompt_cache_key: "same" } as any;
    await classifier.select(request);
    expect(await classifier.select(request)).toMatchObject({ effort: "high", fallback: "jev_error" });
    expect(n).toBe(2);
  });
  it("fails closed after exhaustion and never prepares generation", async () => {
    let n = 0;
    const classifier = createJevClassifier({ ...options, maxRetries: 1, fallbackMode: "error", fetch: async () => { n++; return new Response("secret", { status: 503 }); } });
    const router = new ResponsesRouter({ selectEffort: classifier.select });
    const request = args();
    await expect(router.prepare(request.body, { signal: request.signal, scope: null })).rejects.toThrow("jev_classification_failed");
    expect(n).toBe(2);
  });
  it("total deadline bounds retry-after and cancellation prevents another attempt", async () => {
    for (const cancel of [false, true]) {
      let n = 0;
      const controller = new AbortController();
      const classifier = createJevClassifier({ ...options, timeoutMs: 50, maxRetries: 3, fallbackMode: "error", fetch: async () => { n++; return new Response("secret", { status: 429, headers: { "retry-after": "60" } }); } });
      const pending = classifier.select({ ...args(), signal: controller.signal });
      if (cancel) setTimeout(() => controller.abort(), 10);
      await expect(pending).rejects.toThrow(cancel ? "cancelled" : "jev_classification_failed");
      expect(n).toBe(1);
    }
  });
});
