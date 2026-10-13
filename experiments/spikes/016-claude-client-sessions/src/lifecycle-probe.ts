import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { query as browserQuery, type BrowserQueryOptions } from "@anthropic-ai/claude-agent-sdk/browser";
import WebSocket from "ws";
import { createIsolatedProfile, launchWorker, resolvePinnedClaude, writeJson, type Frame } from "../../014-claude-app-server/src/launch.js";
import { InputQueue, virtualNodeQuery } from "../../014-claude-app-server/src/clients.js";
import { createManager } from "./server.js";

const INITIALIZATION_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5_000;
type WorkerState = {
  id: string; pid: number; profileId: string; conversationId: string;
  status: "waiting" | "connected" | "stopping" | "stopped";
  websocketUrl: string; exitCode?: number | null; signal?: string | null; reason?: string;
};

async function within<T>(promise: Promise<T>, label: string, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not complete within ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function waitForFrame(worker: ReturnType<typeof launchWorker>, predicate: (frame: Frame) => boolean): Promise<Frame> {
  const existing = worker.frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((done, reject) => {
    function onFrame(frame: Frame) {
      if (!predicate(frame)) return;
      worker.off("frame", onFrame);
      worker.off("exit", onExit);
      done(frame);
    }
    function onExit(code: number | null, signal: string | null) {
      worker.off("frame", onFrame);
      reject(new Error(`Native worker exited before initialization: code=${code}, signal=${signal}`));
    }
    worker.on("frame", onFrame);
    worker.once("exit", onExit);
  });
}

/** Measure native stream-json worker behavior when its manager-owned stdin reaches EOF. */
export async function runNativeEofProbe(outputDirectory: string) {
  outputDirectory = resolve(outputDirectory);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const profile = createIsolatedProfile(join(mkdtempSync(join(outputDirectory, "isolated-")), "profile"));
  const worker = launchWorker(profile, join(outputDirectory, "worker"));
  const pid = worker.child.pid;
  assert(pid, "Native worker must have a PID");
  let initialized = false;
  let spontaneousExit = false;
  try {
    const response = waitForFrame(worker, (frame) =>
      frame.type === "control_response" && (frame.response as Frame | undefined)?.request_id === "lifecycle-initialize");
    worker.send({ type: "control_request", request_id: "lifecycle-initialize", request: {
      subtype: "initialize", hooks: {}, sdkMcpServers: [],
    } });
    const frame = await within(response, "Native initialization", INITIALIZATION_TIMEOUT_MS);
    const body = frame.response as Frame;
    assert.equal(body.subtype, "success");
    assert.equal(((body.response as Frame)?.account as Frame)?.tokenSource, "none", "Probe must be credential-free");
    initialized = true;
    // This sends EOF without calling ClaudeWorker.stop(), which would escalate to TERM/KILL.
    const exit = new Promise<{ code: number | null; signal: string | null }>((done) => {
      worker.child.once("exit", (code, signal) => done({ code, signal }));
    });
    worker.child.stdin.end();
    const outcome = await Promise.race([exit, delay(EXIT_TIMEOUT_MS).then(() => undefined)]);
    spontaneousExit = outcome !== undefined;
    const versions = resolvePinnedClaude();
    const result = {
      initialized, eofExited: spontaneousExit, exit: outcome ?? null, pid,
      nativeVersion: versions.claudeCodeVersion, sdkVersion: versions.sdkVersion,
      modelRequests: 0,
    };
    writeJson(join(outputDirectory, "result.json"), result);
    return result;
  } finally {
    if (worker.alive) await worker.stop();
    else worker.persist();
    if (!initialized) writeJson(join(outputDirectory, "failure-context.json"), { initialized, pid, frames: worker.frames.length });
  }
}

async function json<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const content = await response.text();
  assert(response.ok, `${method} ${new URL(url).pathname}: ${response.status} ${content.slice(0, 400)}`);
  return JSON.parse(content) as T;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForStopped(baseUrl: string, worker: WorkerState): Promise<WorkerState> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const state = await json<WorkerState>(`${baseUrl}/api/workers/${worker.id}`);
    if (state.status === "stopped" && !alive(worker.pid)) return state;
    if (Date.now() >= deadline) {
      throw new Error(`Worker ${worker.id} PID ${worker.pid} did not stop; status=${state.status}, processAlive=${alive(worker.pid)}`);
    }
    await delay(50);
  }
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await within(new Promise<void>((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  }), "WebSocket open", 5_000);
  return socket;
}

async function waitForRawInitialization(socket: WebSocket): Promise<void> {
  await within(new Promise<void>((done, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      for (const line of data.toString().split("\n")) {
        if (!line.trim()) continue;
        let frame: Frame;
        try { frame = JSON.parse(line) as Frame; } catch { continue; }
        const response = frame.response as Frame | undefined;
        if (frame.type !== "control_response" || response?.request_id !== "lifecycle-raw-init") continue;
        socket.off("message", onMessage);
        if (response.subtype === "success") done();
        else reject(new Error(`Raw initialization failed: ${JSON.stringify(response).slice(0, 400)}`));
      }
    };
    socket.on("message", onMessage);
    socket.send(`${JSON.stringify({ type: "control_request", request_id: "lifecycle-raw-init", request: {
      subtype: "initialize", hooks: {}, sdkMcpServers: [],
    } })}\n`);
  }), "Raw initialization", INITIALIZATION_TIMEOUT_MS);
}

