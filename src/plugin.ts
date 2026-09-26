import { serverV1 } from "./plugin-v1.js";
import { setupV2 } from "./plugin-v2.js";

export type { PluginOptions } from "./plugin-runtime.js";

/**
 * Dual OpenCode entrypoint. V1 (1.18.29+) calls `server()`; V2 reads `id` and
 * calls `setup()`, ignoring `server()`. Each adapter owns its own per-instance
 * runtime, so one host never registers the provider twice.
 */
const plugin = {
  id: "jev-router",
  setup: setupV2,
  server: serverV1,
};

export default plugin;
