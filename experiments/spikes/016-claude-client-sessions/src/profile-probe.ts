import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import * as nodeSdk from "@anthropic-ai/claude-agent-sdk";
import * as browserSdk from "@anthropic-ai/claude-agent-sdk/browser";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { browserQuery, InputQueue } from "../../014-claude-app-server/src/clients.js";
import { createWorkerRelay } from "../../014-claude-app-server/src/launch-probe.js";
import {
  createIsolatedProfile, launchWorker, resolvePinnedClaude, workerArgs, writeJson,
  type ClaudeWorker, type IsolatedProfile,
} from "../../014-claude-app-server/src/launch.js";

type ProbeSession = {
  worker: ClaudeWorker;
  relay: Awaited<ReturnType<typeof createWorkerRelay>>;
  query: Query;
  input: InputQueue<SDKUserMessage>;
  completion: Promise<void>;
  events: SDKMessage[];
  close(): Promise<void>;
};

async function deadline<T>(promise: Promise<T>, label: string, milliseconds = 25_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function markdown(path: string, value: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}

function settingsFixture(profile: IsolatedProfile, label: "a" | "b"): void {
  const title = label === "a" ? "Profile A specialist" : "Profile B specialist";
  markdown(join(profile.configDirectory, "agents", `user-${label}.md`),
    `---\nname: user-${label}\ndescription: ${title}\n---\nThis is an isolated fixture.\n`);
  markdown(join(profile.configDirectory, "commands", `user-${label}.md`),
    `---\ndescription: User ${label} command\n---\nThis is an isolated fixture.\n`);
  writeJson(join(profile.configDirectory, "settings.json"), {
    outputStyle: label === "a" ? "Explanatory" : "Learning",
  });
}

function projectFixture(workDirectory: string): void {
  markdown(join(workDirectory, ".claude", "agents", "project-shared.md"),
    "---\nname: project-shared\ndescription: Shared project specialist\n---\nThis is a shared fixture.\n");
  markdown(join(workDirectory, ".claude", "commands", "project-shared.md"),
    "---\ndescription: Shared project command\n---\nThis is a shared fixture.\n");
  markdown(join(workDirectory, "CLAUDE.md"), "# Shared project fixture\nNo model requests are part of this probe.\n");
  writeJson(join(workDirectory, ".claude", "settings.json"), { outputStyle: "Concise" });
}

type SettingSource = "user" | "project" | "local";

function profileArgs(profile: IsolatedProfile, sessionId: string, sources: SettingSource[]): string[] {
  // Spike 014's direct recipe defaults to SDK isolation (settingSources=[])
  // and suppresses slash commands. Replace only those supported launch knobs.
  return workerArgs(profile, { sessionId, maxTurns: 1, maxBudgetUsd: 0.01 })
    .filter((arg) => arg !== "--setting-sources=" && arg !== "--disable-slash-commands")
    .concat(`--setting-sources=${sources.join(",")}`);
}

async function openSession(
  profile: IsolatedProfile, directory: string, sources: SettingSource[] = ["user", "project"],
): Promise<ProbeSession> {
  const sessionId = randomUUID();
  const worker = launchWorker(profile, join(directory, "worker"), { args: profileArgs(profile, sessionId, sources) });
  let relay: Awaited<ReturnType<typeof createWorkerRelay>> | undefined;
  try {
    relay = await createWorkerRelay(worker);
    const input = new InputQueue<SDKUserMessage>();
    const query = browserQuery(relay.url, input, {});
    const events: SDKMessage[] = [];
    const completion = (async () => { for await (const event of query) events.push(event); })();
    let closed = false;
    return {
      worker, relay, query, input, completion, events,
      async close() {
        if (closed) return;
        closed = true;
        query.close();
        input.close();
        try { await deadline(completion, "SDK controller close", 8_000); }
        finally { await relay!.close(); await worker.stop(); }
        writeJson(join(directory, "control-frames.json"), relay!.clientFrames);
        writeJson(join(directory, "worker-frames.json"), worker.frames);
      },
    };
  } catch (error) {
    await relay?.close();
    await worker.stop();
    throw error;
  }
}

function names(items: Array<{ name: string }>): string[] {
  return items.map((item) => item.name).sort();
}

/** Probe user-config and shared-project discovery through real credential-free native workers. */
export async function runProfileProbe(outputDirectory: string): Promise<Record<string, unknown>> {
  const out = resolve(outputDirectory);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const pinned = resolvePinnedClaude();
  const profileA = createIsolatedProfile(join(out, "profile-a"));
  const profileB = createIsolatedProfile(join(out, "profile-b"));
  // Explicit config roots must take priority even when both workers share an
  // ordinary HOME whose default ~/.claude tree has different customizations.
  const sharedHome = join(out, "shared-home");
  const defaultConfig = join(sharedHome, ".claude");
  mkdirSync(defaultConfig, { recursive: true, mode: 0o700 });
  markdown(join(defaultConfig, "agents", "default-home.md"),
    "---\nname: default-home\ndescription: Default HOME specialist\n---\nSentinel fixture.\n");
  markdown(join(defaultConfig, "commands", "default-home.md"),
    "---\ndescription: Default HOME command\n---\nSentinel fixture.\n");
  writeJson(join(defaultConfig, "settings.json"), { outputStyle: "Learning" });
  profileA.environment.HOME = sharedHome;
  profileB.environment.HOME = sharedHome;
  const defaultProfile = createIsolatedProfile(join(out, "default-profile"));
  defaultProfile.environment.HOME = sharedHome;
  delete defaultProfile.environment.CLAUDE_CONFIG_DIR;
  // The shared workspace is outside all profile roots.
  const sharedWork = join(out, "shared-work");
  mkdirSync(sharedWork, { recursive: true, mode: 0o700 });
  profileA.workDirectory = sharedWork;
  profileB.workDirectory = sharedWork;
  defaultProfile.workDirectory = sharedWork;
  settingsFixture(profileA, "a");
  settingsFixture(profileB, "b");
  projectFixture(sharedWork);
  const checks: Record<string, boolean> = {};
  const report: Record<string, unknown> = {
    observedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    sdkVersion: pinned.sdkVersion, claudeCodeVersion: pinned.claudeCodeVersion,
    sdkSha256: pinned.sdkSha256, browserSha256: pinned.browserSha256, binarySha256: pinned.binarySha256,
    providerRequests: 0, estimatedUsd: 0, actualBilling: "No provider request", checks,
    fixture: { profileARoot: profileA.root, profileBRoot: profileB.root, sharedHome, sharedWork },
  };
  const storageNames = ["listSessions", "getSessionInfo", "getSessionMessages", "forkSession", "renameSession", "tagSession", "deleteSession"] as const;
  const nodeExports = Object.keys(nodeSdk).sort();
  const browserExports = Object.keys(browserSdk).sort();
  assert(storageNames.every((name) => nodeExports.includes(name)));
  assert(storageNames.every((name) => !browserExports.includes(name)));
  report.sdkExportSurface = {
    nodeStorageFunctions: storageNames,
    browserStorageFunctions: browserExports.filter((name) => storageNames.some((storage) => storage === name)),
    browserExports,
    method: "Runtime Object.keys on published package root and /browser entry points; checked against their public declaration files.",
  };
  writeJson(join(out, "sdk-export-surface.json"), report.sdkExportSurface);
  checks.storageHelpersRequireNodeHostApi = true;
  const opened: ProbeSession[] = [];
  try {
    const a = await openSession(profileA, join(out, "separate-a")); opened.push(a);
    const b = await openSession(profileB, join(out, "separate-b")); opened.push(b);
    const [initA, initB] = await deadline(Promise.all([
      a.query.initializationResult(), b.query.initializationResult(),
    ]), "Separate profile initializations");
    assert.equal(initA.account?.tokenSource, "none");
    assert.equal(initB.account?.tokenSource, "none");
    const separate = {
      a: { agents: names(initA.agents), commands: names(initA.commands), outputStyle: initA.output_style, pid: a.worker.child.pid },
      b: { agents: names(initB.agents), commands: names(initB.commands), outputStyle: initB.output_style, pid: b.worker.child.pid },
    };
    report.separateProfiles = separate;
    writeJson(join(out, "separate-initialization.json"), separate);
    for (const label of ["a", "b"] as const) {
      const own = separate[label];
      const other = label === "a" ? "b" : "a";
      assert(own.agents.includes(`user-${label}`));
      assert(!own.agents.includes(`user-${other}`));
      assert(own.commands.includes(`user-${label}`));
      assert(!own.commands.includes(`user-${other}`));
      assert(own.agents.includes("project-shared"));
      assert(own.commands.includes("project-shared"));
      assert(!own.agents.includes("default-home"));
      assert(!own.commands.includes("default-home"));
    }
    checks.userAgentsAndCommandsIsolated = true;
    checks.projectAgentsAndCommandsShared = true;
    checks.explicitConfigRootsIgnoreSharedHomeDefault = true;
    assert.equal(separate.a.outputStyle, "Concise");
    assert.equal(separate.b.outputStyle, "Concise");
    checks.projectSettingsApplyToBothProfiles = true;
    assert.notEqual(separate.a.pid, separate.b.pid);
    checks.separateProfilesOwnDistinctProcesses = true;
    await deadline(Promise.all([
      a.query.setPermissionMode("dontAsk"), b.query.setPermissionMode("default"),
      a.query.mcpServerStatus(), b.query.mcpServerStatus(),
    ]), "Independent separate-profile controls");
    checks.separateProfilesAcceptConcurrentControls = true;
    await Promise.all([a.close(), b.close()]);

    const defaultView = await openSession(defaultProfile, join(out, "default-home-view")); opened.push(defaultView);
    const defaultInit = await deadline(defaultView.query.initializationResult(), "Default HOME view");
    const defaultNames = { agents: names(defaultInit.agents), commands: names(defaultInit.commands) };
    assert(defaultNames.agents.includes("default-home"));
    assert(defaultNames.commands.includes("default-home"));
    assert(defaultNames.agents.includes("project-shared"));
    assert(defaultNames.commands.includes("project-shared"));
    for (const label of ["a", "b"] as const) {
      assert(!defaultNames.agents.includes(`user-${label}`));
      assert(!defaultNames.commands.includes(`user-${label}`));
    }
    checks.defaultHomeViewExcludesExplicitProfileConfig = true;
    report.defaultHomeView = defaultNames;
    await defaultView.close();

    const matrix: Record<string, { agents: string[]; commands: string[]; outputStyle: string }> = {};
    for (const [label, sources] of [
      ["user-only", ["user"]], ["project-only", ["project"]], ["none", []],
    ] as Array<[string, SettingSource[]]>) {
      const session = await openSession(profileA, join(out, `setting-sources-${label}`), sources);
      opened.push(session);
      const initialization = await deadline(session.query.initializationResult(), `Setting sources ${label}`);
      const agents = names(initialization.agents);
      const commands = names(initialization.commands);
      matrix[label] = { agents, commands, outputStyle: initialization.output_style };
      const expectUser = sources.includes("user");
      const expectProject = sources.includes("project");
      assert.equal(agents.includes("user-a"), expectUser);
      assert.equal(commands.includes("user-a"), expectUser);
      assert.equal(agents.includes("project-shared"), expectProject);
      assert.equal(commands.includes("project-shared"), expectProject);
      assert(!agents.includes("default-home"));
      assert(!commands.includes("default-home"));
      await session.close();
    }
    checks.settingSourcesSelectUserAndProjectCustomizations = true;
    checks.emptySettingSourcesExcludesBothCustomizationTrees = true;
    report.settingSourcesMatrix = matrix;
    writeJson(join(out, "setting-sources-matrix.json"), matrix);

    // The shared project setting wins over each user's outputStyle. Remove only
    // that fixture file and start new workers to observe the two user settings.
    rmSync(join(sharedWork, ".claude", "settings.json"));
    const userA = await openSession(profileA, join(out, "user-settings-a")); opened.push(userA);
    const userB = await openSession(profileB, join(out, "user-settings-b")); opened.push(userB);
    const [userInitA, userInitB] = await deadline(Promise.all([
      userA.query.initializationResult(), userB.query.initializationResult(),
    ]), "User settings without project override");
    assert.equal(userInitA.output_style, "Explanatory");
    assert.equal(userInitB.output_style, "Learning");
    checks.userSettingsDistinguishProfilesWithoutProjectOverride = true;
    report.userSettings = { a: userInitA.output_style, b: userInitB.output_style };
    await Promise.all([userA.close(), userB.close()]);

    // A single profile can have multiple active conversations, each with its own
    // native process. Session IDs are explicit to avoid newest-session ambiguity.
    const first = await openSession(profileA, join(out, "same-profile-1")); opened.push(first);
    const second = await openSession(profileA, join(out, "same-profile-2")); opened.push(second);
    const [one, two] = await deadline(Promise.all([
      first.query.initializationResult(), second.query.initializationResult(),
    ]), "Same-profile initializations");
    assert.notEqual(first.worker.child.pid, second.worker.child.pid);
    assert(first.worker.alive && second.worker.alive);
    assert.deepEqual(names(one.agents), names(two.agents));
    assert.deepEqual(names(one.commands), names(two.commands));
    assert.equal(one.output_style, two.output_style);
    checks.sameProfileHasTwoIndependentWorkers = true;
    checks.sameProfileWorkersDiscoverSameConfiguration = true;
    const controls = await deadline(Promise.all([
      first.query.setPermissionMode("dontAsk"), second.query.setPermissionMode("default"),
      first.query.mcpServerStatus(), second.query.mcpServerStatus(),
      first.query.supportedAgents(), second.query.supportedCommands(),
    ]), "Same-profile concurrent controls");
    assert.deepEqual(controls[2], []);
    assert.deepEqual(controls[3], []);
    checks.sameProfileConcurrentControlsResolve = true;
    await first.close();
    assert(second.worker.alive);
    await deadline(second.query.interrupt(), "Remaining worker control after first stops");
    checks.stoppingOneSameProfileWorkerLeavesOtherControllable = true;
    await second.close();
    assert(opened.every((session) => !session.worker.alive));
    assert(opened.every((session) => session.worker.sent.every((frame) => frame.type !== "user")));
    assert(opened.every((session) => session.worker.frames.every((frame) => frame.type !== "assistant" && frame.type !== "result")));
    checks.allWorkersStoppedWithoutInferenceTurns = true;
    report.sameProfile = {
      firstPid: first.worker.child.pid, secondPid: second.worker.child.pid,
      agents: names(one.agents), commands: names(one.commands), outputStyle: one.output_style,
      firstControlRequests: first.relay.clientFrames.filter((frame) => frame.type === "control_request").length,
      secondControlRequests: second.relay.clientFrames.filter((frame) => frame.type === "control_request").length,
    };
    report.status = "pass";
    return report;
  } catch (error) {
    report.status = "fail";
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await Promise.allSettled(opened.map((session) => session.close()));
    await delay(20);
    writeJson(join(out, "profile-results.json"), report);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] ?? `artifacts/016-claude-client-sessions/profile-${Date.now()}`;
  console.log(JSON.stringify(await runProfileProbe(directory), null, 2));
}
