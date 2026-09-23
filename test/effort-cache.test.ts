import { describe, expect, it, vi } from "vitest";
import { EffortCache } from "../src/effort-cache.js";

describe("previous-effort cache", () => {
  it("evicts the least recently used entry and expires entries without a scan", () => {
    vi.useFakeTimers();
    try {
      const cache = new EffortCache(2, 100);
      cache.set("a", "high");
      cache.set("b", "low");
      expect(cache.get("a")).toBe("high");
      cache.set("c", "max");
      expect(cache.get("b")).toBeUndefined();
      vi.advanceTimersByTime(100);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("c")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
