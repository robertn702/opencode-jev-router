import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("resource limit configuration", () => {
  it("uses bounded defaults and accepts positive overrides", () => {
    const defaults = loadConfig({});
    expect(defaults.maxRequestBytes).toBe(1_048_576);
    expect(defaults.maxInFlight).toBe(32);
    expect(defaults.upstreamHeaderTimeoutMs).toBe(10_000);
    expect(defaults.upstreamIdleTimeoutMs).toBe(60_000);
    expect(defaults.effortCacheEntries).toBe(256);
    expect(defaults.effortCacheTtlMs).toBe(600_000);
    expect(loadConfig({ MAX_IN_FLIGHT: "1" }).maxInFlight).toBe(1);
  });

  it("rejects invalid values instead of silently accepting partial integers", () => {
    for (const name of ["MAX_REQUEST_BYTES", "MAX_IN_FLIGHT", "UPSTREAM_HEADER_TIMEOUT_MS",
      "UPSTREAM_IDLE_TIMEOUT_MS", "EFFORT_CACHE_ENTRIES", "EFFORT_CACHE_TTL_MS"]) {
      for (const value of ["0", "-1", "1.5", "10junk", "Infinity"]) {
        expect(() => loadConfig({ [name]: value })).toThrow(name);
      }
    }
  });
});
