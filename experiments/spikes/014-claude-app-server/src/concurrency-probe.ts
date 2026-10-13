import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { liveAuthentication } from "./auth.js";
import { InputQueue, userMessage } from "./clients.js";
import { writeCostLedger } from "./cost.js";
import { createIsolatedProfile, resolvePinnedClaude, writeJson, type Frame } from "./launch.js";

type Authentication = { environment: Record<string, string>; provenance: string };
type Json = Record<string, unknown>;
const MODEL = "claude-haiku-5-5";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  return { promise, release };
}

async function deadline<T>(promise: Promise<T>, label: string, milliseconds = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function frames(chunks: Buffer[]): Frame[] {
  return Buffer.concat(chunks).toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Frame);
}

/** Compute intervals from captured worker clocks and local receive timestamps. */
export function concurrencyTiming(workers: Array<Array<{ time: string; frame: SDKMessage }>>) {
  const intervals = workers.map((events) => {
    const event = events.find(({ frame }) => frame.type === "result");
    assert(event?.frame.type === "result" && event.frame.subtype === "success");
    const sent = event.frame.request_sent_wall_ms;
    assert.equal(typeof sent, "number");
    const start = events.find(({ frame }) => frame.type === "stream_event" && frame.event.type === "message_start");
    const stop = events.find(({ frame }) => frame.type === "stream_event" && frame.event.type === "message_stop");
    assert(start && stop);
    return { sessionId: event.frame.session_id, requestSentAtMs: sent!, resultReceivedAtMs: Date.parse(event.time), streamStartAtMs: Date.parse(start.time), streamStopAtMs: Date.parse(stop.time) };
  });
  return {
    intervals,
    requestToResultOverlapMs: Math.min(...intervals.map((item) => item.resultReceivedAtMs)) - Math.max(...intervals.map((item) => item.requestSentAtMs)),
    receivedStreamOverlapMs: Math.min(...intervals.map((item) => item.streamStopAtMs)) - Math.max(...intervals.map((item) => item.streamStartAtMs)),
    timingBasis: "CLI request_sent_wall_ms to local result reception; stream interval uses local message_start/message_stop reception.",
  };
}

