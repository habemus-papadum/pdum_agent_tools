import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createIsolatedProfile } from "../../014-claude-app-server/src/launch.js";
import { createManager } from "./server.js";

const output = process.argv[2];
assert(output && process.send, "Lifecycle child needs an output directory and IPC channel");
const outputDirectory = resolve(output);
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const profile = createIsolatedProfile(join(outputDirectory, "profile"));
const manager = await createManager({
  profiles: { a: profile }, outputDirectory: join(outputDirectory, "manager"),
  host: "127.0.0.1", heartbeatMs: 250,
});
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  closing ??= manager.close();
  return closing;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void close().then(() => { process.exitCode = 0; process.disconnect?.(); }); });
}
process.once("disconnect", () => { void close().then(() => { process.exitCode = 0; }); });
process.send({ type: "ready", url: manager.url, pid: process.pid });
