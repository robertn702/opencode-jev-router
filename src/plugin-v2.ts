import { randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { SessionHttpRequest, SessionHttpResponse } from "@opencode/plugin/promise/session";

import { MODELS, modelsFor, type Provider } from "./models.js";
import { createPluginRuntime, isRecord, PluginRequestError, SESSION, valid, type Exchange, type PluginOptions } from "./plugin-runtime.js";

type ProviderInput = Parameters<ProviderEditor["add"]>[0];
type ModelInput = ProviderInput["models"][number];
type Alias = { group: Provider; providerID: string; integrationID: string; authHeader: "authorization" | "x-api-key" };

export const PROVIDER_ID = "jev-router";
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai/responses";
const PACKAGES = { openai: PROVIDER_PACKAGE, anthropic: "@opencode/ai/providers/anthropic" };

const rejection = (cause: unknown): Error => cause instanceof PluginRequestError
  ? new Error(`jev-router ${cause.code} (${cause.status}): ${cause.message}`)
  : new Error("jev-router upstream_unavailable (502): upstream_unavailable");

function parseWrap(options: Record<string, unknown>): { group: Provider; providerID: string; modelID: string; ref: string }[] {
  for (const key of ["upstreamBaseURL", "upstreamApiKey", "anthropicUpstreamBaseURL", "anthropicUpstreamApiKey"]) {
    if (key in options) throw new Error(`jev-router: ${key} was removed; configure wrap instead`);
  }
  if (!isRecord(options.wrap) || !Object.keys(options.wrap).length) throw new Error("jev-router: wrap must be a nonempty object of openai/anthropic model refs");
  const refs: ReturnType<typeof parseWrap> = [];
  for (const [group, values] of Object.entries(options.wrap)) {
    if (!(group in PACKAGES)) throw new Error(`jev-router: unknown wrap group ${group}`);
    if (!Array.isArray(values) || !values.length) throw new Error(`jev-router: wrap.${group} must be a nonempty array of provider/model refs`);
    for (const ref of values) {
      if (typeof ref !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(ref) || ref.startsWith(`${PROVIDER_ID}/`)) throw new Error(`jev-router: wrap.${group} requires provider/model refs from another provider`);
      const [providerID, modelID] = ref.split("/") as [string, string];
      refs.push({ group: group as Provider, providerID, modelID, ref });
    }
  }
  return refs;
}

export async function setupV2(ctx: Plugin.Context): Promise<() => void> {
  const options = ctx.options as PluginOptions & Record<string, unknown>;
  const refs = parseWrap(options);
  const runtime = createPluginRuntime(options);
  const exchanges = new WeakMap<Request, Exchange>();
  let aliases = new Map<string, Alias>();
  let validationError: string | undefined;

  await ctx.provider.transform((editor) => {
    const models = [...new Set(refs.map((ref) => ref.group))].flatMap((group) => modelsFor(group).map((profile): ModelInput => ({
      id: profile.id as ModelInput["id"], modelID: profile.id as ModelInput["modelID"], providerID: PROVIDER_ID as ModelInput["providerID"], name: profile.name, package: PACKAGES[group],
      settings: { baseURL: "http://127.0.0.1:1/v1" }, capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 },
    })));
    editor.add({ info: { id: PROVIDER_ID as ProviderInput["info"]["id"], name: "Jev Router", activation: "enabled", package: PROVIDER_PACKAGE, settings: { transport: "http" } }, models });
  });

  await ctx.model.transform((editor) => {
    const next = new Map<string, Alias>();
    const errors: string[] = [];
    for (const { group, providerID, modelID, ref } of refs) {
      const source = editor.get(providerID, modelID);
      const provider = editor.provider.get(providerID)?.provider;
      const apiID = source?.modelID ?? source?.id ?? modelID;
      const profile = MODELS.find((model) => model.id === apiID && model.provider === group);
      const error = !source || !provider ? `jev-router: source model ${ref} not found; check wrap`
        : !profile ? `jev-router: ${ref} API model ${apiID} is not a registered ${group} profile`
        : (source.package ?? provider.package) !== PACKAGES[group] ? `jev-router: ${ref} requires package ${PACKAGES[group]}`
        : next.has(profile.id) ? `jev-router: duplicate wrap profile ${profile.id}` : undefined;
      if (error) errors.push(error);
      if (!profile) continue;
      const id = profile.id;
      if (next.has(id)) continue;
      next.set(id, { group, providerID, integrationID: provider?.integrationID ?? providerID, authHeader: group === "openai" ? "authorization" : "x-api-key" });
      if (error) continue;
      const resolved = provider!;
      const settings = { ...resolved.settings, ...source!.settings };
      delete settings.transport;
      editor.update(PROVIDER_ID, id, (alias) => Object.assign(alias, {
        ...source, id, modelID: apiID, providerID: PROVIDER_ID, package: source!.package ?? resolved.package,
        name: profile!.name, transport: "http", settings, headers: { ...resolved.headers, ...source!.headers },
        body: { ...resolved.body, ...source!.body }, variants: [],
      }));
    }
    if (!errors.length) for (const profile of MODELS) if (!next.has(profile.id)) editor.remove(PROVIDER_ID, profile.id);
    aliases = next;
    validationError = errors.length ? errors.join("; ") : undefined;
  });

  const onRequest = async (event: SessionHttpRequest) => {
    if (validationError) throw new Error(validationError);
    const alias = aliases.get(event.model.id);
    if (!alias) throw new Error(`jev-router: alias ${event.model.id} is not configured in wrap`);
    const incoming = event.request;
    const authHeader = alias.authHeader;
    if (!incoming.headers.get(authHeader)) {
      const connection = await ctx.integration.connection.active(alias.integrationID);
      const credential = connection && await ctx.integration.connection.resolve(connection);
      if (credential?.type === "oauth") throw new Error(`jev-router: ${alias.providerID} uses OAuth, which wrap does not support yet; use an API key`);
      if (credential?.type === "key") incoming.headers.set(authHeader, alias.group === "openai" ? `Bearer ${credential.key}` : credential.key);
    }
    if (!incoming.headers.get(authHeader)) throw new Error(`jev-router: ${alias.providerID} has no API key; configure a source provider API key`);
    if (event.kind !== "primary") return;
    const pathname = new URL(incoming.url).pathname;
    if (pathname.endsWith(alias.group === "openai" ? "/messages" : "/responses")) throw new Error(`jev-router invalid_request (400): alias requires ${alias.group === "openai" ? "/responses" : "/messages"}`);
    if (!pathname.endsWith(alias.group === "openai" ? "/responses" : "/messages")) return;
    let exchange: Exchange;
    try { exchange = await runtime.start(incoming, { session: valid(event.sessionID, SESSION), turnId: randomUUID() }, alias.group); } catch (cause) { throw rejection(cause); }
    const outgoing = new Headers(exchange.headers);
    outgoing.delete("content-length");
    const request = new Request(exchange.url, { method: "POST", headers: outgoing, body: exchange.body, signal: exchange.signal, ...(alias.group === "anthropic" ? { redirect: "manual" as const } : {}) });
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
  try {
    await ctx.session.hook("experimental.ws.handshake", () => { throw new Error('jev-router requires transport: http; remove providers["jev-router"].settings.transport'); }, { providerID: PROVIDER_ID });
  } catch { /* Older hosts may not expose the experimental hook. */ }

  return () => runtime.dispose();
}
