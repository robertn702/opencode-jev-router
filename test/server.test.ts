import { once } from "node:events";
import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createAppServer } from "../src/server.js";

const servers = new Set<ReturnType<typeof createAppServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      server.close();
      await once(server, "close");
      servers.delete(server);
    }),
  );
});

async function startServer(): Promise<string> {
  const server = createAppServer();
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("scaffold server", () => {
  it("reports health", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("marks the Responses endpoint as unimplemented", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/v1/responses`, { method: "POST" });

    expect(response.status).toBe(501);
  });
});
