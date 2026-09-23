import type { Effort } from "./rewrite.js";

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export interface AppConfig {
  port: number;
  upstreamBaseUrl: string;
  upstreamModel: string;
  baseEffort: Effort;
  jevTimeoutMs: number;
  maxRequestBytes: number;
  maxInFlight: number;
  upstreamHeaderTimeoutMs: number;
  upstreamIdleTimeoutMs: number;
  effortCacheEntries: number;
  effortCacheTtlMs: number;
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

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    port: parsePort(env.JEV_PROXY_PORT),
    upstreamBaseUrl: env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:8317/v1",
    upstreamModel: env.UPSTREAM_MODEL ?? "gpt-6-astra",
    baseEffort: parseEffort(env.BASE_EFFORT),
    jevTimeoutMs: parseTimeout(env.JEV_TIMEOUT_MS),
    maxRequestBytes: positiveInteger(env.MAX_REQUEST_BYTES, 1_048_576, "MAX_REQUEST_BYTES"),
    maxInFlight: positiveInteger(env.MAX_IN_FLIGHT, 32, "MAX_IN_FLIGHT"),
    upstreamHeaderTimeoutMs: positiveInteger(env.UPSTREAM_HEADER_TIMEOUT_MS, 10_000, "UPSTREAM_HEADER_TIMEOUT_MS"),
    upstreamIdleTimeoutMs: positiveInteger(env.UPSTREAM_IDLE_TIMEOUT_MS, 60_000, "UPSTREAM_IDLE_TIMEOUT_MS"),
    effortCacheEntries: positiveInteger(env.EFFORT_CACHE_ENTRIES, 256, "EFFORT_CACHE_ENTRIES"),
    effortCacheTtlMs: positiveInteger(env.EFFORT_CACHE_TTL_MS, 600_000, "EFFORT_CACHE_TTL_MS"),
  };
}
