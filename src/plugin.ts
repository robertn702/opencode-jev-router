import { setupV2 } from "./plugin-v2.js";

export type { PluginOptions } from "./plugin-runtime.js";

const plugin = {
  id: "jev-router",
  setup: setupV2,
};

export default plugin;
