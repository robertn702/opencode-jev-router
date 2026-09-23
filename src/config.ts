import type { Effort } from "./rewrite.js";

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export interface AppConfig {
  port: number;
  upstreamBaseUrl: string;
  upstreamAuth: { mode: "cliproxyapi" } | { mode: "openai"; apiKey: string };
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
  if (!value.trim()) throw new Error("UPSTREAM_MODEL must not be empty");
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const mode = env.UPSTREAM_MODE ?? "cliproxyapi";
  if (mode !== "cliproxyapi" && mode !== "openai") {
    throw new Error("UPSTREAM_MODE must be openai or cliproxyapi");
  }
  if (mode === "openai" && !env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required when UPSTREAM_MODE=openai");
  }

  const upstreamBaseUrl = env.UPSTREAM_BASE_URL ??
    (mode === "openai" ? "https://api.openai.com/v1" : "http://127.0.0.1:8317/v1");
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
  if (mode === "openai" && url.href !== "https://api.openai.com/v1") {
    throw new Error("UPSTREAM_MODE=openai requires UPSTREAM_BASE_URL=https://api.openai.com/v1");
  }
  if (mode === "cliproxyapi" && url.hostname === "api.openai.com") {
    throw new Error("UPSTREAM_MODE=cliproxyapi cannot use api.openai.com");
  }

  return {
    port: parsePort(env.JEV_PROXY_PORT),
    upstreamBaseUrl,
    upstreamAuth: mode === "openai"
      ? { mode, apiKey: env.OPENAI_API_KEY!.trim() }
      : { mode },
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
