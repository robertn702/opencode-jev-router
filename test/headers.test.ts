import { describe, expect, it } from "vitest";

import {
  buildUpstreamRequestHeaders,
  pickResponseHeaders,
} from "../src/headers.js";

describe("pickResponseHeaders", () => {
  it("keeps only the allowlisted response headers", () => {
    const picked = pickResponseHeaders([
      "Content-Type", "text/event-stream",
      "Cache-Control", "no-cache",
      "Retry-After", "7",
      "X-Request-Id", "req-1",
      "ETag", '"abc"',
      "Content-Length", "123",
      "Content-Encoding", "gzip",
      "Server", "test",
    ]);

    expect(picked).toEqual({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "retry-after": "7",
      "x-request-id": "req-1",
    });
  });

  it("excludes headers nominated by the upstream Connection header", () => {
    const picked = pickResponseHeaders([
      "Connection", "x-request-id, keep-alive",
      "X-Request-Id", "req-2",
      "Content-Type", "application/json",
    ]);

    expect(picked).toEqual({ "content-type": "application/json" });
  });

  it("omits hop-by-hop and framing headers", () => {
    const picked = pickResponseHeaders([
      "Connection", "keep-alive",
      "Keep-Alive", "timeout=5",
      "Transfer-Encoding", "chunked",
      "Trailer", "Expires",
      "Upgrade", "h2c",
      "Content-Length", "999",
    ]);

    expect(picked).toEqual({});
  });
});

describe("buildUpstreamRequestHeaders", () => {
  it("computes fresh framing for the rewritten body and never reuses incoming framing", () => {
    const body = JSON.stringify({ input: [], model: "gpt-6-astra" });
    const headers = buildUpstreamRequestHeaders("Bearer secret", body);

    expect(headers.authorization).toBe("Bearer secret");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["content-length"]).toBe(
      String(Buffer.byteLength(body)),
    );
    expect(headers["transfer-encoding"]).toBeUndefined();
  });

  it("omits content-length when there is no body", () => {
    const headers = buildUpstreamRequestHeaders("Bearer secret", undefined);

    expect(headers["content-length"]).toBeUndefined();
  });
});
