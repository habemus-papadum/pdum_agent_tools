import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, WebSocket as ServerWebSocket } from "ws";
import { query as officialNodeQuery, type Query, type SDKMessage, type SDKUserMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import { browserQuery, InputQueue, userMessage, virtualNodeQuery } from "./clients.js";
import { captureSdkRecipe, createIsolatedProfile, launchWorker, resolvePinnedClaude, workerArgs, writeJson, type ClaudeWorker, type Frame } from "./launch.js";

export async function withDeadline<T>(promise: Promise<T>, milliseconds = 20_000, label = "Operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Deliberately transparent single-controller harness, not the manager's shared-client policy. */
export async function createWorkerRelay(worker: ClaudeWorker) {
  const http = createServer((_request, response) => { response.writeHead(404).end(); });
  const ws = new WebSocketServer({ server: http });
  const clientFrames: Frame[] = [];
  let connections = 0;
  ws.on("connection", (socket) => {
    connections++;
    let pending = "";
    socket.on("message", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Frame;
        clientFrames.push(frame);
        if (frame.type !== "keep_alive") worker.send(frame);
      }
    });
  });
  const broadcast = (frame: Frame) => {
    for (const socket of ws.clients) if (socket.readyState === ServerWebSocket.OPEN) socket.send(`${JSON.stringify(frame)}\n`);
  };
  worker.on("frame", broadcast);
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const address = http.address();
  assert(address && typeof address !== "string");
  return {
    url: `ws://127.0.0.1:${address.port}`, clientFrames,
    get connections() { return connections; },
    broadcast,
    terminateConnections() { for (const socket of ws.clients) socket.terminate(); },
    async close() {
      worker.off("frame", broadcast);
      for (const socket of ws.clients) socket.close(1000, "Probe done");
      await new Promise<void>((done) => ws.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}

function collect(session: Query) {
  const frames: SDKMessage[] = [];
  let failure: string | undefined;
  const completion = (async () => {
    try { for await (const frame of session) frames.push(frame); }
    catch (error) { failure = String(error); }
  })();
  return { frames, completion, get failure() { return failure; } };
}

async function waitUntil(test: () => boolean, label: string, milliseconds = 20_000): Promise<void> {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > milliseconds) throw new Error(`${label} timed out`);
    await delay(20);
  }
}

function callbacks(log: unknown[]) {
  return {
    canUseTool: (async (toolName, input) => {
      log.push({ kind: "permission", toolName });
      return { behavior: "allow", updatedInput: input };
    }) as NonNullable<Options["canUseTool"]>,
    hooks: {
      UserPromptSubmit: [{ hooks: [async (input: { hook_event_name: string }) => {
        log.push({ kind: "hook", name: input.hook_event_name }); return {};
      }] }],
      PreToolUse: [{ hooks: [async (input: { hook_event_name: string }) => {
        log.push({ kind: "hook", name: input.hook_event_name });
        return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "ask" as const, permissionDecisionReason: "Spike permission callback probe" } };
      }] }],
    },
  };
}