/** Two fresh server-owned SDK workers; exactly one bounded live turn each. */
export async function runConcurrencyProbe(directory: string, authentication: Authentication): Promise<Json> {
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pinned = resolvePinnedClaude();
  writeJson(join(directory, "versions.json"), { ...pinned, node: process.version, date: new Date().toISOString() });
  const releasePrompts = deferred();
  const checks: Record<string, boolean> = {};
  const summary: Json = { name: "two-worker-concurrency", status: "fail", selectedModel: MODEL, authProvenance: authentication.provenance, checks };

  function createWorker(label: "a" | "b", expected: "ALPHA" | "BETA") {
    const out = join(directory, `live-${label}`);
    const profile = createIsolatedProfile(join(out, "profile"), { authEnv: authentication.environment, model: MODEL });
    const sessionId = randomUUID();
    const input = new InputQueue<SDKUserMessage>();
    const reachedHook = deferred();
    const events: Array<{ time: string; frame: SDKMessage }> = [];
    const hooks: Json[] = [];
    const outbound: Buffer[] = [];
    const inbound: Buffer[] = [];
    const stderr: Buffer[] = [];
    let child!: ChildProcessWithoutNullStreams;
    let childClosed!: Promise<void>;
    let failure: string | undefined;
    let closing = false;
    let stopPromise: Promise<void> | undefined;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 75_000);
    const resultSummary: Json = {
      name: `live-concurrency-${label}`, status: "fail", selectedModel: MODEL,
      sessionId, maxBudgetUsd: 0.05, maxOutputTokens: 256,
      profile: { root: profile.root, configDirectory: profile.configDirectory, workDirectory: profile.workDirectory },
      startedAt: new Date().toISOString(),
      usageSemantics: "One fresh query and one turn: final cumulative cost/modelUsage equals this attempt's observed usage. No persisted baseline. Estimates are not subscription billing.",
    };
    const session: Query = query({
      prompt: input,
      options: {
        cwd: profile.workDirectory, env: profile.environment,
        pathToClaudeCodeExecutable: pinned.binaryPath, sessionId, model: MODEL,
        settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [],
        permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
        maxTurns: 1, maxBudgetUsd: 0.05, persistSession: true, includePartialMessages: true,
        systemPrompt: "Follow the user exactly. Reply with a single requested word. Do not use tools.",
        extraArgs: { "disable-slash-commands": null }, abortController,
        hooks: { UserPromptSubmit: [{ hooks: [async (hook) => {
          assert.equal(hook.session_id, sessionId, "Hook must belong to its own worker");
          assert.equal(hook.hook_event_name, "UserPromptSubmit");
          if (hook.hook_event_name === "UserPromptSubmit") assert.equal(hook.prompt, `Reply exactly ${expected}.`);
          hooks.push({ time: new Date().toISOString(), sessionId: hook.session_id, hook: hook.hook_event_name });
          reachedHook.release();
          await releasePrompts.promise;
          return {};
        }] }] },
        spawnClaudeCodeProcess(options) {
          child = spawn(options.command, options.args, {
            cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"],
          });
          childClosed = new Promise((done) => child.once("close", () => done()));
          resultSummary.pid = child.pid;
          writeJson(join(out, "launch.json"), {
            command: options.command, args: options.args, cwd: options.cwd,
            environmentKeys: Object.keys(options.env).sort(), pid: child.pid,
          });
          const stdin = new PassThrough();
          stdin.on("data", (chunk: Buffer) => outbound.push(Buffer.from(chunk)));
          stdin.pipe(child.stdin);
          child.stdout.on("data", (chunk: Buffer) => inbound.push(Buffer.from(chunk)));
          child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
          child.stdin.on("error", (error) => stdin.destroy(error));
          return {
            stdin, stdout: child.stdout,
            get killed() { return child.killed; }, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
            kill: child.kill.bind(child), on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child),
          };
        },
      },
    });
    const completion = (async () => {
      try {
        for await (const frame of session) events.push({ time: new Date().toISOString(), frame });
      } catch (error) {
        if (!closing) failure = error instanceof Error ? error.message : String(error);
      }
    })();
    const alive = () => child.exitCode === null && child.signalCode === null;
    async function stop() {
      if (stopPromise) return await stopPromise;
      stopPromise = (async () => {
        closing = true;
        clearTimeout(timer);
        session.close(); input.close();
        const killTimer = setTimeout(() => { if (alive()) child.kill("SIGKILL"); }, 3_000);
        try { await deadline(Promise.all([completion, childClosed]), `Stop worker ${label}`, 8_000); }
        finally { clearTimeout(killTimer); }
        resultSummary.stoppedAt = new Date().toISOString();
        resultSummary.exitCode = child.exitCode;
        resultSummary.signalCode = child.signalCode;
      })();
      return await stopPromise;
    }
    async function waitForResult() {
      const start = Date.now();
      while (!events.some(({ frame }) => frame.type === "result")) {
        if (failure) throw new Error(`Worker ${label}: ${failure}`);
        if (!alive()) throw new Error(`Worker ${label} exited before result`);
        if (Date.now() - start > 60_000) throw new Error(`Worker ${label} result deadline`);
        await delay(20);
      }
      const result = events.find(({ frame }) => frame.type === "result")!.frame;
      assert(result.type === "result");
      assert.equal(result.session_id, sessionId);
      assert.equal(result.is_error, false);
      assert.equal(result.subtype, "success");
      if (result.subtype === "success") assert.equal(result.result.trim(), expected);
      assert(Object.entries(result.modelUsage).every(([name, usage]) => (usage.canonicalModel ?? name).startsWith(MODEL)));
      resultSummary.status = "pass";
      resultSummary.resultWord = expected;
      return result;
    }
    function persist() {
      const resultEvents = events.filter(({ frame }) => frame.type === "result");
      resultSummary.usage = resultEvents.map(({ frame, time }) => {
        assert(frame.type === "result");
        return { observedAt: time, sessionId: frame.session_id, usage: frame.usage, modelUsage: frame.modelUsage, totalCostUsd: frame.total_cost_usd, subtype: frame.subtype };
      });
      resultSummary.streamed = events.some(({ frame }) => frame.type === "stream_event");
      resultSummary.failure = failure ?? null;
      if (!resultEvents.length) resultSummary.unknownCost = "No final usage: cost may be nonzero; no retry was made.";
      writeJson(join(out, "summary.json"), resultSummary);
      writeJson(join(out, "events.json"), events);
      writeJson(join(out, "hooks.json"), hooks);
      writeFileSync(join(out, "stdin.ndjson"), Buffer.concat(outbound), { mode: 0o600 });
      writeFileSync(join(out, "stdout.ndjson"), Buffer.concat(inbound), { mode: 0o600 });
      writeFileSync(join(out, "stderr.txt"), Buffer.concat(stderr), { mode: 0o600 });
    }
    return { profile, sessionId, input, reachedHook, events, outbound, inbound, session, resultSummary, alive, stop, waitForResult, persist };
  }

  const a = createWorker("a", "ALPHA");
  let b: ReturnType<typeof createWorker> | undefined;
  try {
    b = createWorker("b", "BETA");
    await deadline(Promise.all([a.session.initializationResult(), b.session.initializationResult()]), "Initialize both workers");
    assert(a.alive() && b.alive());
    assert.notEqual(a.resultSummary.pid, b.resultSummary.pid);
    assert.notEqual(a.profile.configDirectory, b.profile.configDirectory);
    assert.notEqual(a.sessionId, b.sessionId);
    await deadline(Promise.all([
      a.session.setPermissionMode("bypassPermissions"), b.session.setPermissionMode("dontAsk"),
    ]), "Independent permission controls");
    a.resultSummary.submittedAt = new Date().toISOString();
    a.input.push(userMessage("Reply exactly ALPHA.", a.sessionId));
    b.resultSummary.submittedAt = new Date().toISOString();
    b.input.push(userMessage("Reply exactly BETA.", b.sessionId));
    await deadline(Promise.all([a.reachedHook.promise, b.reachedHook.promise]), "Concurrent prompt hooks");
    checks.bothWorkerInputsActiveTogether = true;
    const heldControls = await deadline(Promise.all([a.session.mcpServerStatus(), b.session.mcpServerStatus()]), "Controls while both hooks pending");
    assert.deepEqual(heldControls, [[], []]);
    checks.controlsResolveWhileBothInputsPending = true;
    summary.promptsReleasedAt = new Date().toISOString();
    releasePrompts.release();
    // Both live turns are now running independently. A's completion/stop does
    // not wait for B's result, and B retains its own open input/control stream.
    const bResult = b.waitForResult();
    bResult.catch(() => {}); // The result is awaited below even if A fails first.
    await a.waitForResult();
    await a.stop();
    assert(!a.alive());
    assert(b.alive(), "Stopping worker A must not stop worker B");
    await deadline(b.session.setModel(MODEL), "B control after A stopped");
    checks.stopAChangesOnlyA = true;
    checks.bAcceptsControlAfterAStop = true;
    await bResult;
    for (const [worker, other] of [[a, b], [b, a]] as const) {
      const init = worker.events.find(({ frame }) => frame.type === "system" && frame.subtype === "init")?.frame;
      assert(init?.type === "system" && init.subtype === "init");
      assert.equal(init.cwd, worker.profile.workDirectory);
      const identities = worker.events.flatMap(({ frame }) => "session_id" in frame && frame.session_id ? [frame.session_id] : []);
      assert(identities.length > 0 && identities.every((id) => id === worker.sessionId));
      assert(!identities.includes(other.sessionId));
      const incoming = frames(worker.inbound);
      const sent = frames(worker.outbound);
      const requests = sent.filter((frame) => frame.type === "control_request");
      const replies = incoming.filter((frame) => frame.type === "control_response");
      const requestIds = new Set(requests.map((frame) => frame.request_id));
      assert(requests.length >= 3);
      assert(replies.every((frame) => requestIds.has((frame.response as Frame).request_id)));
      worker.resultSummary.controlRequestCount = requests.length;
      worker.resultSummary.controlReplyCount = replies.length;
      worker.resultSummary.sessionIdentityVerified = true;
      worker.resultSummary.profileCwdVerified = true;
    }
    checks.outputsAndSessionIdsIsolated = true;
    checks.profileWorkingDirectoriesIsolated = true;
    checks.controlRepliesCorrelateWithinOwnWorker = true;
    const timing = concurrencyTiming([a.events, b.events]);
    assert(timing.requestToResultOverlapMs > 0, "Both provider request intervals should overlap");
    checks.liveRequestIntervalsOverlap = true;
    summary.timing = timing;
    summary.status = "pass";
    summary.workers = [a.resultSummary, b.resultSummary];
    return summary;
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    releasePrompts.release();
    const stops = await Promise.allSettled([a.stop(), b?.stop()]);
    a.persist(); b?.persist();
    summary.cleanup = stops.map((stop) => stop.status === "fulfilled" ? "stopped" : String(stop.reason));
    summary.workers = [a.resultSummary, ...(b ? [b.resultSummary] : [])];
    writeJson(join(directory, "concurrency-results.json"), summary);
    writeCostLedger(directory, authentication.provenance);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? "artifacts/014-claude-app-server/concurrency-20261013";
  const authentication = liveAuthentication(process.argv.includes("--keychain"));
  console.log(JSON.stringify(await runConcurrencyProbe(directory, authentication), null, 2));
}
