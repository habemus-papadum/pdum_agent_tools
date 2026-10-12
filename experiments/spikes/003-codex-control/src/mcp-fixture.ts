import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line) as { id?: number | string; method: string };
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "spike-fixture", version: "1" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "fixture_ping", description: "Inert scope-test fixture", inputSchema: { type: "object", properties: {} } }] }
      : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
