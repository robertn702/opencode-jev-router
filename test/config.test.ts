import { describe, expect, it } from "vitest";
import { loadConfig, loadJevConnection, upstreamHostname } from "../src/config.js";

describe("Jev connection", () => {
  it("uses the direct endpoint and Jev model by default", () => {
    expect(loadJevConnection({ JEV_API_KEY: " direct-key " })).toEqual({
      apiKey: "direct-key", baseURL: "https://api.typesafe.ai", model: "jev-latest",
    });
  });

  it("selects the Vercel Jev model for its TypeSafe-compatible endpoint", () => {
    expect(loadJevConnection({ JEV_API_KEY: "gateway-key", JEV_BASE_URL: "https://ai-gateway.vercel.sh/typesafe/" })).toEqual({
      apiKey: "gateway-key", baseURL: "https://ai-gateway.vercel.sh/typesafe", model: "typesafe-ai/jev",
    });
  });

  it("rejects unsupported credentials and endpoints without disclosing values", () => {
    const cases = [
      { TYPESAFE_API_KEY: "legacy-secret" },
      { JEV_API_KEY: " " },
      { JEV_API_KEY: "secret", TYPESAFE_API_KEY: "legacy-secret" },
      { JEV_API_KEY: "secret", JEV_BASE_URL: "not-a-url-secret" },
      { JEV_API_KEY: "secret", JEV_BASE_URL: "http://api.typesafe.ai" },
      { JEV_API_KEY: "secret", JEV_BASE_URL: "https://user:password@api.typesafe.ai" },
      { JEV_API_KEY: "secret", JEV_BASE_URL: "https://api.typesafe.ai?token=secret" },
      { JEV_API_KEY: "secret", JEV_BASE_URL: "https://other.example/typesafe" },
    ];
    for (const env of cases) {
      let message = "";
      try { loadJevConnection(env); } catch (error) { message = (error as Error).message; }
      expect(message).not.toBe("");
      expect(message).not.toMatch(/secret|password/);
    }
  });
});

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
    expect(defaults.decisionsLogPath).toBeUndefined();
    expect(loadConfig({ JEV_DECISIONS_LOG_PATH: "/tmp/decisions.jsonl" }).decisionsLogPath).toBe("/tmp/decisions.jsonl");
    expect(() => loadConfig({ JEV_DECISIONS_LOG_PATH: "relative.jsonl" })).toThrow("JEV_DECISIONS_LOG_PATH");
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
  it("defaults to forwarding only to the local upstream", () => {
    const config = loadConfig({});
    expect(config.upstreamAuth).toEqual({ policy: "forward" });
    expect(config.upstreamBaseUrl).toBe("http://127.0.0.1:8317/v1");
  });

  it("supports a configured HTTPS upstream with a router-owned bearer key", () => {
    const config = loadConfig({ UPSTREAM_BASE_URL: "https://api.openai.com/v1", UPSTREAM_AUTH: "bearer", UPSTREAM_API_KEY: "test-key" });
    expect(config.upstreamAuth).toEqual({ policy: "bearer", apiKey: "test-key" });
    expect(config.upstreamBaseUrl).toBe("https://api.openai.com/v1");
    expect(loadConfig({}).baseEffort).toBeUndefined();
    for (const name of ["UPSTREAM_MODEL", "UPSTREAM_MODELS", "ALLOWED_MODELS"]) {
      for (const value of ["", "secret-model"]) {
        expect(() => loadConfig({ [name]: value })).toThrow(`${name} is unsupported; select a registered model through request.model`);
      }
    }
    expect(() => loadConfig({ BASE_EFFORT: "none" })).toThrow("BASE_EFFORT");
    expect(loadConfig({ BASE_EFFORT: "high" }).baseEffort).toBe("high");
    expect(loadConfig({ UPSTREAM_BASE_URL: "http://localhost:8317/v1", UPSTREAM_AUTH: "bearer", UPSTREAM_API_KEY: "local-key" }).upstreamAuth)
      .toEqual({ policy: "bearer", apiKey: "local-key" });
    expect(loadConfig({ UPSTREAM_BASE_URL: "http://[::1]:8317/v1" }).upstreamAuth)
      .toEqual({ policy: "forward" });
    expect(upstreamHostname(new URL("http://[::1]:8317/v1"))).toBe("::1");
  });

  it("rejects invalid policies, missing credentials, and credential misrouting", () => {
    expect(() => loadConfig({ UPSTREAM_MODE: "other", OPENAI_API_KEY: "test-key" }))
      .toThrow("UPSTREAM_MODE and OPENAI_API_KEY are unsupported");
    expect(() => loadConfig({ OPENAI_API_KEY: "old-key" })).toThrow("unsupported");
    expect(() => loadConfig({ UPSTREAM_AUTH: "other" }))
      .toThrow("UPSTREAM_AUTH must be forward or bearer");
    expect(() => loadConfig({ UPSTREAM_AUTH: "bearer" }))
      .toThrow("UPSTREAM_API_KEY is required when UPSTREAM_AUTH=bearer");
    expect(() => loadConfig({ UPSTREAM_AUTH: "bearer", UPSTREAM_API_KEY: "  " }))
      .toThrow("UPSTREAM_API_KEY is required when UPSTREAM_AUTH=bearer");
    expect(() => loadConfig({ UPSTREAM_API_KEY: "secret" })).toThrow("UPSTREAM_API_KEY requires UPSTREAM_AUTH=bearer");
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "https://api.openai.com/v1" }))
      .toThrow("UPSTREAM_AUTH=forward requires a loopback");
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "https://gateway.example/v1" }))
      .toThrow("UPSTREAM_AUTH=forward requires a loopback");
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "http://gateway.example/v1", UPSTREAM_AUTH: "bearer", UPSTREAM_API_KEY: "secret" }))
      .toThrow("UPSTREAM_AUTH=bearer requires HTTPS");
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "https://user:pass@proxy.example/v1" }))
      .toThrow("UPSTREAM_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment");
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "no-url" }))
      .toThrow("UPSTREAM_BASE_URL must be a valid HTTP(S) URL");
    expect(() => loadConfig({ UPSTREAM_MODEL: " gpt-6-astra" })).toThrow("UPSTREAM_MODEL");
    expect(() => loadConfig({ UPSTREAM_MODEL: "gpt-6-astra-pro" })).toThrow("UPSTREAM_MODEL is unsupported");
  });
});
