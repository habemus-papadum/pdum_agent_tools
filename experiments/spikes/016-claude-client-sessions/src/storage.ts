import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { IsolatedProfile } from "../../014-claude-app-server/src/launch.js";

/** One fixed profile environment per helper. Only official SDK storage operations. */
export class ProfileStorage {
  private child;
  private nextId = 0;
  private closed: Promise<void>;
  readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  constructor(profile: IsolatedProfile) {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const helper = new URL(`./storage-helper.${extension}`, import.meta.url);
    const require = createRequire(import.meta.url);
    this.child = spawn(process.execPath, [
      ...(extension === "ts" ? ["--import", require.resolve("tsx")] : []), helper.pathname,
    ], {
      cwd: profile.workDirectory,
      // Storage needs no model credentials. Do not pass borrowed login material to it.
      env: Object.fromEntries(Object.entries({
        ...profile.environment, SPIKE_STORAGE_HELPER: "1", SPIKE_STORAGE_WORK: profile.workDirectory,
      }).filter(([key]) => !/TOKEN|API_KEY|SECRET|PASSWORD/.test(key))),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.child.on("error", () => {});
    this.child.stdin.on("error", () => {});
    this.closed = new Promise(done => this.child.once("close", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer); request.reject(new Error("Storage helper exited"));
      }
      this.pending.clear(); done();
    }));
    createInterface({ input: this.child.stdout }).on("line", line => {
      const response = JSON.parse(line) as {id:number;ok:boolean;result?:unknown;error?:string};
      const request = this.pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(response.id);
      if (response.ok) request.resolve(response.result);
      else request.reject(new Error(response.error ?? "Storage request failed"));
    });
  }

  get alive(): boolean { return this.child.exitCode === null && this.child.signalCode === null; }

  async call<T>(operation: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("Storage helper stopped");
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Storage helper timed out")); }, 15_000);
      this.pending.set(id, {resolve: value => resolve(value as T), reject, timer});
      this.child.stdin.write(JSON.stringify({id, operation, ...fields}) + "\n");
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}
