import http from "node:http";
import https from "node:https";
import type { ServerResponse } from "node:http";

import {
  buildUpstreamRequestHeaders,
  pickResponseHeaders,
} from "./headers.js";

export const UPSTREAM_UNAVAILABLE_BODY = JSON.stringify({
  error: "upstream_unavailable",
});

export interface UpstreamCall {
  method: string;
  url: URL;
  authorization: string | undefined;
  body: string | undefined;
  signal: AbortSignal;
}

export type UpstreamOutcome =
  | "forwarded"
  | "upstream_unavailable"
  | "mid_stream_failure"
  | "client_disconnected";

export function forwardUpstream(
  response: ServerResponse,
  call: UpstreamCall,
): Promise<UpstreamOutcome> {
  return new Promise((resolve) => {
    if (call.signal.aborted) {
      if (!response.writableEnded) {
        response.destroy();
      }
      resolve("client_disconnected");
      return;
    }

    let settled = false;
    let upstreamComplete = false;
    let headersForwarded = false;

    const settle = (outcome: UpstreamOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };

    const failMidStream = (): void => {
      response.destroy();
      settle("mid_stream_failure");
    };

    const transport = call.url.protocol === "https:" ? https : http;
    const upstreamRequest = transport.request(
      {
        protocol: call.url.protocol,
        hostname: call.url.hostname,
        port: call.url.port,
        path: `${call.url.pathname}${call.url.search}`,
        method: call.method,
        headers: buildUpstreamRequestHeaders(call.authorization, call.body),
      },
      (upstreamResponse) => {
        headersForwarded = true;
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          pickResponseHeaders(upstreamResponse.rawHeaders),
        );

        upstreamResponse.on("data", (chunk: Buffer) => {
          if (!response.write(chunk)) {
            upstreamResponse.pause();
            response.once("drain", () => upstreamResponse.resume());
          }
        });

        upstreamResponse.on("end", () => {
          upstreamComplete = true;
          response.end();
          settle(
            call.signal.aborted ? "client_disconnected" : "forwarded",
          );
        });

        upstreamResponse.on("error", () => {
          failMidStream();
        });

        upstreamResponse.on("close", () => {
          if (!upstreamComplete) {
            failMidStream();
          }
        });
      },
    );

    upstreamRequest.on("error", () => {
      if (headersForwarded) {
        failMidStream();
        return;
      }
      if (call.signal.aborted || response.destroyed) {
        settle("client_disconnected");
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(UPSTREAM_UNAVAILABLE_BODY);
      settle("upstream_unavailable");
    });

    call.signal.addEventListener(
      "abort",
      () => {
        upstreamRequest.destroy();
        if (!response.writableEnded) {
          response.destroy();
        }
        settle("client_disconnected");
      },
      { once: true },
    );

    upstreamRequest.end(call.body);
  });
}