export async function runLaunchProbe(outputDirectory: string, options: { live?: boolean; authEnv?: Record<string, string>; model?: string } = {}) {
  outputDirectory = resolve(outputDirectory);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const metadata = resolvePinnedClaude();
  writeJson(join(outputDirectory, "versions.json"), { ...metadata, node: process.version, date: new Date().toISOString() });
  const browserSource = readFileSync(join(metadata.sdkDirectory, "browser-sdk.js"), "utf8");
  const sourceMarkers = [
    { name: "websocket-construction", marker: "this.ws=new globalThis.WebSocket(t.toString())" },
    { name: "websocket-end-input", marker: "endInput(){}async*readMessages()" },
    { name: "unguarded-platform-at-module-load", marker: 'var jge=process.platform==="win32"?MB:EB' },
    { name: "unguarded-environment-at-module-load", marker: "var Sye=(()=>{let e=process.env.CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS" },
    { name: "query-debug-logger-process-context", marker: "new N6({argv:process.argv,env:process.env" },
  ].map((selection) => {
    const offset = browserSource.indexOf(selection.marker);
    assert(offset >= 0, `SDK browser source drift: ${selection.name}`);
    return { ...selection, offset, excerpt: browserSource.slice(offset, offset + 700) };
  });
  writeJson(join(outputDirectory, "browser-source-markers.json"), sourceMarkers);
  const profile = createIsolatedProfile(join(outputDirectory, "baseline-profile"), options.model ? { model: options.model } : {});
  const recipe = await captureSdkRecipe(profile, join(outputDirectory, "server-owned-baseline"));
  const results: Record<string, unknown>[] = [{ name: "server-owned-node-sdk", status: "pass", argvEqual: true, noModelRequest: true }];
  const worker = launchWorker(createIsolatedProfile(join(outputDirectory, "browser-profile"), { model: profile.model }), join(outputDirectory, "browser-worker"));
  const relay = await createWorkerRelay(worker);
  const input = new InputQueue<SDKUserMessage>();
  const log: unknown[] = [];
  const browser = browserQuery(relay.url, input, callbacks(log));
  const browserEvents = collect(browser);
  try {
    const initialized = await withDeadline(browser.initializationResult());
    assert.equal(initialized.account?.tokenSource, "none");
    await withDeadline(Promise.all([browser.interrupt(), browser.interrupt()]));
    const firstInitialize = relay.clientFrames.find((f) => (f.request as Frame)?.subtype === "initialize");
    assert(firstInitialize);
    writeJson(join(outputDirectory, "browser-initialize.json"), firstInitialize);
    browser.close();
    input.close();
    await delay(100);
    assert(worker.alive, "Browser close must not kill manager-owned worker");
    results.push({ name: "browser-export-under-node", status: "pass", initialized: true, concurrentControls: true, detachPreservesWorker: true });
    // A second *raw* SDK initialization is an observation, not an endorsement of broadcast ownership.
    const secondInput = new InputQueue<SDKUserMessage>();
    const second = virtualNodeQuery(relay.url, secondInput, profile, callbacks(log));
    const secondEvents = collect(second.session);
    try {
      const secondInitialization = await withDeadline(second.session.initializationResult());
      await withDeadline(second.session.interrupt());
      writeJson(join(outputDirectory, "second-initialize-response.json"), secondInitialization);
      results.push({ name: "virtual-node-sdk-second-initialize", status: "pass", initialized: true, note: "Sequential controller reinitialize; callback ownership tested separately" });
    } finally {
      second.session.close(); secondInput.close(); await secondEvents.completion;
    }
    await delay(100);
    assert(worker.alive, "Virtual process close must detach only");
    results.push({ name: "virtual-process-detach", status: "pass", workerStillAlive: true });
    const cancellationInput = new InputQueue<SDKUserMessage>();
    const controller = new AbortController();
    const cancellation = virtualNodeQuery(relay.url, cancellationInput, profile, { abortController: controller });
    const cancellationEvents = collect(cancellation.session);
    try {
      await withDeadline(cancellation.session.initializationResult());
      controller.abort();
      cancellationInput.close();
      await withDeadline(cancellationEvents.completion);
      assert(worker.alive, "Virtual cancellation must not abort manager-owned worker");
      results.push({ name: "virtual-process-cancellation", status: "pass", workerStillAlive: true, clientFailure: cancellationEvents.failure ?? null });
    } finally { cancellation.session.close(); cancellationInput.close(); }
    const failureInput = new InputQueue<SDKUserMessage>();
    const failure = virtualNodeQuery(relay.url, failureInput, profile);
    const failureEvents = collect(failure.session);
    try {
      await withDeadline(failure.session.initializationResult());
      relay.terminateConnections();
      await withDeadline(failureEvents.completion);
      assert(failureEvents.failure, "Abnormal socket close must surface a client error");
      assert(worker.alive, "Connection failure must not terminate manager-owned worker");
      results.push({ name: "virtual-process-abnormal-close", status: "pass", workerStillAlive: true, clientFailure: failureEvents.failure });
    } finally { failure.session.close(); failureInput.close(); }
  } finally {
    browser.close(); input.close(); await browserEvents.completion;
    await relay.close(); await worker.stop();
    writeJson(join(outputDirectory, "relay-client-frames.json"), relay.clientFrames);
  }
  results.push(await runSharedInitializeProbe(join(outputDirectory, "shared-initialize"), profile.model));
  if (options.live) {
    assert(options.authEnv && Object.keys(options.authEnv).length > 0, "Live probe requires explicit server-side authEnv");
    let failed = false;
    for (const mode of ["browser", "virtual-node", "server-node"] as const) {
      if (failed) { results.push({ name: `live-${mode}`, status: "skipped", reason: "An earlier live variant failed; reassess before more spending" }); continue; }
      const result = await runLiveClient(mode, join(outputDirectory, mode), options.authEnv, profile.model);
      results.push(result);
      failed = result.status !== "pass";
    }
  }
  const summary = { metadata, results, initializationRequestKeys: Object.keys(recipe.initialization.request as Frame), live: options.live ?? false };
  writeJson(join(outputDirectory, "results.json"), summary);
  return summary;
}

