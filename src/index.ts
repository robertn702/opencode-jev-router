#!/usr/bin/env node
import { existsSync } from "node:fs";

import { loadConfig } from "./config.js";
import { formatEvidence } from "./evidence.js";
import { createJevClassifier } from "./jev.js";
import { createAppServer } from "./server.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: opencode-jev-router [--help]

Start the local Jev-powered Responses API proxy.

Environment:
  TYPESAFE_API_KEY   Required Jev API key
  JEV_PROXY_PORT     Listening port (default: 4320)
  UPSTREAM_BASE_URL  CLIProxyAPI base URL (default: http://127.0.0.1:8317/v1)
  UPSTREAM_MODEL     Execution model (default: gpt-6-astra)
  BASE_EFFORT        Base reasoning effort (default: medium)
  JEV_TIMEOUT_MS     Jev timeout in milliseconds (default: 4000)
  MAX_REQUEST_BYTES  Maximum POST body bytes (default: 1048576)
  MAX_IN_FLIGHT      Maximum active proxy requests (default: 32)
  UPSTREAM_HEADER_TIMEOUT_MS  Upstream header deadline (default: 10000)
  UPSTREAM_IDLE_TIMEOUT_MS    Upstream response idle deadline (default: 60000)
  EFFORT_CACHE_ENTRIES        Previous-effort cache capacity (default: 256)
  EFFORT_CACHE_TTL_MS         Previous-effort expiry (default: 600000)`);
  process.exit(0);
}

if (process.argv.length > 2) {
  console.error(`Unknown argument: ${process.argv[2]}. Run with --help for usage.`);
  process.exit(1);
}

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const config = loadConfig(process.env);

const apiKey = process.env.TYPESAFE_API_KEY;
if (apiKey === undefined || apiKey.trim() === "") {
  throw new Error("TYPESAFE_API_KEY is required for Jev effort selection");
}

const classifier = createJevClassifier({
  apiKey,
  timeoutMs: config.jevTimeoutMs,
  cacheEntries: config.effortCacheEntries,
  cacheTtlMs: config.effortCacheTtlMs,
});

const server = createAppServer({
  upstreamBaseUrl: config.upstreamBaseUrl,
  upstreamModel: config.upstreamModel,
  baseEffort: config.baseEffort,
  maxRequestBytes: config.maxRequestBytes,
  maxInFlight: config.maxInFlight,
  upstreamHeaderTimeoutMs: config.upstreamHeaderTimeoutMs,
  upstreamIdleTimeoutMs: config.upstreamIdleTimeoutMs,
  selectEffort: classifier.select,
  onEvidence: (evidence) => {
    console.log(formatEvidence(evidence));
  },
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(
    `opencode-jev-router listening on http://127.0.0.1:${config.port}`,
  );
});
