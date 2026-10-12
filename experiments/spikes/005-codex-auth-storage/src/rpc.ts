import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const sanitize = (value: unknown): string => JSON.stringify(value, (key, item: unknown) =>
  /apiKey|accessToken|refreshToken|idToken|authUrl|email/i.test(key) ? "[REDACTED]" : item);

export class Rpc {
  readonly events: Message[] = [];
  readonly child;
  private readonly lines;
  private readonly closed;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly transcript: string[] = [];
  private stderr = "";
  private nextId = 1;

  constructor(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, private readonly output: string) {
    this.child = spawn(binary, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise<void>((done) => this.child.once("close", () => done()));
    this.lines = createInterface({ input: this.child.stdout });
    this.child.once("error", (error) => this.rejectPending(error));
    this.child.once("close", () => this.rejectPending(new Error("App-server closed")));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-1_048_576); });
    this.lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as Message;
        this.transcript.push(sanitize({ direction: "server", message }));
        if (message.method && message.id !== undefined) {
          this.send({ id: message.id, error: { code: -32601, message: "This fixture probe declines server requests" } });
        } else if (message.id !== undefined) {
          const request = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) request?.reject(new Error(sanitize(message.error)));
          else request?.resolve(message.result);
        } else {
          this.events.push(message);
        }
      } catch {
        this.rejectPending(new Error("Invalid protocol response"));
      }
    });
  }

  private rejectPending(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  send(message: unknown) {
    this.transcript.push(sanitize({ direction: "client", message }));
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request<Result = Record<string, unknown>>(method: string, params: unknown = {}): Promise<Result> {
    const id = this.nextId++;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<unknown>((resolveRequest, reject) => {
        timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 20_000);
        this.pending.set(id, { resolve: resolveRequest, reject });
        this.send({ id, method, params });
      }) as Result;
    } finally {
      clearTimeout(timer);
    }
  }

  async wait(method: string, predicate: (params: Record<string, unknown>) => boolean = () => true) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const event = this.events.find((item) => item.method === method && item.params && predicate(item.params));
      if (event?.params) return event.params;
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("App-server exited while waiting");
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(`${method} notification timed out`);
  }

  async close() {
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), 2_000);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 4_000);
    await this.closed;
    clearTimeout(terminate);
    clearTimeout(kill);
    this.lines.close();
    await writeFile(join(this.output, "level-1.jsonl"), this.transcript.join("\n") + "\n", { mode: 0o600 });
    await writeFile(join(this.output, "stderr.log"), this.stderr, { mode: 0o600 });
  }
}