function drainMessages(session: AsyncIterable<unknown>): Promise<string | null> {
  return (async () => {
    try { for await (const _message of session) { /* Drain SDK transport without a model turn. */ } return null; }
    catch (error) { return String(error); }
  })();
}

type ChildManager = {
  child: ChildProcess; url: string; exited: Promise<void>;
  stdout: Buffer[]; stderr: Buffer[];
};

async function startChild(outputDirectory: string): Promise<ChildManager> {
  const childPath = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./lifecycle-child.ts" : "./lifecycle-child.js", import.meta.url));
  const child = spawn(process.execPath, [...(childPath.endsWith(".ts") ? ["--import", "tsx"] : []), childPath, outputDirectory], {
    cwd: resolve("."), stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const ready = new Promise<string>((done, reject) => {
    child.on("message", (message: { type?: string; url?: string }) => {
      if (message.type === "ready" && message.url) done(message.url);
    });
    child.once("exit", (code, signal) => reject(new Error(`Lifecycle child exited before ready: ${code}/${signal}`)));
    child.once("error", reject);
  });
  try { return { child, url: await within(ready, "Lifecycle manager child", INITIALIZATION_TIMEOUT_MS), exited, stdout, stderr }; }
  catch (error) { child.kill("SIGKILL"); await exited; throw error; }
}

function killOwnedNativeGroup(pid: number): void {
  if (!alive(pid)) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

async function childShutdown(outputDirectory: string, signal: "SIGTERM" | "SIGKILL") {
  const manager = await startChild(outputDirectory);
  let worker: WorkerState | undefined;
  try {
    worker = await json<WorkerState>(`${manager.url}/api/workers`, "POST", { profileId: "a" });
    const socket = await openSocket(worker.websocketUrl);
    await waitForRawInitialization(socket);
    // On SIGKILL the kernel closes the manager's pipe handles; JS cleanup cannot run.
    manager.child.kill(signal);
    await within(manager.exited, `Child ${signal} exit`, 8_000);
    const deadline = Date.now() + 8_000;
    while (alive(worker.pid) && Date.now() < deadline) await delay(50);
    socket.terminate();
    const nativeExited = !alive(worker.pid);
    writeJson(join(outputDirectory, "child-result.json"), {
      managerPid: manager.child.pid, nativePid: worker.pid, signal,
      managerExitCode: manager.child.exitCode, managerSignal: manager.child.signalCode,
      nativeExited, modelRequests: 0,
    });
    return { signal, nativeExited, managerExitCode: manager.child.exitCode, managerSignal: manager.child.signalCode };
  } finally {
    if (manager.child.exitCode === null && manager.child.signalCode === null) {
      manager.child.kill("SIGKILL"); await manager.exited;
    }
    if (worker && alive(worker.pid)) killOwnedNativeGroup(worker.pid);
    writeJson(join(outputDirectory, "child-output.json"), {
      stdout: Buffer.concat(manager.stdout).toString("utf8"), stderr: Buffer.concat(manager.stderr).toString("utf8"),
    });
  }
}

/** Exercise foreground worker lifetime with actual SDK and TCP clients, without a model turn. */
export async function runLifecycleProbe(outputDirectory: string) {
  outputDirectory = resolve(outputDirectory);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const profile = createIsolatedProfile(join(mkdtempSync(join(outputDirectory, "isolated-")), "profile"));
  const manager = await createManager({ profiles: { a: profile }, outputDirectory: join(outputDirectory, "manager"),
    host: "127.0.0.1", heartbeatMs: 250 });
  const results: Record<string, unknown>[] = [];
  let managerClosed = false;
  try {
    const profiles = await json<unknown[]>(`${manager.url}/api/profiles`);
    assert.equal(profiles.length, 1);
    const first = await json<WorkerState>(`${manager.url}/api/workers`, "POST", { profileId: "a" });
    const second = await json<WorkerState>(`${manager.url}/api/workers`, "POST", { profileId: "a" });
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.pid, second.pid);
    assert.equal(first.profileId, second.profileId);
    const firstInput = new InputQueue<never>();
    const secondInput = new InputQueue<never>();
    const firstClient = browserQuery({ prompt: firstInput, websocket: { url: first.websocketUrl } } as BrowserQueryOptions);
    const secondClient = virtualNodeQuery(second.websocketUrl, secondInput, profile);
    const firstDrain = drainMessages(firstClient);
    const secondDrain = drainMessages(secondClient.session);
    try {
      const [a, b] = await within(Promise.all([
        firstClient.initializationResult(), secondClient.session.initializationResult(),
      ]), "Parallel SDK initialization", INITIALIZATION_TIMEOUT_MS);
      assert.equal(a.account?.tokenSource, "none");
      assert.equal(b.account?.tokenSource, "none");
      firstClient.close(); firstInput.close();
      const firstStopped = await waitForStopped(manager.url, first);
      await within(firstDrain, "Browser SDK close", 5_000);
      const secondState = await json<WorkerState>(`${manager.url}/api/workers/${second.id}`);
      assert.equal(secondState.status, "connected", "Disconnecting one worker must preserve another worker");
      assert(alive(second.pid));
      results.push({ case: "browser-SDK-disconnect", stopped: firstStopped.status,
        otherWorkerAlive: true, nativePid: first.pid });
      secondClient.session.close(); secondInput.close();
      const secondStopped = await waitForStopped(manager.url, second);
      await within(secondDrain, "Node SDK close", 5_000);
      results.push({ case: "Node-SDK-disconnect", stopped: secondStopped.status, nativePid: second.pid });
    } finally {
      firstClient.close(); firstInput.close(); secondClient.session.close(); secondInput.close();
    }

    const abrupt = await json<WorkerState>(`${manager.url}/api/workers`, "POST", { profileId: "a" });
    const abruptSocket = await openSocket(abrupt.websocketUrl);
    await waitForRawInitialization(abruptSocket);
    abruptSocket.terminate();
    const abruptStopped = await waitForStopped(manager.url, abrupt);
    results.push({ case: "abrupt-TCP-disconnect", stopped: abruptStopped.status, nativePid: abrupt.pid });

    const silent = await json<WorkerState>(`${manager.url}/api/workers`, "POST", { profileId: "a" });
    const silentSocket = await openSocket(silent.websocketUrl);
    await waitForRawInitialization(silentSocket);
    silentSocket.pause(); // Keep TCP open but stop reading pings, like an unresponsive client.
    const silentStopped = await waitForStopped(manager.url, silent);
    silentSocket.terminate();
    assert.equal(silentStopped.reason, "heartbeat timeout");
    results.push({ case: "silent-TCP-heartbeat", stopped: silentStopped.status,
      reason: silentStopped.reason, nativePid: silent.pid });

    const failed = await json<WorkerState>(`${manager.url}/api/workers`, "POST", { profileId: "a" });
    const failedSocket = await openSocket(failed.websocketUrl);
    failedSocket.send("malformed JSON\n");
    failedSocket.terminate();
    const failedStopped = await waitForStopped(manager.url, failed);
    results.push({ case: "failed-initialization-disconnect", stopped: failedStopped.status,
      nativePid: failed.pid, note: "Client sends malformed input then disconnects before initialization" });

    const orderly = await json<WorkerState>(`${manager.url}/api/workers`, "POST", { profileId: "a" });
    const orderlySocket = await openSocket(orderly.websocketUrl);
    await waitForRawInitialization(orderlySocket);
    const httpAddress = new URL(manager.url);
    const incompleteHttp = connect(Number(httpAddress.port), httpAddress.hostname);
    try {
      await within(new Promise<void>((done, reject) => {
        incompleteHttp.once("connect", done); incompleteHttp.once("error", reject);
      }), "Partial HTTP client connect", 5_000);
      incompleteHttp.write("POST /api/workers HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{");
      await delay(50); // Let the server begin reading an incomplete request body.
      assert(!incompleteHttp.destroyed);
      await within(manager.close(), "Manager shutdown with partial HTTP body", 5_000);
      managerClosed = true;
    } finally { incompleteHttp.destroy(); }
    orderlySocket.terminate();
    assert(!alive(orderly.pid), "Manager.close must reap its native worker");
    results.push({ case: "manager-close-with-partial-HTTP-body", nativeExited: true,
      nativePid: orderly.pid, closeDeadlineMs: 5_000 });
  } finally { if (!managerClosed) await manager.close(); }

  const term = await childShutdown(join(outputDirectory, "manager-sigterm"), "SIGTERM");
  assert(term.nativeExited, "SIGTERM manager shutdown must stop its native worker");
  results.push({ case: "manager-SIGTERM", ...term });
  const kill = await childShutdown(join(outputDirectory, "manager-sigkill"), "SIGKILL");
  results.push({ case: "manager-SIGKILL", ...kill,
    note: "Observed kernel pipe EOF only; SIGKILL has no JavaScript cleanup guarantee" });
  const eof = await runNativeEofProbe(join(outputDirectory, "native-eof"));
  results.push({ case: "native-stdin-EOF", ...eof });
  const versions = resolvePinnedClaude();
  const result = { status: "pass", date: new Date().toISOString(), node: process.version,
    sdkVersion: versions.sdkVersion, nativeVersion: versions.claudeCodeVersion,
    modelRequests: 0, cases: results };
  writeJson(join(outputDirectory, "result.json"), result);
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const output = process.argv[2] ?? "artifacts/016-claude-client-sessions/lifecycle";
  runLifecycleProbe(output).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
