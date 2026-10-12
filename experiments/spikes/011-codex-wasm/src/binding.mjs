import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

export async function runBinding(wasmPath) {
  const expected = "rust-wasm-local-probe";
  const events = [];
  const sockets = new Set();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 6) return;
      const length = pending[1] & 127;
      if (length >= 126 || !(pending[1] & 128) || (pending[0] & 15) !== 1) return socket.destroy();
      if (pending.length < 6 + length) return;
      const payload = Buffer.from(pending.subarray(6, 6 + length));
      for (let index = 0; index < payload.length; index++) payload[index] ^= pending[2 + index % 4];
      events.push({ event: "server_received", text: payload.toString("utf8") });
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      pending = Buffer.alloc(0);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/fixture`;
  let websocket;
  let instance;
  let timer;
  try {
    const completion = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("WASM WebSocket binding timed out")), 5000);
      const imports = {
        host: {
          open_socket() {
            events.push({ event: "wasm_called_open" });
            websocket = new WebSocket(url);
            websocket.addEventListener("open", () => instance.exports.on_open(), { once: true });
            websocket.addEventListener("error", () => reject(new Error("Host WebSocket failed")), { once: true });
            websocket.addEventListener("message", event => {
              events.push({ event: "host_received", text: event.data });
              resolve(event.data);
            }, { once: true });
          },
          send_text(pointer, length) {
            const text = new TextDecoder().decode(new Uint8Array(instance.exports.memory.buffer, pointer, length));
            events.push({ event: "wasm_called_send", text });
            websocket.send(text);
          },
        },
      };
      readFile(wasmPath)
        .then(bytes => WebAssembly.instantiate(bytes, imports))
        .then(module => { instance = module.instance; instance.exports.start(); })
        .catch(reject);
    });
    assert.equal(await completion, expected);
    assert.ok(events.some(event => event.event === "server_received" && event.text === expected));
    return { success: true, host: "Node built-in WebSocket", browserTested: false, codexEngineIncluded: false, fixtureUrl: url, events };
  } finally {
    clearTimeout(timer);
    websocket?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
