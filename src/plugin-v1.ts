import { randomUUID } from "node:crypto";

import { modelsFor } from "./models.js";
import { createPluginRuntime, isRecord, PluginRequestError, requiredString, SESSION, TURN, upstreamBaseURL, valid, type PluginOptions } from "./plugin-runtime.js";

type ProviderConfig = { npm?: string; name?: string; options?: Record<string, unknown>; models?: Record<string, unknown> };
type OpenCodeConfig = { provider?: Record<string, ProviderConfig> };
type HeaderHook = { sessionID: string; model: { providerID?: string; provider?: string }; provider: { id?: string } };

const error = (status: number, code: string, message: string): Response => new Response(JSON.stringify({ error: code, message }), { status, headers: { "content-type": "application/json" } });
const validateModel = (id: string, model: unknown, adapter: typeof fetch, npm = "@ai-sdk/openai"): Record<string, unknown> => {
  if (!isRecord(model)) throw new Error(`jev-router model ${id} must be an object`);
  if (model.npm !== undefined) throw new Error(`jev-router model ${id} cannot override the SDK`);
  const modelProvider = model.provider;
  if (modelProvider !== undefined) {
    if (!isRecord(modelProvider)) throw new Error(`jev-router model ${id} provider must be an object`);
    if (modelProvider.npm !== undefined && modelProvider.npm !== npm) throw new Error(`jev-router model ${id} requires provider.npm: ${npm}`);
    if (modelProvider.fetch !== undefined) throw new Error("jev-router model fetch is managed by the plugin");
    modelProvider.options ??= {};
    if (!isRecord(modelProvider.options)) throw new Error(`jev-router model ${id} provider options must be an object`);
    if (modelProvider.options.fetch !== undefined && modelProvider.options.fetch !== adapter) throw new Error("jev-router model fetch is managed by the plugin");
    if (npm === "@ai-sdk/openai" && modelProvider.options.useResponses !== undefined && modelProvider.options.useResponses !== true) throw new Error("jev-router models require useResponses: true");
    if (modelProvider.options.baseURL !== undefined) modelProvider.options.baseURL = upstreamBaseURL(modelProvider.options.baseURL);
    if (modelProvider.options.apiKey !== undefined) modelProvider.options.apiKey = requiredString(modelProvider.options.apiKey, `jev-router model ${id} provider options.apiKey`);
    if (npm === "@ai-sdk/openai") modelProvider.options.useResponses = true;
    modelProvider.options.fetch = adapter;
  }
  model.options ??= {};
  if (!isRecord(model.options)) throw new Error(`jev-router model ${id} options must be an object`);
  if (npm === "@ai-sdk/openai" && model.options.useResponses !== undefined && model.options.useResponses !== true) throw new Error("jev-router models require useResponses: true");
  if (model.options.fetch !== undefined) throw new Error("jev-router model fetch is managed by the plugin");
  if (npm === "@ai-sdk/openai") model.options.useResponses = true;
  return model;
};

