import { describe, expect, it, vi } from "vitest";
import { LineageStore } from "../src/lineage.js";

const user = (content: string) => ({ role: "user", content });

describe("historical effort replay", () => {
  it("reconstructs a missing update at its original new-user boundary", () => {
    const store = new LineageStore();
    const first = store.prepare([user("one")], ["model", "cache", "auth"], "low");
    expect(first.input).toEqual([{ type: "configuration_update", reasoning: { effort: "low" } }, user("one")]);
    first.commit();
    const next = store.prepare([user("one"), { role: "assistant", content: "done" }, user("two")], ["model", "cache", "auth"], "high");
    expect(next.input).toEqual([
      { type: "configuration_update", reasoning: { effort: "low" } }, user("one"), { role: "assistant", content: "done" },
      { type: "configuration_update", reasoning: { effort: "high" } }, user("two"),
    ]);
    expect(next).toMatchObject({ previousEffort: "low", status: "preserved", replayed: 1 });
  });

  it("uses a tail update for tool continuation and replaces a retry boundary", () => {
    const store = new LineageStore();
    const input = [user("call"), { type: "function_call", call_id: "c" }, { type: "function_call_output", call_id: "c", output: "ok" }];
    const first = store.prepare(input, ["model", "cache", "auth"], "low");
    expect(first.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "low" } });
    first.commit();
    const retry = store.prepare(input, ["model", "cache", "auth"], "high");
    expect(retry.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
    expect(retry.input.filter((item) => (item as { type?: string }).type === "configuration_update")).toHaveLength(1);
  });

  it("keeps opaque items in place across replay and does not treat their role as a new user turn", () => {
    const store = new LineageStore();
    const firstInput = [user("call"), { type: "function_call", call_id: "c" }, { type: "function_call_output", call_id: "c", output: "ok" }];
    store.prepare(firstInput, ["model", "cache", "auth"], "low").commit();
    const opaque = { type: "future_tool_result", role: "user", content: "not a user message", data: { nested: ["unchanged"] } };
    const next = store.prepare([...firstInput, opaque], ["model", "cache", "auth"], "high");
    expect(next).toMatchObject({ status: "preserved", replayed: 1 });
    expect(next.input).toEqual([
      user("call"), { type: "function_call", call_id: "c" }, { type: "function_call_output", call_id: "c", output: "ok" },
      { type: "configuration_update", reasoning: { effort: "low" } }, opaque,
      { type: "configuration_update", reasoning: { effort: "high" } },
    ]);
  });

  it("places a later new user ahead of an earlier tool output", () => {
    const store = new LineageStore();
    const input = [user("call"), { type: "function_call_output", call_id: "c", output: "ok" }, user("next")];
    const prepared = store.prepare(input, ["model", "cache", "auth"], "high");
    expect(prepared.input).toEqual([
      user("call"), { type: "function_call_output", call_id: "c", output: "ok" },
      { type: "configuration_update", reasoning: { effort: "high" } }, user("next"),
    ]);
  });

  it("resets changed caller updates and refuses an adjacent conflicting selection", () => {
    const store = new LineageStore();
    const first = store.prepare([user("one")], ["model", "cache", "auth"], "low"); first.commit();
    const edited = store.prepare([{ type: "configuration_update", reasoning: { effort: "high" } }, user("one")], ["model", "cache", "auth"], "medium");
    expect(edited).toMatchObject({ status: "reset_edited", unsafe: true });
    expect(edited.input.filter((item) => (item as { type?: string }).type === "configuration_update")).toHaveLength(1);
  });

  it("treats a changed full caller update fingerprint as edited history", () => {
    const store = new LineageStore();
    const callerUpdate = { type: "configuration_update", reasoning: { effort: "low" } };
    const first = store.prepare([callerUpdate, user("one")], ["model", "cache", "auth"], "low"); first.commit();
    const changed = { type: "configuration_update", reasoning: { effort: "low", summary: "auto" } };
    expect(store.prepare([changed, user("one")], ["model", "cache", "auth"], "low").status).toBe("reset_edited");
  });

  it("accepts a new explicit update beyond a preserved prefix", () => {
    const store = new LineageStore();
    const first = store.prepare([user("one")], ["model", "cache", "auth"], "low"); first.commit();
    const high = { type: "configuration_update", reasoning: { effort: "high" } };
    const next = store.prepare([user("one"), { role: "assistant", content: "done" }, high, user("two")], ["model", "cache", "auth"], "high");
    expect(next).toMatchObject({ status: "preserved", replayed: 1, previousEffort: "low", unsafe: false });
    expect(next.input).toEqual([
      { type: "configuration_update", reasoning: { effort: "low" } }, user("one"), { role: "assistant", content: "done" }, high, user("two"),
    ]);
  });

  it("resets a caller update that edits a historical tool-tail boundary", () => {
    const store = new LineageStore();
    const toolHistory = [user("call"), { type: "function_call", call_id: "c" }, { type: "function_call_output", call_id: "c", output: "ok" }];
    const first = store.prepare(toolHistory, ["model", "cache", "auth"], "low"); first.commit();
    const high = { type: "configuration_update", reasoning: { effort: "high" } };
    const next = store.prepare([...toolHistory, high, user("next")], ["model", "cache", "auth"], "high");
    expect(next).toMatchObject({ status: "reset_edited", replayed: 0, previousEffort: "high", unsafe: false });
    expect(next.input).toEqual([...toolHistory, high, user("next")]);
  });

  it("marks conflicting concurrent commits ambiguous rather than replaying either branch", () => {
    const store = new LineageStore();
    const low = store.prepare([user("one")], ["model", "cache", "auth"], "low");
    const high = store.prepare([user("one")], ["model", "cache", "auth"], "high");
    low.commit();
    high.commit();
    const continued = store.prepare([user("one"), { role: "assistant", content: "done" }, user("two")], ["model", "cache", "auth"], "medium");
    expect(continued).toMatchObject({ status: "reset_ambiguous", replayed: 0, previousEffort: null });
  });

  it("quarantines descendants permanently after concurrent effort disagreement", () => {
    const store = new LineageStore();
    const base = [user("one")];
    const low = store.prepare(base, ["model", "cache", "auth"], "low");
    const high = store.prepare(base, ["model", "cache", "auth"], "high");
    expect(high).toMatchObject({ unsafe: false, status: "reset_ambiguous", replayed: 0, previousEffort: null });
    low.commit();
    const descendant = store.prepare([...base, { role: "assistant", content: "done" }, user("two")], ["model", "cache", "auth"], "medium");
    expect(descendant).toMatchObject({ status: "reset_ambiguous", replayed: 0 });
    descendant.commit();
    expect(store.prepare(base, ["model", "cache", "auth"], "low").status).toBe("reset_ambiguous");
  });

  it("allows same-effort concurrent retries without quarantining the scope", () => {
    const store = new LineageStore();
    const input = [user("one")];
    const first = store.prepare(input, ["model", "cache", "auth"], "low");
    const second = store.prepare(input, ["model", "cache", "auth"], "low");
    expect(second.unsafe).toBe(false);
    first.commit();
    second.commit();
    expect(store.prepare([...input, { role: "assistant", content: "done" }, user("two")], ["model", "cache", "auth"], "low").status).toBe("preserved");
  });

  it("keeps same-effort exact retries at their original user boundary", () => {
    const store = new LineageStore();
    const input = [user("one"), { role: "assistant", content: "done" }, user("two")];
    const first = store.prepare(input, ["model", "cache", "auth"], "low"); first.commit();
    const retry = store.prepare(input, ["model", "cache", "auth"], "low");
    expect(retry.input.at(-1)).toEqual(user("two"));
    expect(retry.input.at(-2)).toEqual({ type: "configuration_update", reasoning: { effort: "low" } });
  });

  it("handles near-limit histories with a linear reconstruction pass", () => {
    const store = new LineageStore();
    const input: unknown[] = Array.from({ length: 19_999 }, (_, index) => ({ type: "function_call_output", call_id: String(index), output: "x" }));
    input.push(user("last"));
    const prepared = store.prepare(input, ["model", "cache", "auth"], "high");
    expect(prepared.input).toHaveLength(20_001);
    expect(prepared.input.at(-2)).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
  });

  it("resets edited, expired, and differently scoped histories", () => {
    vi.useFakeTimers();
    try {
      const store = new LineageStore(1, 10);
      const first = store.prepare([user("one")], ["model", "cache", "auth-a"], "low"); first.commit();
      expect(store.prepare([user("edited")], ["model", "cache", "auth-a"], "high").status).toBe("reset_edited");
      expect(store.prepare([user("one")], ["model", "cache", "auth-b"], "high").status).toBe("new");
      vi.advanceTimersByTime(10);
      expect(store.prepare([user("one")], ["model", "cache", "auth-a"], "high").status).toBe("reset_expired");
    } finally { vi.useRealTimers(); }
  });

  it("marks bounded-store eviction without retaining request content", () => {
    const store = new LineageStore(1);
    const first = store.prepare([user("one")], ["model", "cache-a", "auth"], "low"); first.commit();
    const second = store.prepare([user("two")], ["model", "cache-b", "auth"], "low"); second.commit();
    expect(store.prepare([user("one")], ["model", "cache-a", "auth"], "high").status).toBe("reset_evicted");
  });
});
