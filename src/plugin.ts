import { setupV2 } from "./plugin-v2.js";

export type { PluginOptions } from "./plugin-runtime.js";

/** Native OpenCode V2 entrypoint. */
const plugin = {
  id: "jev-router",
  setup: setupV2,
};

export default plugin;