async function runSharedInitializeProbe(directory: string, model: string) {
  const profile = createIsolatedProfile(join(directory, "profile"), { model });
  const worker = launchWorker(profile, join(directory, "worker"));
  const relay = await createWorkerRelay(worker);
  const inputs = [new InputQueue<SDKUserMessage>(), new InputQueue<SDKUserMessage>()];
  const callbackOwners: string[] = [];
  const clients = inputs.map((input, index) => browserQuery(relay.url, input, {
    hooks: { UserPromptSubmit: [{ hooks: [async () => {
      callbackOwners.push(`controller-${index}`);
      return { decision: "block" as const, reason: "Credential-free probe blocks before model invocation" };
    }] }] },
  }));
  const collectors = clients.map(collect);
  try {
    await withDeadline(Promise.all(clients.map((session) => session.initializationResult())));
    await withDeadline(Promise.all(clients.map((session) => session.interrupt())));
    inputs[0]!.push(userMessage("This input must be blocked by UserPromptSubmit without invoking a model."));
    await waitUntil(() => callbackOwners.length >= 2, "Both SDKs answering one worker callback");
    await waitUntil(() => worker.frames.some((f) => f.type === "result"), "Blocked input result");
    const blockedResult = worker.frames.find((f) => f.type === "result")!;
    const usage = blockedResult.usage as Frame;
    assert.equal(usage.input_tokens, 0);
    assert.equal(usage.output_tokens, 0);
    assert.match(String(blockedResult.result), /operation blocked by hook/);
    const replies = relay.clientFrames.filter((f) => f.type === "control_response");
    const ids = replies.map((f) => (f.response as Frame)?.request_id);
    assert(ids.length >= 2 && new Set(ids).size < ids.length, "Broadcast exposes duplicate callback replies");
    const summary = {
      name: "simultaneous-raw-sdk-initialization", status: "pass", bothInitialized: true,
      concurrentControls: true, callbackOwners, callbackReplyIds: ids,
      conclusion: "Native worker accepts both initializations, but a broadcast callback is answered by both clients; raw simultaneous ownership is unsafe",
      inputBlockedBeforeModel: true, usage,
    };
    writeJson(join(directory, "summary.json"), summary);
    return summary;
  } finally {
    clients.forEach((session) => session.close()); inputs.forEach((input) => input.close());
    await Promise.all(collectors.map((collector) => collector.completion));
    await relay.close(); await worker.stop();
    writeJson(join(directory, "client-frames.json"), relay.clientFrames);
    writeJson(join(directory, "callbacks.json"), callbackOwners);
  }
}

