import { it, expect } from "vitest";
import { loadConfig, loadJevConnection } from "../src/config.js";

it("requires the namespaced credential and ignores old router settings", () => {
  expect(() => loadJevConnection({ JEV_API_KEY: "old" })).toThrow("JEV_ROUTER_API_KEY");
  expect(loadConfig({ JEV_PROXY_PORT: "9999", BASE_EFFORT: "high" })).toMatchObject({ port: 4320, baseEffort: undefined });
});
it("keeps credential and endpoint selection explicit", () => {
  expect(loadJevConnection({ JEV_ROUTER_API_KEY: "key" }).baseURL).toBe("https://api.typesafe.ai");
  expect(loadJevConnection({ JEV_ROUTER_API_KEY: "gateway", JEV_ROUTER_BASE_URL: "https://ai-gateway.vercel.sh/typesafe" }).model).toBe("typesafe-ai/jev");
  expect(loadConfig({ JEV_ROUTER_PORT: "4321", JEV_ROUTER_CLASSIFICATION_TIMEOUT_MS: "10000" })).toMatchObject({ port: 4321, jevTimeoutMs: 10000 });
});
