import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { query as browserQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/browser";
import { InputQueue } from "../../014-claude-app-server/src/clients.js";
import { createIsolatedProfile, resolvePinnedClaude, writeJson } from "../../014-claude-app-server/src/launch.js";
import { createManager, type WorkerStatus } from "./server.js";

const IDLE_MS = 58_000;

async function within<T>(promise: Promise<T>, label: string, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function state(base: string, id: string): Promise<WorkerStatus> {
  const response = await fetch(`${base}/api/workers/${id}`);
  assert(response.ok, `Worker status returned ${response.status}`);
  return response.json() as Promise<WorkerStatus>;
}

/** Observe the published browser SDK's own idle keep_alive interval against an actual native worker. */
export async function runIdleKeepAliveProbe(outputDirectory: string) {
  outputDirectory = resolve(outputDirectory);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const profile = createIsolatedProfile(join(mkdtempSync(join(outputDirectory, "isolated-")), "profile"));
  const manager = await createManager({ profiles: { a: profile }, outputDirectory: join(outputDirectory, "manager"),
    host: "127.0.0.1" });
  let worker: WorkerStatus | undefined;
  let session: ReturnType<typeof browserQuery> | undefined;
  let input: InputQueue<SDKUserMessage> | undefined;
  let drain: Promise<string | null> | undefined;
  const startedAt = new Date().toISOString();
  try {
    const created = await fetch(`${manager.url}/api/workers`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId: "a" }) });
    assert.equal(created.status, 201);
    worker = await created.json() as WorkerStatus;
    input = new InputQueue<SDKUserMessage>();
    session = browserQuery({ websocket: { url: worker.websocketUrl }, prompt: input });
    const active = session;
    drain = (async () => {
      try { for await (const _message of active) { /* Drain protocol frames; no prompt is queued. */ } return null; }
      catch (error) { return String(error); }
    })();
    const initialized = await within(session.initializationResult(), "Browser SDK initialization");
    assert.equal(initialized.account?.tokenSource, "none");
    assert.equal((await state(manager.url, worker.id)).status, "connected");
    const idleStarted = Date.now();
    await delay(IDLE_MS);
    const afterIdle = await state(manager.url, worker.id);
    assert.equal(afterIdle.status, "connected", "Raw keep_alive must not terminate the worker");
    await within(session.interrupt(), "Browser SDK interrupt after idle");
    const afterInterrupt = await state(manager.url, worker.id);
    assert.equal(afterInterrupt.status, "connected", "Interrupt control must still resolve after keep_alive");
    session.close(); input.close();
    await within(drain, "Browser SDK close");
    const deadline = Date.now() + 8_000;
    while ((await state(manager.url, worker.id)).status !== "stopped") {
      if (Date.now() > deadline) throw new Error("Worker did not stop after browser SDK disconnect");
      await delay(50);
    }
    const capture = readFileSync(join(outputDirectory, "manager", worker.id, "relay-input.ndjson"), "utf8");
    const lines = capture.split("\n").filter(Boolean);
    const frames = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    const keepAlive = frames.filter(frame => frame.type === "keep_alive");
    const result = {
      status: keepAlive.length > 0 ? "pass" : "no-keep-alive-observed",
      startedAt, endedAt: new Date().toISOString(), idleMs: Date.now() - idleStarted,
      expectedIdleMs: IDLE_MS, workerId: worker.id, nativePid: worker.pid,
      SDK: resolvePinnedClaude().sdkVersion, native: resolvePinnedClaude().claudeCodeVersion,
      keepAliveFrames: keepAlive.length, rawFrameTypes: frames.map(frame => frame.type),
      afterIdleStatus: afterIdle.status, afterInterruptStatus: afterInterrupt.status,
      modelRequests: 0,
    };
    writeJson(join(outputDirectory, "result.json"), result);
    assert(keepAlive.length > 0, "No published SDK keep_alive was observed in the 58-second idle window");
    return result;
  } finally {
    session?.close(); input?.close();
    if (drain) await Promise.race([drain, delay(1000)]);
    await manager.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const output = process.argv[2] ?? "artifacts/016-claude-client-sessions/keepalive-new-run";
  runIdleKeepAliveProbe(output).then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