async function runLiveClient(mode: "browser" | "virtual-node" | "server-node", directory: string, authEnv: Record<string, string>, model: string) {
  const profile = createIsolatedProfile(join(directory, "profile"), { authEnv, model });
  const log: unknown[] = [];
  const cb = callbacks(log);
  const input = new InputQueue<SDKUserMessage>();
  const worker = mode === "server-node" ? undefined : launchWorker(profile, join(directory, "worker"), {
    args: workerArgs(profile, { tools: ["Bash"], maxTurns: 6, maxBudgetUsd: 0.05 }),
  });
  const relay = worker ? await createWorkerRelay(worker) : undefined;
  const nodeOptions: Options = {
    cwd: profile.workDirectory, env: profile.environment, pathToClaudeCodeExecutable: resolvePinnedClaude().binaryPath,
    model, settingSources: [], strictMcpConfig: true, tools: ["Bash"], maxTurns: 6, maxBudgetUsd: 0.05,
    permissionMode: "default", includePartialMessages: true, systemPrompt: "Follow the user exactly. Reply briefly.",
    extraArgs: { "disable-slash-commands": null }, ...cb,
  };
  const session = mode === "browser" ? browserQuery(relay!.url, input, cb)
    : mode === "virtual-node" ? virtualNodeQuery(relay!.url, input, profile, nodeOptions).session
    : officialNodeQuery({ prompt: input, options: nodeOptions });
  const events = collect(session);
  let summary: Record<string, unknown> = { name: `live-${mode}`, status: "fail", selectedModel: model };
  try {
    await withDeadline(session.initializationResult());
    input.push(userMessage("Reply exactly SPIKE014_READY."));
    await waitUntil(() => events.frames.some((f) => f.type === "result") || !!events.failure, "First live turn", 60_000);
    assert(!events.failure, events.failure ?? "Live query failed");
    const first = events.frames.find((f) => f.type === "result");
    assert(first?.type === "result");
    if (first.is_error) { summary.reason = first.subtype; return summary; }
    input.push(userMessage("Use the Bash tool once to run: printf 'SPIKE014_TOOL_OK\\n' . Then reply exactly DONE."));
    await waitUntil(() => events.frames.filter((f) => f.type === "result").length >= 2 || !!events.failure, "Tool live turn", 60_000);
    assert(!events.failure, events.failure ?? "Live query failed");
    const previousPermissions = log.filter((event) => (event as Frame).kind === "permission").length;
    input.push(userMessage("Use Bash to run: sleep 20; printf 'SPIKE014_AFTER_SLEEP\\n' . Then reply DONE."));
    await waitUntil(() => log.filter((event) => (event as Frame).kind === "permission").length > previousPermissions || !!events.failure, "Active tool before interrupt", 60_000);
    assert(!events.failure, events.failure ?? "Live query failed");
    await delay(150);
    const interruptStarted = Date.now();
    await withDeadline(session.interrupt());
    await waitUntil(() => events.frames.filter((f) => f.type === "result").length >= 3 || !!events.failure, "Interrupted turn result", 20_000);
    assert(!events.failure, events.failure ?? "Live query failed");
    const interruptDurationMs = Date.now() - interruptStarted;
    const results = events.frames.filter((f) => f.type === "result");
    const streamed = events.frames.some((f) => f.type === "stream_event");
    const permissions = log.filter((event) => (event as Frame).kind === "permission").length;
    const hooks = log.filter((event) => (event as Frame).kind === "hook").length;
    summary = {
      name: `live-${mode}`, status: results.slice(0, 2).every((r) => !r.is_error) && streamed && permissions > 0 && hooks > 0 && interruptDurationMs < 15_000 ? "pass" : "fail",
      selectedModel: model, streamed, permissions, hooks, resultEndsOnlyTurn: results.length === 3,
      activeTurnInterrupt: { durationMs: interruptDurationMs, sleepRequestedMs: 20_000, resultReceived: true },
    };
    return summary;
  } catch (error) {
    summary.error = String(error);
    return summary;
  } finally {
    session.close(); input.close(); await events.completion;
    await relay?.close(); await worker?.stop();
    writeJson(join(directory, "messages.json"), events.frames);
    writeJson(join(directory, "callbacks.json"), log);
    summary.usage = events.frames.filter((f) => f.type === "result").map((r) => ({
      sessionId: r.session_id, usage: r.usage, modelUsage: r.modelUsage, totalCostUsd: r.total_cost_usd, subtype: r.subtype,
    }));
    summary.usageSemantics = "Pinned CLI schema/source confirms result.usage is per turn, total_cost_usd and modelUsage are cumulative per query; use final cumulative values, not their sum. Resumed/forked sessions can inherit a saved cost baseline; maxBudgetUsd is incremental since query start or /clear. Estimates are not actual subscription billing.";
    writeJson(join(directory, "summary.json"), summary);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? `artifacts/014-claude-app-server/launch-${Date.now()}`;
  // Credentialed runs are orchestrated by the parent entry so one cost ledger covers all subspikes.
  console.log(JSON.stringify(await runLaunchProbe(directory), null, 2));
}
