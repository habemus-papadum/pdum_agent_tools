import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

/** Adapt a relay connection to the official SDK's public SpawnedProcess interface.
 * No protocol messages are parsed or synthesized; lifecycle and byte streams only.
 */
export function remoteProcess(url) {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const socket = new WebSocket(url);
  const pending = [];
  let exitCode = null;
  let killed = false;

  function exited(code) {
    if (exitCode !== null) return;
    exitCode = code;
    stdout.end();
    for (const item of pending.splice(0)) item.callback(new Error("Connection closed before ready"));
    events.emit("exit", code, null);
  }

  function close() {
    if (exitCode !== null) return;
    killed = true;
    exited(0);
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "SDK session ended");
    else socket.addEventListener("open", () => socket.close(1000, "SDK session ended"), { once: true });
  }

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      if (exitCode !== null) { callback(new Error("SDK session ended")); return; }
      const text = chunk.toString();
      if (socket.readyState === WebSocket.OPEN) { socket.send(text); callback(); }
      else pending.push({ text, callback });
    },
    final(callback) { close(); callback(); },
  });
  socket.addEventListener("open", () => {
    if (exitCode !== null) { socket.close(); return; }
    for (const item of pending.splice(0)) { socket.send(item.text); item.callback(); }
  });
  socket.addEventListener("message", event => {
    if (typeof event.data === "string") stdout.write(event.data);
  });
  socket.addEventListener("close", event => exited(event.code === 1000 || event.code === 1001 ? 0 : 1));
  socket.addEventListener("error", () => {
    events.emit("error", new Error("Claude relay WebSocket failed"));
    exited(1);
  });
  return {
    stdin, stdout,
    get killed() { return killed; }, get exitCode() { return exitCode; }, get signalCode() { return null; },
    kill() { close(); return true; },
    on: events.on.bind(events), once: events.once.bind(events), off: events.off.bind(events),
  };
}
