import { randomUUID } from "node:crypto";

import { modelsFor } from "./models.js";
import { createPluginRuntime, PluginRequestError, requiredString, SESSION, upstreamBaseURL, valid, type Exchange, type PluginOptions } from "./plugin-runtime.js";

/**
 * The subset of the OpenCode V2 `@opencode/plugin` context this plugin uses,
 * checked against OpenCode 2.0.18. It is declared structurally so the package
 * has no runtime or type dependency on the V2 SDK and still loads in V1.
 */
export interface V2Context {
  readonly options: Readonly<Record<string, unknown>>;
  readonly provider: { transform(callback: (editor: V2ProviderEditor) => void): Promise<unknown> };
  readonly session: {
    hook(name: "http.request", callback: (event: V2HttpRequest) => Promise<void> | void, options: { providerID: string }): Promise<unknown>;
    hook(name: "http.response", callback: (event: V2HttpResponse) => Promise<void> | void, options: { providerID: string }): Promise<unknown>;
  };
}
export interface V2ProviderEditor { add(input: { info: V2ProviderInfo; models: readonly V2ModelInfo[] }): void; get?(providerID: string): unknown }
export interface V2ProviderInfo { id: string; name: string; activation: "auto" | "enabled" | "disabled"; package: string; settings?: Record<string, unknown> }
export interface V2ModelInfo {
  id: string; modelID: string; providerID: string; name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: unknown[]; time: { released: number }; cost: unknown[];
  status: "alpha" | "beta" | "deprecated" | "active"; enabled: boolean;
  limit: { context: number; output: number };
}
export interface V2HttpRequest { readonly sessionID: string; readonly kind: string; request: Request }
export interface V2HttpResponse { readonly sessionID: string; readonly kind: string; readonly request: Request; response: Response }

export const PROVIDER_ID = "jev-router";
/** Native OpenAI Responses runtime, the V2 counterpart of V1 `@ai-sdk/openai` with `useResponses`. */
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai/responses";
export const ANTHROPIC_PROVIDER_ID = "jev-router-anthropic";
/** OpenCode 2.0.18 native Anthropic provider exports the Anthropic Messages route. */
export const ANTHROPIC_PROVIDER_PACKAGE = "@opencode/ai/providers/anthropic";

const rejection = (cause: unknown): Error => cause instanceof PluginRequestError
  ? new Error(`jev-router ${cause.code} (${cause.status}): ${cause.message}`)
  : new Error("jev-router upstream_unavailable (502): upstream_unavailable");

/**
 * OpenCode V2 `setup()` entrypoint. Registers the provider through a transform
 * and routes its native HTTP exchanges. User `providers["jev-router"]` config
 * overlays these defaults; the request hook still enforces the Responses route.
 */
export async function setupV2(ctx: V2Context): Promise<() => void> {
  const options = ctx.options as PluginOptions;
  const baseURL = upstreamBaseURL(options.upstreamBaseURL, "upstreamBaseURL");
  const apiKey = options.upstreamApiKey === undefined ? undefined : requiredString(options.upstreamApiKey, "upstreamApiKey");
  const anthropicEnabled = options.anthropicUpstreamBaseURL !== undefined || options.anthropicUpstreamApiKey !== undefined;
  const anthropicBaseURL = anthropicEnabled ? upstreamBaseURL(options.anthropicUpstreamBaseURL ?? "https://api.anthropic.com/v1") : undefined;
  const anthropicApiKey = options.anthropicUpstreamApiKey === undefined ? undefined : requiredString(options.anthropicUpstreamApiKey, "anthropicUpstreamApiKey");
  const runtime = createPluginRuntime(options);
  const exchanges = new WeakMap<Request, Exchange>();

  const models = modelsFor("openai").map((profile): V2ModelInfo => ({
    id: profile.id, modelID: profile.id, providerID: PROVIDER_ID, name: profile.name,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true,
    limit: { context: 200_000, output: 32_000 },
  }));
  const info: V2ProviderInfo = {
    id: PROVIDER_ID, name: "Jev Router", activation: "enabled", package: PROVIDER_PACKAGE,
    // Providers with HTTP hooks stay on HTTP; pin it so every request is routed.
    settings: { baseURL, ...(apiKey === undefined ? {} : { apiKey }), transport: "http" },
  };
  await ctx.provider.transform((editor) => editor.add({ info, models }));
  let registerAnthropic = anthropicEnabled;
  await ctx.provider.transform((editor) => {
    registerAnthropic ||= editor.get?.(ANTHROPIC_PROVIDER_ID) !== undefined;
    if (!registerAnthropic) return;
    const models = modelsFor("anthropic").map((profile): V2ModelInfo => ({
      id: profile.id, modelID: profile.id, providerID: ANTHROPIC_PROVIDER_ID, name: profile.name,
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true,
      limit: { context: 200_000, output: 32_000 },
    }));
    editor.add({ info: { id: ANTHROPIC_PROVIDER_ID, name: "Jev Router Anthropic", activation: "enabled", package: ANTHROPIC_PROVIDER_PACKAGE,
      settings: { baseURL: anthropicBaseURL ?? "https://api.anthropic.com/v1", ...(anthropicApiKey === undefined ? {} : { apiKey: anthropicApiKey }), transport: "http" } }, models });
  });

  const onRequest = async (event: V2HttpRequest) => {
    const incoming = event.request;
    let exchange: Exchange;
    try { exchange = await runtime.start(incoming, { session: valid(event.sessionID, SESSION), turnId: randomUUID() }); } catch (cause) { throw rejection(cause); }
    const headers = new Headers(exchange.headers);
    headers.delete("content-length");
    const request = new Request(exchange.url, { method: "POST", headers, body: exchange.body, signal: exchange.signal });
    incoming.signal.addEventListener("abort", () => exchange.cancel(), { once: true });
    exchanges.set(request, exchange);
    event.request = request;
  };

  const onResponse = (event: V2HttpResponse) => {
    const exchange = exchanges.get(event.request);
    if (exchange === undefined) return;
    exchanges.delete(event.request);
    try { event.response = exchange.respond(event.response); } catch (cause) { throw rejection(cause); }
  };
  for (const providerID of registerAnthropic ? [PROVIDER_ID, ANTHROPIC_PROVIDER_ID] : [PROVIDER_ID]) {
    await ctx.session.hook("http.request", onRequest, { providerID });
    await ctx.session.hook("http.response", onResponse, { providerID });
  }

  return () => runtime.dispose();
}
