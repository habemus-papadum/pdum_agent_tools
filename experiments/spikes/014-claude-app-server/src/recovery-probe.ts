import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createIsolatedProfile, writeJson } from "./launch.js";
import type { Event, Frame } from "./manager.js";

type Snapshot = {
  managerPid: number; nativePid: number; workerId: string; profileId: string; conversationId: string;
  profileRoot: string; historyLength: number; history: Event[]; pendingCallbackIds: string[];
  receiptIds: string[]; sentUserIds: string[]; sentFrames: number; nativeAlive: boolean; modelOutputFrames: number;
};
type Response = { id?: string; type?: string; value?: unknown; error?: string };

async function deadline<T>(promise: Promise<T>, label: string, milliseconds = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function startManager(specificationPath: string, output: string) {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const childPath = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./recovery-child.ts" : "./recovery-child.js", import.meta.url));
  const child = spawn(process.execPath, [...(childPath.endsWith(".ts") ? ["--import", "tsx"] : []), childPath, specificationPath, output], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32",
  });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
  let readyResolve!: (value: Snapshot) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<Snapshot>((done, reject) => { readyResolve = done; readyReject = reject; });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const messages: Response[] = [];
  let ownedNativePid: number | undefined;
  let nativeKnownAlive = false;
  child.on("message", (message: Response) => {
    messages.push(message);
    if (message.type === "native-exit") nativeKnownAlive = false;
    const state = message.value as Partial<Snapshot> | undefined;
    if (state && typeof state.nativePid === "number" && typeof state.nativeAlive === "boolean") {
      ownedNativePid = state.nativePid; nativeKnownAlive = state.nativeAlive;
    }
    if (message.type === "ready") readyResolve(message.value as Snapshot);
    const request = message.id ? pending.get(message.id) : undefined;
    if (request && message.id) {
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
    }
  });
  const exited = new Promise<void>((done) => child.once("exit", (code, signal) => {
    const error = new Error(`Recovery manager exited: code=${code}, signal=${signal}`);
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    writeFileSync(join(output, "stdout.txt"), Buffer.concat(stdout), { mode: 0o600 });
    writeFileSync(join(output, "stderr.txt"), Buffer.concat(stderr), { mode: 0o600 });
    writeJson(join(output, "ipc.json"), messages);
    done();
  }));
  child.on("error", readyReject);
  return {
    child, ready: deadline(ready, "Manager startup"), exited,
    cleanupKnownNative() {
      if (!nativeKnownAlive || !ownedNativePid) return;
      // This is only the PID/group reported by our own child manager, still known alive at forced cleanup.
      try { process.kill(process.platform === "win32" ? ownedNativePid : -ownedNativePid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      nativeKnownAlive = false;
    },
    request<T = Snapshot>(operation: string, extra: Frame = {}): Promise<T> {
      const id = randomUUID();
      const reply = new Promise<T>((done, reject) => {
        pending.set(id, { resolve: (value) => done(value as T), reject });
        child.send({ id, operation, ...extra }, (error) => { if (error) { pending.delete(id); reject(error); } });
      });
      return deadline(reply, `Manager operation ${operation}`);
    },
  };
}

function signalOwnedManager(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

/** Restart actual manager processes. This intentionally measures loss, without adding a journal. */
export async function runRecoveryProbe(outputDirectory: string) {
  outputDirectory = resolve(outputDirectory);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const isolatedRoot = mkdtempSync(join(outputDirectory, "isolated-"));
  const profile = createIsolatedProfile(join(isolatedRoot, "profile"));
  const specification = { profile, profileId: randomUUID(), conversationId: randomUUID() };
  const specificationPath = join(isolatedRoot, "profile-specification.json");
  writeJson(specificationPath, specification);
  const managers: ReturnType<typeof startManager>[] = [];
  try {
    const first = startManager(specificationPath, join(outputDirectory, "first-manager")); managers.push(first);
    const firstReady = await first.ready;
    assert.equal(firstReady.historyLength, 0);
    await first.request("initialize");
    const inputId = randomUUID();
    const held = await first.request("hold-callback", { inputId });
    assert.equal(held.pendingCallbackIds.length, 1);
    assert.deepEqual(held.sentUserIds, [inputId]);
    assert.equal(held.modelOutputFrames, 0);
    const crashed = await first.request("crash-worker");
    assert.equal(crashed.nativeAlive, false);
    assert.equal(crashed.pendingCallbackIds.length, 0);
    const exitEvent = crashed.history.find((event) => event.kind === "exit");
    assert(exitEvent);
    assert.deepEqual(exitEvent.frame.lostCallbacks, held.pendingCallbackIds);
    assert.equal(exitEvent.frame.acceptedInputExecution, "unknown");
    assert.equal(crashed.modelOutputFrames, 0);
    await first.request("stop");
    await deadline(first.exited, "First manager actual exit", 5000);
    assert.equal(first.child.exitCode, 0);

    const second = startManager(specificationPath, join(outputDirectory, "second-manager")); managers.push(second);
    const secondReady = await second.ready;
    assert.notEqual(secondReady.managerPid, firstReady.managerPid);
    assert.notEqual(secondReady.workerId, firstReady.workerId);
    assert.notEqual(secondReady.nativePid, firstReady.nativePid);
    assert.equal(secondReady.profileId, firstReady.profileId);
    assert.equal(secondReady.conversationId, firstReady.conversationId);
    assert.equal(secondReady.profileRoot, firstReady.profileRoot);
    assert.equal(secondReady.historyLength, 0);
    assert.deepEqual(secondReady.pendingCallbackIds, []);
    assert.deepEqual(secondReady.receiptIds, []);
    const cursor = await second.request<{ accepted: boolean; error?: string }>("cursor", { cursor: crashed.historyLength });
    assert.equal(cursor.accepted, false, "Cursor from former manager is outside the new empty history");
    const fresh = await second.request("initialize");
    await delay(250);
    const quiet = await second.request("snapshot");
    assert.equal(quiet.sentUserIds.length, 0, "Restart must not retry ambiguously accepted input");
    assert.equal(quiet.modelOutputFrames, 0);
    assert.equal(fresh.history[0]?.sequence, 1, "New manager cursor sequence resets");
    await second.request("stop");
    await deadline(second.exited, "Second manager actual exit", 5000);
    assert.equal(second.child.exitCode, 0);
    const result = {
      status: "pass", evidence: "Two real manager processes and two native Claude workers; held genuine UserPromptSubmit callback, no model invocation",
      tests: ["owned native worker SIGKILL observed", "pending callback reported lost", "accepted input execution remains unknown", "manager actually exited and restarted", "logical profile/conversation retained", "new native PID and workerId", "history and receipts lost", "old cursor rejected", "sequence resets", "no automatic input retry"],
      managerPids: [firstReady.managerPid, secondReady.managerPid], nativePids: [firstReady.nativePid, secondReady.nativePid],
      workerIds: [firstReady.workerId, secondReady.workerId], profileId: specification.profileId,
      conversationId: specification.conversationId, profileRoot: profile.root, lostCallbackIds: held.pendingCallbackIds,
      firstFinalCursor: crashed.historyLength, restartedInitialCursor: secondReady.historyLength,
      inputId, inputExecution: "unknown", automaticRetries: 0,
      nativeConversationResume: "Not tested: stable IDs here are manager logical identity, not proof of native context restoration",
      managerCrashOrphanCleanup: "Not tested: manager was stopped after its worker was killed; abrupt manager SIGKILL can orphan detached workers",
      modelRequests: 0, costEstimateUsd: 0,
    };
    writeJson(join(outputDirectory, "result.json"), result);
    return result;
  } finally {
    for (const manager of managers) {
      if (manager.child.exitCode !== null || manager.child.signalCode !== null) { manager.cleanupKnownNative(); continue; }
      try { await manager.request("stop"); await deadline(manager.exited, "Cleanup exit", 5000); }
      catch {
        signalOwnedManager(manager.child, "SIGTERM");
        await Promise.race([manager.exited, delay(3000)]);
        if (manager.child.exitCode === null && manager.child.signalCode === null) {
          signalOwnedManager(manager.child, "SIGKILL"); await manager.exited;
        }
        manager.cleanupKnownNative();
      }
    }
  }
}
