import { createAppServer } from "./server.js";

const port = Number.parseInt(process.env.JEV_PROXY_PORT ?? "4320", 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("JEV_PROXY_PORT must be an integer between 1 and 65535");
}

const server = createAppServer();
server.listen(port, "127.0.0.1", () => {
  console.log(`opencode-jev-router scaffold listening on http://127.0.0.1:${port}`);
});
