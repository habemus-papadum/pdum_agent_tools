import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { ManagementError, OrchestratorClient } from "../src/index.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

it("uses actual HTTP, targets stop identity and never retries an unknown mutation", async () => {
  let requests = 0;
  const baseUrl = await listen(async (req, res) => {
    requests++;
    if (req.url === "/api/runs") {
      res.end('{"runs":[]}');
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    expect(JSON.parse(Buffer.concat(parts).toString())).toEqual({ instanceId: "target" });
    res.writeHead(500);
    res.end("Stop outcome unavailable");
  });
  const client = new OrchestratorClient({ baseUrl });
  expect(requests).toBe(0);
  expect(await client.runs()).toEqual({ runs: [] });
  await expect(client.stop("target")).rejects.toMatchObject({ outcome: "unknown", status: 500 });
  expect(requests).toBe(2);
});
it("distinguishes pre-send cancellation, rejected identity and incompatible API", async () => {
  let requests = 0;
  const baseUrl = await listen((req, res) => {
    requests++;
    if (req.url === "/api/status") res.end('{"apiVersion":"future"}');
    else {
      res.writeHead(409);
      res.end("Wrong instance");
    }
  });
  const client = new OrchestratorClient({ baseUrl });
  await expect(client.runs({ signal: AbortSignal.abort() })).rejects.toMatchObject({
    outcome: "not-sent",
  });
  expect(requests).toBe(0);
  await expect(client.stop("target")).rejects.toMatchObject({ outcome: "rejected", status: 409 });
  await expect(client.status()).rejects.toBeInstanceOf(ManagementError);
});
