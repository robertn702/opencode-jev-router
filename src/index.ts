import { existsSync } from "node:fs";

import { loadConfig } from "./config.js";
import { formatEvidence } from "./evidence.js";
import { createJevClassifier } from "./jev.js";
import { createAppServer } from "./server.js";

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
});

const server = createAppServer({
  upstreamBaseUrl: config.upstreamBaseUrl,
  upstreamModel: config.upstreamModel,
  baseEffort: config.baseEffort,
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
