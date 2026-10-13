import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { query as nodeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { query as officialBrowserQuery, type BrowserQueryOptions } from "@anthropic-ai/claude-agent-sdk/browser";
import type { IsolatedProfile } from "./launch.js";

export class InputQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;
  push(value: T): void {
    if (this.closed) throw new Error("Input queue closed");
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); }
    else this.values.push(value);
  }
  close(): void { this.closed = true; this.waiter?.({ value: undefined, done: true }); this.waiter = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: async () => {
      const value = this.values.shift();
      if (value !== undefined) return { value, done: false };
      if (this.closed) return { value: undefined, done: true };
      return new Promise<IteratorResult<T>>((done) => { this.waiter = done; });
    } };
  }
}

export function userMessage(text: string, sessionId = ""): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() };
}

export function browserQuery(
  url: string,
  prompt: AsyncIterable<SDKUserMessage>,
  options: Omit<BrowserQueryOptions, "prompt" | "websocket" | "sse"> = {},
) {
  return officialBrowserQuery({ ...options, prompt, websocket: { url } });
}

/** A connection lifetime impersonates a process lifetime; kill/EOF detach only this connection. */
export function createVirtualProcess(url: string): SpawnedProcess & { socket: WebSocket; detach(): void } {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const socket = new WebSocket(url);
  let killed = false;
  let exitCode: number | null = null;
  let exited = false;
  const pending: Array<{ chunk: string; callback: (error?: Error | null) => void }> = [];
  function exit(code: number): void {
    if (exited) return;
    exited = true;
    exitCode = code;
    stdout.end();
    for (const item of pending.splice(0)) item.callback(new Error("Connection ended before ready"));
    events.emit("exit", code, null);
  }
  function detach(): void {
    if (exited) return;
    killed = true;
    // Node SDK schedules SIGTERM after stdin EOF. Reporting virtual exit cancels that path.
    exit(0);
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "SDK controller detached");
    else socket.addEventListener("open", () => socket.close(1000, "SDK controller detached"), { once: true });
  }
  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = chunk.toString();
      if (exited) { callback(new Error("Controller detached")); return; }
      if (socket.readyState === WebSocket.OPEN) { socket.send(text); callback(); }
      else pending.push({ chunk: text, callback });
    },
    final(callback) { detach(); callback(); },
  });
  socket.addEventListener("open", () => {
    if (exited) { socket.close(); return; }
    for (const item of pending.splice(0)) { socket.send(item.chunk); item.callback(); }
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") stdout.write(event.data);
  });
  socket.addEventListener("error", () => {
    const error = new Error("Virtual process WebSocket failed");
    // SpawnedProcess consumers subscribe synchronously after this constructor returns.
    events.emit("error", error);
    exit(1);
  });
  socket.addEventListener("close", (event) => exit(event.code === 1000 || event.code === 1001 ? 0 : 1));
  return {
    stdin, stdout, socket, detach,
    get killed() { return killed; }, get exitCode() { return exitCode; }, get signalCode() { return null; },
    kill() { detach(); return true; },
    on: events.on.bind(events), once: events.once.bind(events), off: events.off.bind(events),
  };
}

export function virtualNodeQuery(
  url: string,
  prompt: AsyncIterable<SDKUserMessage>,
  profile: IsolatedProfile,
  options: Partial<Options> = {},
) {
  let virtual: ReturnType<typeof createVirtualProcess> | undefined;
  const session = nodeQuery({
    prompt,
    options: {
      cwd: profile.workDirectory, env: profile.environment, model: profile.model,
      settingSources: [], strictMcpConfig: true, tools: [], ...options,
      spawnClaudeCodeProcess() { virtual = createVirtualProcess(url); return virtual; },
    },
  });
  return { session, get virtual() { return virtual; } };
}
