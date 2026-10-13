import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchWorker, writeJson, type IsolatedProfile } from "./launch.js";
import { SessionCore, type Frame, type WorkerPort } from "./manager.js";

type Specification = { profile: IsolatedProfile; profileId: string; conversationId: string };
type Command = { id: string; operation: string; cursor?: number; inputId?: string };
const specificationPath = process.argv[2];
const outputArgument = process.argv[3];
assert(specificationPath && outputArgument && process.send, "Recovery child requires an explicit profile specification and IPC channel");
const output: string = outputArgument;
const specification = JSON.parse(readFileSync(specificationPath, "utf8")) as Specification;
// This specification was created by the parent from a fresh isolated profile, never from ordinary CLI state.
const worker = launchWorker(specification.profile, join(output, "worker"));
const port: WorkerPort = {
  send: (frame) => worker.send(frame), stop: () => worker.stop(),
  onFrame(callback) { worker.on("frame", callback); return () => { worker.off("frame", callback); }; },
  onExit(callback) {
    const exited = (code: number | null, signal: string | null) => callback(`code=${code},signal=${signal}`);
    worker.on("exit", exited); return () => { worker.off("exit", exited); };
  },
};
const core = new SessionCore(specification.profileId, specification.conversationId, port);
worker.child.once("exit", () => {
  if (process.connected) process.send?.({ type: "native-exit", nativePid: worker.child.pid });
});
const controller = core.attach({ owner: "recovery-parent", role: "controller", deliver() {} });
let stopping = false;

function snapshot() {
  return {
    managerPid: process.pid, nativePid: worker.child.pid, workerId: core.workerId,
    profileId: core.profileId, conversationId: core.conversationId, profileRoot: specification.profile.root,
    historyLength: core.history.length, history: core.history,
    pendingCallbackIds: [...core.pendingCallbacks.keys()], receiptIds: [...core.inputReceipts.keys()],
    sentUserIds: worker.sent.filter((frame) => frame.type === "user").map((frame) => frame.uuid),
    sentFrames: worker.sent.length, nativeAlive: worker.alive,
    modelOutputFrames: worker.frames.filter((frame) => frame.type === "assistant" || frame.type === "stream_event").length,
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label} deadline exceeded`);
    await delay(10);
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await core.stop();
  writeJson(join(output, "final-state.json"), snapshot());
}

async function command(message: Command): Promise<unknown> {
  switch (message.operation) {
    case "snapshot": return snapshot();
    case "initialize": {
      const requestId = `initialize-${message.id}`;
      controller.send({ type: "control_request", request_id: requestId, request: {
        subtype: "initialize",
        hooks: { UserPromptSubmit: [{ hookCallbackIds: ["recovery-blocker"] }] },
      } });
      await until(() => core.history.some((event) => (event.frame.response as Frame | undefined)?.request_id === requestId), "Initialize");
      const reply = core.history.find((event) => (event.frame.response as Frame | undefined)?.request_id === requestId)!;
      assert.equal((reply.frame.response as Frame).subtype, "success");
      const initialization = (reply.frame.response as Frame).response as Frame;
      assert.equal((initialization.account as Frame)?.tokenSource, "none", "Recovery worker must be credential-free");
      writeJson(join(output, "initialized.json"), snapshot());
      return snapshot();
    }
    case "hold-callback": {
      assert(message.inputId);
      const receipt = controller.send({ type: "user", uuid: message.inputId, session_id: "",
        parent_tool_use_id: null, message: { role: "user", content: "Hold at UserPromptSubmit; this probe must not reach a model." },
      });
      await until(() => core.pendingCallbacks.size > 0, "Native UserPromptSubmit callback");
      const pending = [...core.pendingCallbacks.values()];
      assert(pending.some((frame) => (frame.request as Frame)?.subtype === "hook_callback"));
      writeJson(join(output, "callback-held.json"), { receipt, ...snapshot() });
      return { receipt, ...snapshot() };
    }
    case "crash-worker": {
      assert(worker.alive && worker.child.pid, "Crash only this manager's currently owned live worker");
      const exit = new Promise<void>((done) => worker.child.once("exit", () => done()));
      if (process.platform === "win32") worker.child.kill("SIGKILL");
      else process.kill(-worker.child.pid, "SIGKILL");
      await exit;
      await until(() => core.history.some((event) => event.kind === "exit"), "Manager crash observation");
      writeJson(join(output, "worker-crashed.json"), snapshot());
      return snapshot();
    }
    case "cursor": {
      try {
        const peer = core.attach({ role: "observer", cursor: message.cursor!, deliver() {} });
        peer.detach();
        return { accepted: true };
      } catch (error) { return { accepted: false, error: String(error) }; }
    }
    case "stop": await stop(); return snapshot();
    default: throw new Error(`Unknown recovery command: ${message.operation}`);
  }
}

process.on("message", (message: Command) => {
  void command(message).then((value) => {
    process.send?.({ id: message.id, value }, () => {
      if (message.operation === "stop") process.disconnect?.();
    });
  }).catch((error: unknown) => process.send?.({ id: message.id, error: String(error) }));
});
process.once("disconnect", () => { void stop(); });
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
process.send({ type: "ready", value: snapshot() });
