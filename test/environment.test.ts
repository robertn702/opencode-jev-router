import { it, expect } from "vitest";
import { loadConfig, loadJevConnection } from "../src/config.js";

const upstream = { JEV_ROUTER_UPSTREAM_BASE_URL: "http://127.0.0.1:8080/v1" };

it("requires the Jev credential names and ignores old router settings", () => {
  expect(() => loadJevConnection({ JEV_ROUTER_API_KEY: "old" })).toThrow("JEV_API_KEY");
  expect(() => loadJevConnection({ JEV_API_KEY: "key", JEV_ROUTER_BASE_URL: "https://api.typesafe.ai" })).toThrow("JEV_BASE_URL");
  expect(loadConfig({ JEV_ROUTER_UPSTREAM_BASE_URL: "http://127.0.0.1:8080/v1", JEV_PROXY_PORT: "9999", BASE_EFFORT: "high" })).toMatchObject({ port: 4320, baseEffort: undefined });
});
it("keeps credential and endpoint selection explicit", () => {
  expect(loadJevConnection({ JEV_API_KEY: "key" }).baseURL).toBe("https://api.typesafe.ai");
  expect(loadJevConnection({ JEV_API_KEY: "gateway", JEV_BASE_URL: "https://ai-gateway.vercel.sh/typesafe" }).model).toBe("typesafe-ai/jev");
  expect(loadConfig({ JEV_ROUTER_UPSTREAM_BASE_URL: "http://127.0.0.1:8080/v1", JEV_ROUTER_PORT: "4321", JEV_ROUTER_CLASSIFICATION_TIMEOUT_MS: "10000" })).toMatchObject({ port: 4321, jevTimeoutMs: 10000 });
});

it("selects the hosted backend by default and Laya only when explicit", () => {
  expect(loadConfig(upstream)).toMatchObject({ classifierBackend: "jev", layaModelDir: undefined, layaCacheDir: undefined });
  expect(loadConfig({
    ...upstream,
    JEV_ROUTER_CLASSIFIER_BACKEND: "laya",
    JEV_ROUTER_LAYA_MODEL_DIR: "/models/laya",
    JEV_ROUTER_LAYA_CACHE_DIR: "/cache/laya",
  })).toMatchObject({ classifierBackend: "laya", layaModelDir: "/models/laya", layaCacheDir: "/cache/laya" });
  expect(() => loadConfig({ ...upstream, JEV_ROUTER_CLASSIFIER_BACKEND: "local" })).toThrow("JEV_ROUTER_CLASSIFIER_BACKEND");
});
