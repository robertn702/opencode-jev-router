import type { Effort } from "./rewrite.js";

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export interface AppConfig {
  port: number;
  upstreamBaseUrl: string;
  upstreamAuth: UpstreamAuth;
  upstreamModel: string;
  baseEffort: Effort;
  jevTimeoutMs: number;
  maxRequestBytes: number;
  maxInFlight: number;
  upstreamHeaderTimeoutMs: number;
  upstreamIdleTimeoutMs: number;
  effortCacheEntries: number;
  effortCacheTtlMs: number;
  shutdownGraceMs: number;
}

export type UpstreamAuth = { policy: "forward" } | { policy: "bearer"; apiKey: string };

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parsePort(raw: string | undefined): number {
  const port = Number.parseInt(raw ?? "4320", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("JEV_PROXY_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseTimeout(raw: string | undefined): number {
  const ms = Number.parseInt(raw ?? "4000", 10);
  if (!Number.isInteger(ms) || ms < 1) {
    throw new Error("JEV_TIMEOUT_MS must be a positive integer");
  }
  return ms;
}

function parseEffort(raw: string | undefined): Effort {
  const value = raw ?? "medium";
  if (!EFFORTS.includes(value)) {
    throw new Error(`BASE_EFFORT must be one of ${EFFORTS.join(", ")}`);
  }
  return value as Effort;
}

function upstreamModel(raw: string | undefined): string {
  const value = raw ?? "gpt-6-astra";
  if (!value.trim() || value !== value.trim()) throw new Error("UPSTREAM_MODEL must be a non-empty model ID without surrounding whitespace");
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  if (env.UPSTREAM_MODE !== undefined || env.OPENAI_API_KEY !== undefined) {
    throw new Error("UPSTREAM_MODE and OPENAI_API_KEY are unsupported; use UPSTREAM_AUTH and UPSTREAM_API_KEY");
  }
  const policy = env.UPSTREAM_AUTH ?? "forward";
  if (policy !== "forward" && policy !== "bearer") {
    throw new Error("UPSTREAM_AUTH must be forward or bearer");
  }
  if (policy === "bearer" && !env.UPSTREAM_API_KEY?.trim()) {
    throw new Error("UPSTREAM_API_KEY is required when UPSTREAM_AUTH=bearer");
  }
  if (policy === "forward" && env.UPSTREAM_API_KEY !== undefined) {
    throw new Error("UPSTREAM_API_KEY requires UPSTREAM_AUTH=bearer");
  }

  const upstreamBaseUrl = env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:8317/v1";
  let url: URL;
  try {
    url = new URL(upstreamBaseUrl);
  } catch {
    throw new Error("UPSTREAM_BASE_URL must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) || !url.hostname ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error("UPSTREAM_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (policy === "forward" && !loopback) {
    throw new Error("UPSTREAM_AUTH=forward requires a loopback UPSTREAM_BASE_URL");
  }
  if (policy === "bearer" && url.protocol !== "https:" && !loopback) {
    throw new Error("UPSTREAM_AUTH=bearer requires HTTPS except for loopback endpoints");
  }

  return {
    port: parsePort(env.JEV_PROXY_PORT),
    upstreamBaseUrl,
    upstreamAuth: policy === "bearer"
      ? { policy, apiKey: env.UPSTREAM_API_KEY!.trim() }
      : { policy },
    upstreamModel: upstreamModel(env.UPSTREAM_MODEL),
    baseEffort: parseEffort(env.BASE_EFFORT),
    jevTimeoutMs: parseTimeout(env.JEV_TIMEOUT_MS),
    maxRequestBytes: positiveInteger(env.MAX_REQUEST_BYTES, 1_048_576, "MAX_REQUEST_BYTES"),
    maxInFlight: positiveInteger(env.MAX_IN_FLIGHT, 32, "MAX_IN_FLIGHT"),
    upstreamHeaderTimeoutMs: positiveInteger(env.UPSTREAM_HEADER_TIMEOUT_MS, 10_000, "UPSTREAM_HEADER_TIMEOUT_MS"),
    upstreamIdleTimeoutMs: positiveInteger(env.UPSTREAM_IDLE_TIMEOUT_MS, 60_000, "UPSTREAM_IDLE_TIMEOUT_MS"),
    effortCacheEntries: positiveInteger(env.EFFORT_CACHE_ENTRIES, 256, "EFFORT_CACHE_ENTRIES"),
    effortCacheTtlMs: positiveInteger(env.EFFORT_CACHE_TTL_MS, 600_000, "EFFORT_CACHE_TTL_MS"),
    shutdownGraceMs: positiveInteger(env.SHUTDOWN_GRACE_MS, 30_000, "SHUTDOWN_GRACE_MS"),
  };
}
