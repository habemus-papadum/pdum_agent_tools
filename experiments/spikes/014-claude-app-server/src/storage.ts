import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { readStorageCostBaseline, storageAttemptAccounting } from "./storage-costs.js";

type Json = Record<string, unknown>;
type Profile = { config: string; work: string; home: string };
type HelperResponse = {
  id: number; ok: boolean; result?: unknown; error?: string; pid: number; subprocessCommands: string[];
};

export type StorageProbeOptions = {
  live?: { environment: NodeJS.ProcessEnv; provenance: string };
  maxBudgetUsdPerTurn?: number;
};

const MODEL = "claude-haiku-5-5";
const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
const sdkRequire = createRequire(sdkEntry);
const executable = realpathSync(sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`));
const sdkManifest = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8")) as Json;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function environment(profile: Profile): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: profile.home,
    TMPDIR: process.env.TMPDIR,
    CLAUDE_CONFIG_DIR: profile.config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    DISABLE_AUTOUPDATER: "1",
    API_TIMEOUT_MS: "15000",
  };
}

class StorageHelper {
  readonly child: ChildProcessWithoutNullStreams;
  readonly responses: HelperResponse[] = [];
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
  }>();
  private readonly closed: Promise<void>;

  constructor(profile: Profile, private readonly log: string) {
    const helperPath = fileURLToPath(new URL(`storage-helper${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url));
    const helperArgs = helperPath.endsWith(".ts") ? ["--import", require.resolve("tsx"), helperPath] : [helperPath];
    this.child = spawn(process.execPath, helperArgs, {
      cwd: profile.work,
      env: { ...environment(profile), SPIKE_STORAGE_HELPER: "1", SPIKE_STORAGE_WORK: profile.work },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise((resolveClosed) => this.child.once("close", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Storage helper exited"));
      }
      this.pending.clear();
      resolveClosed();
    }));
    this.child.on("error", () => { /* close rejects pending requests */ });
    this.child.stderr.on("data", (chunk: Buffer) => appendFileSync(`${log}.stderr`, chunk, { mode: 0o600 }));
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      appendFileSync(log, `${line}\n`, { mode: 0o600 });
      const response = JSON.parse(line) as HelperResponse;
      this.responses.push(response);
      const request = this.pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(response.id);
      if (response.ok) request.resolve(response.result);
      else request.reject(new Error(response.error));
    });
  }

  async call<T>(operation: string, fields: Json = {}): Promise<T> {
    const id = ++this.nextId;
    return await new Promise<T>((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Storage helper ${operation} timed out`));
      }, 15_000);
      this.pending.set(id, { resolve: (value) => resolveRequest(value as T), reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, operation, ...fields })}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    await this.closed;
    clearTimeout(timer);
  }
}

function transcriptPath(profile: Profile, sessionId: string): string {
  const matches: string[] = [];
  const projects = join(profile.config, "projects");
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
    if (readdirSync(join(projects, entry.name)).includes(`${sessionId}.jsonl`)) matches.push(candidate);
  }
  assert.equal(matches.length, 1, `Expected one transcript for ${sessionId}`);
  return matches[0]!;
}

function fixture(profile: Profile, label: string): { sessionId: string; messageIds: string[] } {
  const sessionId = randomUUID();
  const messageIds = Array.from({ length: 4 }, () => randomUUID());
  const project = join(profile.config, "projects", profile.work.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const content = [`${label}: remember ALPHA-431.`, "I will remember ALPHA-431.", "The later marker is OMEGA-982.", "I will remember OMEGA-982."];
  const rows = messageIds.map((uuid, index) => ({
    type: index % 2 === 0 ? "user" : "assistant", uuid,
    parentUuid: index === 0 ? null : messageIds[index - 1],
    sessionId, cwd: profile.work, timestamp: new Date(Date.now() + index).toISOString(),
    isSidechain: false, userType: "external", version: "2.1.296", entrypoint: "sdk-ts",
    message: index % 2 === 0
      ? { role: "user", content: content[index] }
      : { role: "assistant", id: `fixture-${uuid}`, model: MODEL, type: "message", content: [{ type: "text", text: content[index] }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  }));
  writeFileSync(join(project, `${sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  appendFileSync(join(project, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "cost-state", sessionId, totalCostUSD: 0.125,
    totalAPIDuration: 1, totalAPIDurationWithoutRetries: 1, totalToolDuration: 0,
    totalLinesAdded: 0, totalLinesRemoved: 0, totalDuration: 1, startTime: Date.now(),
    modelUsage: { [MODEL]: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.125 } },
  })}\n`);
  return { sessionId, messageIds };
}

function textOf(messages: SessionMessage[]): string {
  return messages.map((message) => JSON.stringify(message.message)).join("\n");
}

/** Exercise standalone official SDK storage in two immutable profile helpers. */
export async function runStorageProbe(outputDir: string, options: StorageProbeOptions = {}): Promise<Json> {
  const out = resolve(outputDir);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  // Workspace paths outside Git avoid project/worktree discovery from the checkout.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-spike-014-storage-")));
  const profiles = ["a", "b"].map((name): Profile => ({
    config: join(out, name, "config"), home: join(out, name, "home"), work: join(root, "shared-work"),
  }));
  for (const profile of profiles) for (const path of Object.values(profile)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const [a, b] = profiles as [Profile, Profile];
  const [originalA, originalB] = [fixture(a, "profile-a"), fixture(b, "profile-b")];
  const [helperA, helperB] = [new StorageHelper(a, join(out, "helper-a.jsonl")), new StorageHelper(b, join(out, "helper-b.jsonl"))];
  const checks: Record<string, boolean> = {};
  const report: Json = {
    observedAt: new Date().toISOString(), sdkVersion: sdkManifest.version,
    executableVersion: sdkManifest.claudeCodeVersion, sdkSha256: hash(sdkEntry), executableSha256: hash(executable),
    node: process.version, workRoot: root, model: MODEL,
    fixtureEvidence: "Synthetic transcript input; official SDK performs actual local filesystem operations; no provider response is fabricated.",
    fixtureCost: { providerRequests: 0, estimatedUsd: 0, actualBilling: "No provider requests" },
    profileA: a, profileB: b, checks,
  };
  try {
    const sdkSource = readFileSync(sdkEntry, "utf8");
    writeJson(join(out, "storage-source-markers.json"), [
      { name: "config-root-from-process-environment", marker: "function Tc(){", length: 900 },
      { name: "project-root-and-environment-override", marker: "function ct(){", length: 600 },
      { name: "project-path-canonicalization", marker: "function gT(", length: 400 },
      { name: "local-fork-copy-and-remap", marker: "async function hU(", length: 6_000 },
      { name: "external-store-resume-hydration", marker: "async function gZ(", length: 3_200 },
    ].map(({ name, marker, length }) => {
      const offset = sdkSource.indexOf(marker);
      assert(offset >= 0, `Pinned storage source marker changed: ${name}`);
      return { name, marker, offset, excerpt: sdkSource.slice(offset, offset + length) };
    }));
    const [listA, listB] = await Promise.all([
      helperA.call<SDKSessionInfo[]>("list"), helperB.call<SDKSessionInfo[]>("list"),
    ]);
    assert.deepEqual(listA.map((item) => item.sessionId), [originalA.sessionId]);
    assert.deepEqual(listB.map((item) => item.sessionId), [originalB.sessionId]);
    checks.concurrentSameWorkspaceProfileDiscoveryIsolated = true;
    assert.deepEqual(await helperA.call("read", { sessionId: originalB.sessionId }), []);
    assert.equal(await helperA.call("info", { sessionId: originalB.sessionId }), null);
    await assert.rejects(helperA.call("rename", { sessionId: originalB.sessionId, title: "wrong-profile" }), /not found/);
    await assert.rejects(helperA.call("fork", { sessionId: originalB.sessionId }), /not found/);
    checks.crossProfileReadsEmptyAndMutationsNotFound = true;
    await helperA.call("rename", { sessionId: originalA.sessionId, title: "renamed fixture" });
    const info = await helperA.call<SDKSessionInfo>("info", { sessionId: originalA.sessionId });
    assert.equal(info.customTitle, "renamed fixture");
    checks.renameVisibleThroughIndependentInfo = true;
    const originalPath = transcriptPath(a, originalA.sessionId);
    const before = hash(originalPath);
    const full = await helperA.call<{ sessionId: string }>("fork", { sessionId: originalA.sessionId });
    const selected = await helperA.call<{ sessionId: string }>("fork", {
      sessionId: originalA.sessionId, upToMessageId: originalA.messageIds[1], title: "selected fixture fork",
    });
    const originalMessages = await helperA.call<SessionMessage[]>("read", { sessionId: originalA.sessionId });
    const fullMessages = await helperA.call<SessionMessage[]>("read", { sessionId: full.sessionId });
    const selectedMessages = await helperA.call<SessionMessage[]>("read", { sessionId: selected.sessionId });
    assert.equal(fullMessages.length, 4);
    assert.equal(selectedMessages.length, 2);
    assert.match(textOf(selectedMessages), /ALPHA-431/);
    assert.doesNotMatch(textOf(selectedMessages), /OMEGA-982/);
    for (const message of fullMessages) {
      assert.equal(message.session_id, full.sessionId);
      assert(!originalA.messageIds.includes(message.uuid));
    }
    assert.deepEqual(fullMessages.map((message) => message.message), originalMessages.map((message) => message.message));
    assert.equal(hash(originalPath), before);
    const sourceCost = readStorageCostBaseline(originalPath, originalA.sessionId);
    const fullCost = readStorageCostBaseline(transcriptPath(a, full.sessionId), full.sessionId);
    const selectedCost = readStorageCostBaseline(transcriptPath(a, selected.sessionId), selected.sessionId);
    assert.equal(sourceCost.totalCostUsd, 0.125);
    assert.equal(fullCost.origin, "transcript-no-cost-state");
    assert.equal(selectedCost.origin, "transcript-no-cost-state");
    checks.standaloneForkOmitsFixtureCostState = true;
    report.fixtureCostState = { explanation: "Synthetic cost-state tests metadata copying; not incurred cost", source: sourceCost, fullFork: fullCost, selectedFork: selectedCost };
    checks.fullForkRemapsIdentityPreservesContent = true;
    checks.selectedMessageForkInclusive = true;
    checks.forkLeavesOriginalByteIdentical = true;
    // A deterministic interrupted-writer probe characterizes local helper
    // behavior only; it is not a claim about a running Claude worker's flushes.
    const pendingPath = transcriptPath(b, originalB.sessionId);
    const pendingRow = JSON.stringify({
      type: "user", uuid: randomUUID(), parentUuid: originalB.messageIds[3], sessionId: originalB.sessionId,
      cwd: b.work, timestamp: new Date().toISOString(), isSidechain: false,
      message: { role: "user", content: "PENDING-WRITER-MARKER" },
    });
    const split = Math.floor(pendingRow.length / 2);
    appendFileSync(pendingPath, pendingRow.slice(0, split));
    const duringWrite = await helperB.call<{ sessionId: string }>("fork", { sessionId: originalB.sessionId });
    const duringMessages = await helperB.call<SessionMessage[]>("read", { sessionId: duringWrite.sessionId });
    assert.equal(duringMessages.length, 4);
    assert.doesNotMatch(textOf(duringMessages), /PENDING-WRITER-MARKER/);
    appendFileSync(pendingPath, `${pendingRow.slice(split)}\n`);
    const afterWrite = await helperB.call<SessionMessage[]>("read", { sessionId: originalB.sessionId });
    assert.equal(afterWrite.length, 5);
    checks.fixtureIncompleteTailExcludedFromFork = true;
    report.fixtureSessions = { originalA, originalB, full, selected };
    report.fixtureCounts = { original: originalMessages.length, full: fullMessages.length, selected: selectedMessages.length };
    if (options.live) report.live = await runLiveStorage(out, a, b, helperA, helperB, options);
    else report.live = { status: "not-run", reason: "No explicit authentication supplied; fixture storage results do not prove live context resume." };
    assert(helperA.responses.every((item) => item.subprocessCommands.every((command) => command === "git")));
    assert(helperB.responses.every((item) => item.subprocessCommands.every((command) => command === "git")));
    checks.storageHelpersNeverLaunchClaude = true;
    report.helperSubprocessCommands = [helperA.responses.at(-1)?.subprocessCommands, helperB.responses.at(-1)?.subprocessCommands];
    report.helperPids = [helperA.child.pid, helperB.child.pid];
    report.status = "pass";
    return report;
  } catch (error) {
    report.status = "fail";
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await Promise.all([helperA.close(), helperB.close()]);
    writeJson(join(out, "storage-results.json"), report);
  }
}

async function runLiveStorage(out: string, a: Profile, b: Profile, helperA: StorageHelper, helperB: StorageHelper, options: StorageProbeOptions): Promise<Json> {
  assert(options.live);
  const auth = options.live.environment;
  assert(auth.CLAUDE_CODE_OAUTH_TOKEN || auth.ANTHROPIC_API_KEY, "Explicit API key or OAuth token required");
  const attempts: Json[] = [];
  const live: Json = { model: MODEL, authProvenance: options.live.provenance, attempts };
  writeJson(join(out, "storage-live.json"), live);
  async function turn(name: string, profile: Profile, prompt: string, resume?: string, forkSession?: boolean): Promise<{ sessionId: string; text: string }> {
    const start = Date.now();
    const baseline = readStorageCostBaseline(resume === undefined ? undefined : transcriptPath(profile, resume), resume);
    const attempt: Json = { name, startedAt: new Date().toISOString(), model: MODEL, maxBudgetUsd: options.maxBudgetUsdPerTurn ?? 0.05, maxOutputTokens: 256, baseline, billing: "SDK accounting is an estimate, not subscription billing" };
    attempts.push(attempt);
    writeJson(join(out, "storage-live.json"), live);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 60_000);
    let result: { sessionId: string; text: string } | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let childClosed: Promise<void> | undefined;
    const workerEnvironment = {
      ...environment(profile),
      ...(auth.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: auth.CLAUDE_CODE_OAUTH_TOKEN } : { ANTHROPIC_API_KEY: auth.ANTHROPIC_API_KEY }),
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "256",
    };
    const session = query({
      prompt,
      options: {
        cwd: profile.work, env: workerEnvironment,
        pathToClaudeCodeExecutable: executable, settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [],
        permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
        model: MODEL, maxTurns: 1, maxBudgetUsd: options.maxBudgetUsdPerTurn ?? 0.05,
        persistSession: true, systemPrompt: "Answer briefly. This is a bounded storage experiment. No tools.",
        extraArgs: { "disable-slash-commands": null }, abortController,
        ...(resume === undefined ? {} : { resume }), ...(forkSession === undefined ? {} : { forkSession }),
        spawnClaudeCodeProcess(spawnOptions) {
          // SDK copies the explicit env option and adds its own protocol flags;
          // it does not merge the parent environment in this pinned version.
          child = spawn(spawnOptions.command, spawnOptions.args, {
            cwd: spawnOptions.cwd, env: spawnOptions.env,
            signal: spawnOptions.signal, stdio: ["pipe", "pipe", "pipe"],
          });
          attempt.pid = child.pid;
          childClosed = new Promise((resolveClosed) => child!.once("close", () => resolveClosed()));
          return child;
        },
      },
    });
    try {
      for await (const message of session) {
        appendFileSync(join(out, `live-${name}.jsonl`), `${JSON.stringify(message)}\n`, { mode: 0o600 });
        if (message.type === "result") {
          attempt.resultSubtype = message.subtype;
          attempt.resultIsError = message.is_error;
          attempt.sessionId = message.session_id;
          Object.assign(attempt, storageAttemptAccounting(baseline, message));
          const actualModels = Object.entries(message.modelUsage).map(([name, item]) => item.canonicalModel ?? name);
          attempt.actualModels = actualModels;
          assert(actualModels.every((name) => name.startsWith(MODEL)), `Unexpected model usage: ${actualModels.join(", ")}`);
          if (message.subtype !== "success" || message.is_error) throw new Error(`${name}: ${message.subtype}, is_error=${message.is_error}`);
          result = { sessionId: message.session_id, text: message.result };
        }
      }
      assert(result, `${name} returned no result`);
      attempt.status = "success";
      return result;
    } catch (error) {
      attempt.status = "failed";
      attempt.error = error instanceof Error ? error.message : String(error);
      if (attempt.sdkIncrementalCostUsd === undefined) {
        attempt.unknownCost = "Missing/error final usage may omit accepted provider work; cost may be nonzero, do not count as free.";
      }
      throw error;
    } finally {
      clearTimeout(timer);
      session.close();
      if (child && childClosed) {
        const killTimer = setTimeout(() => child?.kill("SIGKILL"), 3_000);
        await childClosed;
        clearTimeout(killTimer);
        attempt.workerExited = true;
      }
      attempt.durationMs = Date.now() - start;
      writeJson(join(out, "storage-live.json"), live);
    }
  }

  try {
    const original = await turn("create-a", a, "Remember the private experiment marker CEDAR-728. Reply only ACK.");
    const other = await turn("create-b", b, "Remember the private experiment marker RIVER-193. Reply only ACK.");
    const aMessages = await helperA.call<SessionMessage[]>("read", { sessionId: original.sessionId });
    assert(aMessages.length >= 2);
    assert.deepEqual(await helperA.call("read", { sessionId: other.sessionId }), []);
    assert.deepEqual(await helperB.call("read", { sessionId: original.sessionId }), []);
    const sourcePath = transcriptPath(a, original.sessionId);
    const sourceHash = hash(sourcePath);
    const branchPoint = aMessages.find((message) => message.type === "assistant")!;
    assert(branchPoint);
    const fork = await helperA.call<{ sessionId: string }>("fork", { sessionId: original.sessionId, upToMessageId: branchPoint.uuid });
    const resumed = await turn("resume-storage-fork", a, "What is the private experiment marker? Reply with only the marker.", fork.sessionId);
    assert.equal(resumed.sessionId, fork.sessionId);
    assert.match(resumed.text, /CEDAR-728/);
    assert.equal(hash(sourcePath), sourceHash);
    const launchFork = await turn("launch-fork", a, "What is the private experiment marker? Reply with only the marker.", original.sessionId, true);
    assert.notEqual(launchFork.sessionId, original.sessionId);
    assert.match(launchFork.text, /CEDAR-728/);
    assert.equal(hash(sourcePath), sourceHash);
    live.status = "pass";
    live.checks = { twoPersistedProfiles: true, selectedForkContextInherited: true, selectedForkHasNewId: true, launchTimeForkContextInherited: true, launchTimeForkHasNewId: true, originalByteIdenticalAfterBothResumes: true };
    live.sessions = { original, other, fork, launchFork };
    return live;
  } catch (error) {
    live.status = "fail";
    live.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    live.sdkIncrementalCostUsdKnown = attempts.reduce((sum, attempt) => sum + (typeof attempt.sdkIncrementalCostUsd === "number" ? attempt.sdkIncrementalCostUsd : 0), 0);
    live.attemptsWithUnknownIncrementalCost = attempts.filter((attempt) => typeof attempt.sdkIncrementalCostUsd !== "number").length;
    writeJson(join(out, "storage-live.json"), live);
  }
}
