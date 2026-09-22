import { loadConfig } from "./config.js";
import { createAppServer } from "./server.js";

const config = loadConfig(process.env);

const server = createAppServer({
  upstreamBaseUrl: config.upstreamBaseUrl,
  upstreamModel: config.upstreamModel,
  baseEffort: config.baseEffort,
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(
    `opencode-jev-router listening on http://127.0.0.1:${config.port}`,
  );
});
