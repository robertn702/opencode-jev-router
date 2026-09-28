import { randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { SessionHttpRequest, SessionHttpResponse } from "@opencode/plugin/promise/session";

import { modelsFor } from "./models.js";
import { createPluginRuntime, PluginRequestError, requiredString, SESSION, upstreamBaseURL, valid, type Exchange, type PluginOptions } from "./plugin-runtime.js";

type ProviderInput = Parameters<ProviderEditor["add"]>[0];

export const PROVIDER_ID = "jev-router";
/** Native OpenAI Responses runtime. */
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai/responses";

const rejection = (cause: unknown): Error => cause instanceof PluginRequestError
  ? new Error(`jev-router ${cause.code} (${cause.status}): ${cause.message}`)
  : new Error("jev-router upstream_unavailable (502): upstream_unavailable");

/**
 * OpenCode V2 `setup()` entrypoint. Registers the provider through a transform
 * and routes its native HTTP exchanges. User `providers["jev-router"]` config
 * overlays these defaults; the request hook still enforces the Responses route.
 */
export async function setupV2(ctx: Plugin.Context): Promise<() => void> {
  const options = ctx.options as PluginOptions;
  const baseURL = upstreamBaseURL(options.upstreamBaseURL, "upstreamBaseURL");
  const apiKey = options.upstreamApiKey === undefined ? undefined : requiredString(options.upstreamApiKey, "upstreamApiKey");
  const anthropicEnabled = options.anthropicUpstreamBaseURL !== undefined || options.anthropicUpstreamApiKey !== undefined;
  const runtime = createPluginRuntime(options);
  const exchanges = new WeakMap<Request, Exchange>();

  const models = [...modelsFor("openai"), ...(anthropicEnabled ? modelsFor("anthropic") : [])].map((profile): ProviderInput["models"][number] => ({
    id: profile.id as ProviderInput["models"][number]["id"], modelID: profile.id as ProviderInput["models"][number]["modelID"], providerID: PROVIDER_ID as ProviderInput["info"]["id"], name: profile.name,
    ...(profile.provider === "anthropic" ? { package: "@opencode/ai/providers/anthropic" } : {}),
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true,
    limit: { context: 200_000, output: 32_000 },
  }));
  const info: ProviderInput["info"] = {
    id: PROVIDER_ID as ProviderInput["info"]["id"], name: "Jev Router", activation: "enabled", package: PROVIDER_PACKAGE,
    // Providers with HTTP hooks stay on HTTP; pin it so every request is routed.
    settings: { baseURL, ...(apiKey === undefined ? {} : { apiKey }), transport: "http" },
  };
  await ctx.provider.transform((editor) => editor.add({ info, models }));

  const onRequest = async (event: SessionHttpRequest) => {
    const incoming = event.request;
    let exchange: Exchange;
    try { exchange = await runtime.start(incoming, { session: valid(event.sessionID, SESSION), turnId: randomUUID() }); } catch (cause) { throw rejection(cause); }
    const headers = new Headers(exchange.headers);
    headers.delete("content-length");
    const request = new Request(exchange.url, { method: "POST", headers, body: exchange.body, signal: exchange.signal, ...(new URL(exchange.url).pathname.endsWith("/messages") ? { redirect: "manual" as const } : {}) });
    incoming.signal.addEventListener("abort", () => exchange.cancel(), { once: true });
    exchanges.set(request, exchange);
    event.request = request;
  };

  const onResponse = (event: SessionHttpResponse) => {
    const exchange = exchanges.get(event.request);
    if (exchange === undefined) return;
    exchanges.delete(event.request);
    try { event.response = exchange.respond(event.response); } catch (cause) { throw rejection(cause); }
  };
  await ctx.session.hook("http.request", onRequest, { providerID: PROVIDER_ID });
  await ctx.session.hook("http.response", onResponse, { providerID: PROVIDER_ID });

  return () => runtime.dispose();
}
