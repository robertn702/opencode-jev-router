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
