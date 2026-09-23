import { describe, expect, it } from "vitest";
import { LineageStore } from "../src/lineage.js";

describe("historical effort replay", () => {
  it("keeps the complete prior input prefix when effort changes after tool output", () => {
    const store = new LineageStore();
    const initial = [{ role: "user", content: "work" }];
    const first = store.prepare(initial, ["session", "auth"], "low");
    first.commit();
    const continued = [...initial, { type: "function_call", call_id: "1" }, { type: "function_call_output", call_id: "1", output: "result" }];
    const next = store.prepare(continued, ["session", "auth"], "high");
    expect(next.input.slice(0, first.input.length)).toEqual(first.input);
    expect(next.previousEffort).toBe("low");
    expect(next.replayed).toBe(1);
    expect(next.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
    next.commit();
    const third = store.prepare([...continued, { role: "assistant", content: "done" }], ["session", "auth"], "high");
    expect(third.input.slice(0, next.input.length)).toEqual(next.input);
    expect(third.input.at(-1)).toEqual({ role: "assistant", content: "done" });
  });

  it("isolates credentials, resets changed history, and preserves branch ancestry", () => {
    const store = new LineageStore();
    const first = store.prepare(["a"], ["s", "key1"], "low"); first.commit();
    store.prepare(["a", "b"], ["s", "key1"], "high").commit();
    expect(store.prepare(["a", "c"], ["s", "key1"], "medium").previousEffort).toBe("low");
    expect(store.prepare(["a", "b"], ["s", "key2"], "medium").status).toBe("new");
    expect(store.prepare(["edited"], ["s", "key1"], "medium").status).toBe("reset");
    expect(store.prepare(["a"], null, "medium").previousEffort).toBeNull();
  });
});
