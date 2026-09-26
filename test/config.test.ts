import { describe, expect, it } from "vitest";
import { loadConfig, loadJevConnection, upstreamHostname } from "../src/config.js";

const upstream = { JEV_ROUTER_UPSTREAM_BASE_URL: "http://127.0.0.1:8080/v1" };
const load = (env: Record<string, string | undefined>) => loadConfig({ ...upstream, ...env });

describe("Jev connection", () => {
  it("uses the direct endpoint and Jev model by default", () => {
    expect(loadJevConnection({ JEV_ROUTER_API_KEY: " direct-key " })).toEqual({
      apiKey: "direct-key", baseURL: "https://api.typesafe.ai", model: "jev-latest",
    });
  });

  it("selects the Vercel Jev model for its TypeSafe-compatible endpoint", () => {
    expect(loadJevConnection({ JEV_ROUTER_API_KEY: "gateway-key", JEV_ROUTER_BASE_URL: "https://ai-gateway.vercel.sh/typesafe/" })).toEqual({
      apiKey: "gateway-key", baseURL: "https://ai-gateway.vercel.sh/typesafe", model: "typesafe-ai/jev",
    });
  });

  it("rejects unsupported credentials and endpoints without disclosing values", () => {
    const cases = [
      { TYPESAFE_API_KEY: "legacy-secret" },
      { JEV_ROUTER_API_KEY: " " },
      { JEV_ROUTER_API_KEY: "secret", TYPESAFE_API_KEY: "legacy-secret" },
      { JEV_ROUTER_API_KEY: "secret", JEV_ROUTER_BASE_URL: "not-a-url-secret" },
      { JEV_ROUTER_API_KEY: "secret", JEV_ROUTER_BASE_URL: "http://api.typesafe.ai" },
      { JEV_ROUTER_API_KEY: "secret", JEV_ROUTER_BASE_URL: "https://user:password@api.typesafe.ai" },
      { JEV_ROUTER_API_KEY: "secret", JEV_ROUTER_BASE_URL: "https://api.typesafe.ai?token=secret" },
      { JEV_ROUTER_API_KEY: "secret", JEV_ROUTER_BASE_URL: "https://other.example/typesafe" },
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
    const defaults = load({});
    expect(defaults.maxRequestBytes).toBe(1_048_576);
    expect(defaults.maxInFlight).toBe(32);
    expect(defaults.upstreamHeaderTimeoutMs).toBe(10_000);
    expect(defaults.upstreamIdleTimeoutMs).toBe(60_000);
    expect(defaults.effortCacheEntries).toBe(256);
    expect(defaults.effortCacheTtlMs).toBe(600_000);
    expect(defaults.shutdownGraceMs).toBe(30_000);
    expect(defaults.decisionsLogPath).toBeUndefined();
    expect(load({ JEV_ROUTER_DECISIONS_LOG_PATH: "/tmp/decisions.jsonl" }).decisionsLogPath).toBe("/tmp/decisions.jsonl");
    expect(() => load({ JEV_ROUTER_DECISIONS_LOG_PATH: "relative.jsonl" })).toThrow("JEV_ROUTER_DECISIONS_LOG_PATH");
    expect(load({ JEV_ROUTER_SHUTDOWN_GRACE_MS: "50" }).shutdownGraceMs).toBe(50);
    expect(load({ JEV_ROUTER_MAX_IN_FLIGHT: "1" }).maxInFlight).toBe(1);
  });

  it("rejects invalid values instead of silently accepting partial integers", () => {
    for (const name of ["JEV_ROUTER_MAX_REQUEST_BYTES", "JEV_ROUTER_MAX_IN_FLIGHT", "JEV_ROUTER_UPSTREAM_HEADER_TIMEOUT_MS",
      "JEV_ROUTER_UPSTREAM_IDLE_TIMEOUT_MS", "JEV_ROUTER_EFFORT_CACHE_ENTRIES", "JEV_ROUTER_EFFORT_CACHE_TTL_MS", "JEV_ROUTER_SHUTDOWN_GRACE_MS"]) {
      for (const value of ["0", "-1", "1.5", "10junk", "Infinity"]) {
        expect(() => load({ [name]: value })).toThrow(name);
      }
    }
  });
  it("validates upstream configuration without exposing credentials", () => {
    expect(() => load({ JEV_ROUTER_UPSTREAM_BASE_URL: "bad-secret" })).toThrow("JEV_ROUTER_UPSTREAM_BASE_URL");
    expect(() => load({ JEV_ROUTER_UPSTREAM_BASE_URL: "http://user:secret@localhost:8080/v1" })).toThrow("JEV_ROUTER_UPSTREAM_BASE_URL");
  });
});

describe("upstream configuration", () => {
  it("requires an upstream and defaults to forwarding the client credential", () => {
    for (const value of [undefined, "", " "]) {
      expect(() => loadConfig({ JEV_ROUTER_UPSTREAM_BASE_URL: value })).toThrow("JEV_ROUTER_UPSTREAM_BASE_URL is required");
    }
    const config = load({});
    expect(config.upstreamAuth).toEqual({ policy: "forward" });
    expect(config.upstreamBaseUrl).toBe(upstream.JEV_ROUTER_UPSTREAM_BASE_URL);
  });

  it("supports a configured HTTPS upstream with a router-owned bearer key", () => {
    const config = load({ JEV_ROUTER_UPSTREAM_BASE_URL: "https://api.openai.com/v1", JEV_ROUTER_UPSTREAM_AUTH: "bearer", JEV_ROUTER_UPSTREAM_API_KEY: "test-key" });
    expect(config.upstreamAuth).toEqual({ policy: "bearer", apiKey: "test-key" });
    expect(config.upstreamBaseUrl).toBe("https://api.openai.com/v1");
    expect(load({}).baseEffort).toBeUndefined();
    for (const name of ["UPSTREAM_MODEL", "UPSTREAM_MODELS", "ALLOWED_MODELS"]) {
      for (const value of ["", "secret-model"]) {
        expect(() => load({ [name]: value })).toThrow(`${name} is unsupported; select a registered model through request.model`);
      }
    }
    expect(() => load({ JEV_ROUTER_BASE_EFFORT: "none" })).toThrow("JEV_ROUTER_BASE_EFFORT");
    expect(load({ JEV_ROUTER_BASE_EFFORT: "high" }).baseEffort).toBe("high");
    expect(load({ JEV_ROUTER_UPSTREAM_BASE_URL: "http://localhost:8080/v1", JEV_ROUTER_UPSTREAM_AUTH: "bearer", JEV_ROUTER_UPSTREAM_API_KEY: "local-key" }).upstreamAuth)
      .toEqual({ policy: "bearer", apiKey: "local-key" });
    expect(load({ JEV_ROUTER_UPSTREAM_BASE_URL: "http://[::1]:8080/v1" }).upstreamAuth)
      .toEqual({ policy: "forward" });
    expect(upstreamHostname(new URL("http://[::1]:8080/v1"))).toBe("::1");
  });

  it("rejects invalid policies, missing credentials, and credential misrouting", () => {
    expect(() => load({ UPSTREAM_MODE: "other", OPENAI_API_KEY: "test-key" }))
      .toThrow("UPSTREAM_MODE and OPENAI_API_KEY are unsupported");
    expect(() => load({ OPENAI_API_KEY: "old-key" })).toThrow("unsupported");
    expect(() => load({ JEV_ROUTER_UPSTREAM_AUTH: "other" }))
      .toThrow("JEV_ROUTER_UPSTREAM_AUTH must be forward or bearer");
    expect(() => load({ JEV_ROUTER_UPSTREAM_AUTH: "bearer" }))
      .toThrow("JEV_ROUTER_UPSTREAM_API_KEY is required when JEV_ROUTER_UPSTREAM_AUTH=bearer");
    expect(() => load({ JEV_ROUTER_UPSTREAM_AUTH: "bearer", JEV_ROUTER_UPSTREAM_API_KEY: "  " }))
      .toThrow("JEV_ROUTER_UPSTREAM_API_KEY is required when JEV_ROUTER_UPSTREAM_AUTH=bearer");
    expect(() => load({ JEV_ROUTER_UPSTREAM_API_KEY: "secret" })).toThrow("JEV_ROUTER_UPSTREAM_API_KEY requires JEV_ROUTER_UPSTREAM_AUTH=bearer");
    expect(() => load({ JEV_ROUTER_UPSTREAM_BASE_URL: "https://api.openai.com/v1" }))
      .toThrow("JEV_ROUTER_UPSTREAM_AUTH=forward requires a loopback");
    expect(() => load({ JEV_ROUTER_UPSTREAM_BASE_URL: "https://gateway.example/v1" }))
      .toThrow("JEV_ROUTER_UPSTREAM_AUTH=forward requires a loopback");
    expect(() => load({ JEV_ROUTER_UPSTREAM_BASE_URL: "http://gateway.example/v1", JEV_ROUTER_UPSTREAM_AUTH: "bearer", JEV_ROUTER_UPSTREAM_API_KEY: "secret" }))
      .toThrow("JEV_ROUTER_UPSTREAM_AUTH=bearer requires HTTPS");
    expect(() => load({ JEV_ROUTER_UPSTREAM_BASE_URL: "https://user:pass@proxy.example/v1" }))
      .toThrow("JEV_ROUTER_UPSTREAM_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment");
    expect(() => load({ JEV_ROUTER_UPSTREAM_BASE_URL: "no-url" }))
      .toThrow("JEV_ROUTER_UPSTREAM_BASE_URL must be a valid HTTP(S) URL");
    expect(() => load({ UPSTREAM_MODEL: " gpt-6-astra" })).toThrow("UPSTREAM_MODEL");
    expect(() => load({ UPSTREAM_MODEL: "gpt-6-astra-pro" })).toThrow("UPSTREAM_MODEL is unsupported");
  });
});
