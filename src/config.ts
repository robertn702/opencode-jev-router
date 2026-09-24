import type { Effort } from "./rewrite.js";
import { isAbsolute } from "node:path";
import { MODELS, supportsEffort } from "./models.js";
import { classificationPolicy, type ClassificationPolicyOptions } from "./classification-policy.js";

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export interface AppConfig extends ClassificationPolicyOptions {
  port: number;
  upstreamBaseUrl: string;
  upstreamAuth: UpstreamAuth;
  baseEffort: Effort | undefined;
  jevTimeoutMs: number;
  maxRequestBytes: number;
  maxInFlight: number;
  upstreamHeaderTimeoutMs: number;
  upstreamIdleTimeoutMs: number;
  effortCacheEntries: number;
  effortCacheTtlMs: number;
  shutdownGraceMs: number;
  decisionsLogPath?: string;
}

export type UpstreamAuth = { policy: "forward" } | { policy: "bearer"; apiKey: string };

export interface JevConnection {
  apiKey: string;
  baseURL: string;
  model: string;
}

export function resolveJevConnection(apiKey: string, raw = "https://api.typesafe.ai"): JevConnection {
  if (!apiKey.trim()) throw new Error("JEV_API_KEY is required for Jev classification");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("JEV_BASE_URL must be a valid HTTPS URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error("JEV_BASE_URL must be an HTTPS URL without credentials, query, or fragment");
  const baseURL = url.href.replace(/\/$/, "");
  const model = baseURL === "https://api.typesafe.ai" ? "jev-latest" : baseURL === "https://ai-gateway.vercel.sh/typesafe" ? "typesafe-ai/jev" : null;
  if (model === null) throw new Error("JEV_BASE_URL supports only the TypeSafe direct and Vercel TypeSafe-compatible endpoints");
  return { apiKey: apiKey.trim(), baseURL, model };
}

export function loadJevConnection(env: Record<string, string | undefined>): JevConnection {
  if (env.TYPESAFE_API_KEY !== undefined) {
    throw new Error("TYPESAFE_API_KEY is unsupported; use JEV_API_KEY");
  }
  return resolveJevConnection(env.JEV_API_KEY ?? "", env.JEV_BASE_URL);
}

export function upstreamHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
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

function parseEffort(raw: string | undefined): Effort | undefined {
  if (raw === undefined) return undefined;
  const value = raw;
  if (!MODELS.every((model) => supportsEffort(model, value))) {
    throw new Error(`BASE_EFFORT must be one of ${EFFORTS.join(", ")}`);
  }
  return value as Effort;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const jevPolicy = classificationPolicy({ maxRetries: env.JEV_MAX_RETRIES === undefined ? undefined : Number(env.JEV_MAX_RETRIES), fallbackMode: env.JEV_FALLBACK_MODE as ClassificationPolicyOptions["fallbackMode"], fallbackEffort: env.JEV_FALLBACK_EFFORT as Effort | undefined });
  for (const name of ["UPSTREAM_MODEL", "UPSTREAM_MODELS", "ALLOWED_MODELS"]) {
    if (env[name] !== undefined) throw new Error(`${name} is unsupported; select a registered model through request.model`);
  }
  if (env.JEV_DECISIONS_LOG_PATH !== undefined && !isAbsolute(env.JEV_DECISIONS_LOG_PATH)) {
    throw new Error("JEV_DECISIONS_LOG_PATH must be an absolute path");
  }
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
    ...jevPolicy,
    port: parsePort(env.JEV_PROXY_PORT),
    upstreamBaseUrl,
    upstreamAuth: policy === "bearer"
      ? { policy, apiKey: env.UPSTREAM_API_KEY!.trim() }
      : { policy },
    baseEffort: parseEffort(env.BASE_EFFORT),
    jevTimeoutMs: parseTimeout(env.JEV_TIMEOUT_MS),
    maxRequestBytes: positiveInteger(env.MAX_REQUEST_BYTES, 1_048_576, "MAX_REQUEST_BYTES"),
    maxInFlight: positiveInteger(env.MAX_IN_FLIGHT, 32, "MAX_IN_FLIGHT"),
    upstreamHeaderTimeoutMs: positiveInteger(env.UPSTREAM_HEADER_TIMEOUT_MS, 10_000, "UPSTREAM_HEADER_TIMEOUT_MS"),
    upstreamIdleTimeoutMs: positiveInteger(env.UPSTREAM_IDLE_TIMEOUT_MS, 60_000, "UPSTREAM_IDLE_TIMEOUT_MS"),
    effortCacheEntries: positiveInteger(env.EFFORT_CACHE_ENTRIES, 256, "EFFORT_CACHE_ENTRIES"),
    effortCacheTtlMs: positiveInteger(env.EFFORT_CACHE_TTL_MS, 600_000, "EFFORT_CACHE_TTL_MS"),
    shutdownGraceMs: positiveInteger(env.SHUTDOWN_GRACE_MS, 30_000, "SHUTDOWN_GRACE_MS"),
    decisionsLogPath: env.JEV_DECISIONS_LOG_PATH,
  };
}