/** OpenCode V1 `server()` entrypoint: a provider fetch adapter plus correlation headers. */
export async function serverV1(_input: unknown, options: PluginOptions = {}) {
  const runtime = createPluginRuntime(options);

  const adapter = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request: Request;
    try { request = new Request(input, init); } catch { return error(400, "invalid_request", "unsupported fetch input"); }
    let exchange;
    try {
      exchange = await runtime.start(request, { session: valid(request.headers.get("x-jev-session-id"), SESSION), turnId: valid(request.headers.get("x-jev-turn-id"), TURN) });
    } catch (cause) {
      if (cause instanceof PluginRequestError) return error(cause.status, cause.code, cause.message);
      return error(502, "upstream_unavailable", "upstream_unavailable");
    }
    let upstream: Response;
    try { upstream = await fetch(exchange.url, { method: "POST", headers: exchange.headers, body: exchange.body, signal: exchange.signal, ...(new URL(exchange.url).pathname.endsWith("/messages") ? { redirect: "manual" as const } : {}) }); } catch (cause) {
      const failure = exchange.fail(cause);
      return error(failure.status, failure.code, failure.message);
    }
    try { return exchange.respond(upstream); } catch (cause) {
      const failure = cause instanceof PluginRequestError ? cause : exchange.fail(cause);
      return error(failure.status, failure.code, failure.message);
    }
  };

  return {
    config(config: OpenCodeConfig) {
      config.provider ??= {};
      const provider = config.provider["jev-router"] ??= { options: {}, models: {} };
      if (provider.npm !== undefined && provider.npm !== "@ai-sdk/openai") throw new Error("jev-router requires npm: @ai-sdk/openai");
      provider.options ??= {};
      if (!isRecord(provider.options)) throw new Error("jev-router provider options must be an object");
      if (provider.options.fetch !== undefined && provider.options.fetch !== adapter) throw new Error("jev-router provider fetch is managed by the plugin");
      if (options.upstreamApiKey !== undefined) requiredString(options.upstreamApiKey, "upstreamApiKey");
      if (provider.options.apiKey !== undefined) provider.options.apiKey = requiredString(provider.options.apiKey, "provider.options.apiKey");
      provider.options.baseURL ??= options.upstreamBaseURL;
      provider.options.apiKey ??= options.upstreamApiKey;
      provider.options.baseURL = upstreamBaseURL(provider.options.baseURL);
      provider.models ??= {};
      if (!isRecord(provider.models)) throw new Error("jev-router provider models must be an object");
      for (const profile of modelsFor("openai")) {
        const model = provider.models[profile.id] ??= {};
        const validated = validateModel(profile.id, model, adapter);
        validated.name ??= profile.name;
        validated.reasoning ??= true;
      }
      for (const [id, model] of Object.entries(provider.models)) validateModel(id, model, adapter);
      provider.npm = "@ai-sdk/openai"; provider.name ??= "Jev Router"; provider.options.fetch = adapter;
      if (options.anthropicUpstreamBaseURL !== undefined || options.anthropicUpstreamApiKey !== undefined || config.provider["jev-router-anthropic"] !== undefined) {
        const anthropic = config.provider["jev-router-anthropic"] ??= { options: {}, models: {} };
        if (anthropic.npm !== undefined && anthropic.npm !== "@ai-sdk/anthropic") throw new Error("jev-router-anthropic requires npm: @ai-sdk/anthropic");
        anthropic.options ??= {};
        if (!isRecord(anthropic.options)) throw new Error("jev-router-anthropic provider options must be an object");
        if (anthropic.options.fetch !== undefined && anthropic.options.fetch !== adapter) throw new Error("jev-router-anthropic provider fetch is managed by the plugin");
        if (options.anthropicUpstreamApiKey !== undefined) requiredString(options.anthropicUpstreamApiKey, "anthropicUpstreamApiKey");
        if (anthropic.options.apiKey !== undefined) anthropic.options.apiKey = requiredString(anthropic.options.apiKey, "provider.options.apiKey");
        anthropic.options.baseURL ??= options.anthropicUpstreamBaseURL ?? "https://api.anthropic.com/v1";
        anthropic.options.apiKey ??= options.anthropicUpstreamApiKey;
        anthropic.options.baseURL = upstreamBaseURL(anthropic.options.baseURL);
        anthropic.models ??= {};
        if (!isRecord(anthropic.models)) throw new Error("jev-router-anthropic provider models must be an object");
        for (const profile of modelsFor("anthropic")) {
          const model = anthropic.models[profile.id] ??= {};
          const validated = validateModel(profile.id, model, adapter, "@ai-sdk/anthropic");
          validated.name ??= profile.name;
          validated.reasoning ??= true;
        }
        for (const [id, model] of Object.entries(anthropic.models)) validateModel(id, model, adapter, "@ai-sdk/anthropic");
        anthropic.npm = "@ai-sdk/anthropic"; anthropic.name ??= "Jev Router Anthropic"; anthropic.options.fetch = adapter;
      }
    },
    async "chat.headers"(input: HeaderHook, output: { headers: Record<string, string> }) {
      if (![input.model.providerID, input.model.provider, input.provider.id].some((id) => id === "jev-router" || id === "jev-router-anthropic")) return;
      output.headers["x-jev-session-id"] ??= input.sessionID;
      if (!valid(output.headers["x-jev-turn-id"] ?? null, TURN)) output.headers["x-jev-turn-id"] = randomUUID();
    },
    dispose() { runtime.dispose(); },
  };
}
