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
    expect(defaults.shutdownGraceMs).toBe(30_000);
    expect(loadConfig({ SHUTDOWN_GRACE_MS: "50" }).shutdownGraceMs).toBe(50);
    expect(loadConfig({ MAX_IN_FLIGHT: "1" }).maxInFlight).toBe(1);
  });

  it("rejects invalid values instead of silently accepting partial integers", () => {
    for (const name of ["MAX_REQUEST_BYTES", "MAX_IN_FLIGHT", "UPSTREAM_HEADER_TIMEOUT_MS",
      "UPSTREAM_IDLE_TIMEOUT_MS", "EFFORT_CACHE_ENTRIES", "EFFORT_CACHE_TTL_MS", "SHUTDOWN_GRACE_MS"]) {
      for (const value of ["0", "-1", "1.5", "10junk", "Infinity"]) {
        expect(() => loadConfig({ [name]: value })).toThrow(name);
      }
    }
  });
  it("validates upstream configuration without exposing credentials", () => {
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "bad-secret" })).toThrow("UPSTREAM_BASE_URL");
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "http://user:secret@localhost:8317/v1" })).toThrow("UPSTREAM_BASE_URL");
  });
});

describe("upstream configuration", () => {
  it("keeps CLIProxyAPI defaults even when an OpenAI key is present", () => {
    const config = loadConfig({ OPENAI_API_KEY: "unused" });
    expect(config.upstreamAuth).toEqual({ mode: "cliproxyapi" });
    expect(config.upstreamBaseUrl).toBe("http://127.0.0.1:8317/v1");
  });

  it("uses the official OpenAI URL only when explicitly selected", () => {
    const config = loadConfig({ UPSTREAM_MODE: "openai", OPENAI_API_KEY: "test-key" });
    expect(config.upstreamAuth).toEqual({ mode: "openai", apiKey: "test-key" });
    expect(config.upstreamBaseUrl).toBe("https://api.openai.com/v1");
  });

  it("rejects invalid modes, missing credentials, and credential misrouting", () => {
    expect(() => loadConfig({ UPSTREAM_MODE: "other", OPENAI_API_KEY: "test-key" }))
      .toThrow("UPSTREAM_MODE must be openai or cliproxyapi");
    expect(() => loadConfig({ UPSTREAM_MODE: "cliproxy" }))
      .toThrow("UPSTREAM_MODE must be openai or cliproxyapi");
    expect(() => loadConfig({ UPSTREAM_MODE: "openai" }))
      .toThrow("OPENAI_API_KEY is required when UPSTREAM_MODE=openai");
    expect(() => loadConfig({ UPSTREAM_MODE: "openai", OPENAI_API_KEY: "  " }))
      .toThrow("OPENAI_API_KEY is required when UPSTREAM_MODE=openai");
    expect(() => loadConfig({ UPSTREAM_MODE: "openai", OPENAI_API_KEY: "test-key", UPSTREAM_BASE_URL: "http://localhost:8317/v1" }))
      .toThrow("UPSTREAM_MODE=openai requires UPSTREAM_BASE_URL=https://api.openai.com/v1");
    expect(() => loadConfig({ UPSTREAM_MODE: "cliproxyapi", UPSTREAM_BASE_URL: "https://api.openai.com/v1" }))
      .toThrow("UPSTREAM_MODE=cliproxyapi cannot use api.openai.com");
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "https://user:pass@proxy.example/v1" }))
      .toThrow("UPSTREAM_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment");
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "no-url" }))
      .toThrow("UPSTREAM_BASE_URL must be a valid HTTP(S) URL");
  });
});
