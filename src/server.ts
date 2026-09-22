import { createServer, type Server, type ServerResponse } from "node:http";

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createAppServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    writeJson(response, 501, {
      error: "not_implemented",
      message: "The adaptive Responses proxy has not been implemented yet.",
    });
  });
}
