const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "cache-control",
  "retry-after",
  "x-request-id",
]);

export function pickResponseHeaders(
  rawHeaders: readonly string[],
): Record<string, string> {
  const excluded = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === "connection") {
      for (const token of (rawHeaders[i + 1] ?? "").split(",")) {
        excluded.add(token.trim().toLowerCase());
      }
    }
  }

  const picked: Record<string, string> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]?.toLowerCase();
    if (name !== undefined && ALLOWED_RESPONSE_HEADERS.has(name) && !excluded.has(name)) {
      picked[name] = rawHeaders[i + 1] ?? "";
    }
  }
  return picked;
}

export function pickFetchResponseHeaders(headers: Headers): Headers {
  const excluded = new Set((headers.get("connection") ?? "").split(",").map((token) => token.trim().toLowerCase()));
  const picked = new Headers();
  for (const [name, value] of headers) if (ALLOWED_RESPONSE_HEADERS.has(name) && !excluded.has(name)) picked.set(name, value);
  return picked;
}

export function buildUpstreamRequestHeaders(
  authorization: string | undefined,
  body: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "*/*",
    "accept-encoding": "identity",
  };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return headers;
}

/** Fetch adapter variant: retain provider credentials and configured OpenAI headers. */
export function buildPluginUpstreamRequestHeaders(incoming: Headers, body: string): Headers {
  const headers = new Headers(incoming);
  const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
  for (const token of (headers.get("connection") ?? "").split(",")) hopByHop.add(token.trim().toLowerCase());
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (hopByHop.has(lower) || lower === "content-length" || lower === "content-encoding" || lower === "x-jev-session-id" || lower === "x-jev-turn-id" || lower === "x-opencode-session-id" || lower === "x-opencode-turn-id") headers.delete(name);
  }
  headers.set("content-type", "application/json");
  headers.set("content-length", String(Buffer.byteLength(body)));
  return headers;
}
