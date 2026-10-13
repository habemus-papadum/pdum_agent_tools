import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { Event, Frame, SessionCore } from "./manager.js";

/** NDJSON envelope adapter. EOF detaches the connection and leaves the worker running. */
export function attachStdio(core: SessionCore, input: Readable, output: Writable, owner: string): () => void {
  const peer = core.attach({ role: "controller", owner, deliver(event) {
    return new Promise<void>((resolve, reject) => output.write(`${JSON.stringify(event)}\n`, error => error ? reject(error) : resolve()));
  } });
  output.write(`${JSON.stringify({ snapshot: { workerId: core.workerId, pendingCallbacks: peer.pending } })}\n`);
  const lines = createInterface({ input });
  lines.on("line", line => {
    try {
      const receipt = peer.send(JSON.parse(line) as Frame);
      if (receipt) output.write(`${JSON.stringify({ receipt })}\n`);
    } catch (error) { output.write(`${JSON.stringify({ error: String(error) })}\n`); }
  });
  lines.on("close", peer.detach);
  return () => { lines.close(); peer.detach(); };
}

/** Application envelope WebSocket adapter; raw SDK clients use the separate launch relay. */
export async function serveSession(core: SessionCore, host = "0.0.0.0"): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new WebSocketServer({ host, port: 0, maxPayload: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  server.on("connection", (socket, request) => {
    const params = new URL(request.url!, "http://localhost").searchParams;
    let peer: ReturnType<SessionCore["attach"]>;
    try {
      peer = core.attach({
        role: params.get("role") === "controller" ? "controller" : "observer",
        owner: params.get("owner") ?? "web-controller",
        ...(params.get("role") !== "controller" ? { maxPending: 256 } : {}),
        ...(params.has("cursor") ? { cursor: Number(params.get("cursor")) } : {}),
        deliver(event: Event) {
          return new Promise<void>((resolve, reject) => {
            if (socket.readyState !== WebSocket.OPEN) { reject(new Error("socket closed")); return; }
            socket.send(`${JSON.stringify(event)}\n`, error => error ? reject(error) : resolve());
          });
        },
        disconnected(reason) { socket.close(1000, reason); },
      });
    } catch (error) { socket.close(1008, String(error).slice(0,120)); return; }
    socket.send(JSON.stringify({ snapshot: { workerId: core.workerId, pendingCallbacks: peer.pending } }));
    socket.on("message", data => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        try {
          const receipt = peer.send(JSON.parse(line) as Frame);
          if (receipt) socket.send(JSON.stringify({ receipt }));
        } catch (error) { socket.send(JSON.stringify({ error: String(error) })); }
      }
    });
    socket.on("close", peer.detach);
    socket.on("error", peer.detach);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  return { url: `ws://127.0.0.1:${address.port}`, close: async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
