import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const spike = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(spike, "../..");
const artifactRoot = join(workspace, "artifacts/015-claude-agents-discovery");
mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
const run = mkdtempSync(join(artifactRoot, "run-"));
const isolated = realpathSync(mkdtempSync(join(tmpdir(), "agent-spike-015-")));
const config = join(isolated, "config");
const cwd = join(isolated, "work");
const otherConfig = join(isolated, "other-config");
for (const path of [config, cwd, otherConfig]) mkdirSync(path, { mode: 0o700 });
const env: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: isolated,
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_SIMPLE: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DAEMON_COLD_START: "transient",
  DISABLE_AUTOUPDATER: "1",
  TERM: "xterm-256color",
};
const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
const sdkRequire = createRequire(sdkEntry);
const binaryPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const binary = realpathSync(sdkRequire.resolve(`${binaryPackage}/claude`));
const manifest = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8"));
const installed = spawnSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).stdout.trim();
const ownProcesses = new Set<ChildProcess>();
const results: Record<string, unknown> = {};

function save(name: string, value: unknown): void {
  writeFileSync(join(run, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function launch(args: string[], environment = env, executable = binary, directory = cwd) {
  const child = spawn(executable, args, { env: environment, cwd: directory, stdio: "pipe" });
  ownProcesses.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("close", (code, signal) => {
      ownProcesses.delete(child);
      resolveExit({ code, signal });
    });
  });
  return { child, done, output: () => ({ stdout, stderr }) };
}

async function stop(process: ReturnType<typeof launch>): Promise<void> {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill("SIGTERM");
  const timer = setTimeout(() => process.child.kill("SIGKILL"), 2_000);
  await process.done;
  clearTimeout(timer);
}

async function command(
  name: string, args: string[], environment = env, executable = binary, directory = cwd, timeoutMs = 10_000,
) {
  const process = launch(args, environment, executable, directory);
  process.child.stdin.end();
  const timer = setTimeout(() => process.child.kill("SIGKILL"), timeoutMs);
  const exit = await process.done;
  clearTimeout(timer);
  const value = { args, ...exit, ...process.output() };
  save(`${name}.json`, value);
  return value;
}

async function poll(predicate: () => boolean, message: string, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(50);
  assert.ok(predicate(), message);
}

function sourceInspection(): void {
  const bytes = readFileSync(binary);
  const markers = [
    "as agentsCommandHandler", "as printAgentsJson", "async function CJ(e,n){let r=await F(",
    "function qCe(){", "async function mKn(e,r={})", "function wdt(e){", "function c6(){",
    "function C8t(e){", "CLAUDE_CODE_DAEMON_COLD_START",
    "Cumulative estimated cost in USD for this query() call",
  ];
  const excerpts = markers.map((marker) => {
    // Ignore compiled string pools: inspect the embedded JavaScript chunks.
    let offset = bytes.indexOf(marker);
    while (offset >= 0) {
      const start = bytes.lastIndexOf(0, offset) + 1;
      if (bytes.subarray(start, start + 17).toString().startsWith("// @bun @bytecode")) {
        return { marker, offset, excerpt: bytes.subarray(Math.max(start, offset - 700), offset + 2_200).toString() };
      }
      offset = bytes.indexOf(marker, offset + 1);
    }
    return { marker, offset: -1, excerpt: null };
  });
  assert.ok(excerpts.every((entry) => entry.offset >= 0), "Pinned source markers changed; inspect before claiming findings");
  save("source-excerpts.json", excerpts);
}

async function registryProbe(): Promise<void> {
  const baseline = await command("registry-empty", ["agents", "--json"]);
  assert.deepEqual(JSON.parse(baseline.stdout), []);
  const worker = launch([
    "--bare", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", "haiku", "--permission-mode", "bypassPermissions", "--setting-sources", "", "--strict-mcp-config",
  ]);
  try {
    worker.child.stdin.write(`${JSON.stringify({
      type: "control_request", request_id: "init-015", request: { subtype: "initialize" },
    })}\n`);
    await poll(() => worker.output().stdout.includes('"request_id":"init-015"'), "worker initialization");
    save("worker-initialization.json", worker.output());
    const listed = await command("registry-live", ["agents", "--json"]);
    const entries = JSON.parse(listed.stdout) as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.pid, worker.child.pid);
    assert.equal(entries[0]?.kind, "interactive");
    const record = JSON.parse(readFileSync(join(config, "sessions", `${worker.child.pid}.json`), "utf8"));
    save("owned-session-record.json", record);
    const headlessAttach = await command("headless-attach", ["attach", String(entries[0]?.sessionId)]);
    assert.equal(headlessAttach.code, 1);
    assert.match(headlessAttach.stderr, /No job matching/);
    const foreign = await command("registry-other-profile", ["agents", "--json"], { ...env, CLAUDE_CONFIG_DIR: otherConfig });
    assert.deepEqual(JSON.parse(foreign.stdout), []);
    const filtered = await command("registry-cwd-filter", ["agents", "--json", "--cwd", join(cwd, "not-this-project")]);
    assert.deepEqual(JSON.parse(filtered.stdout), []);
    await command("worker-lsof", ["-nP", "-p", String(worker.child.pid)], env, "/usr/sbin/lsof");
    const filesystemTrace = await command("fs-usage", ["-w", "-f", "filesys", "-t", "1", String(worker.child.pid)], env, "/usr/bin/fs_usage");
    const syscallTrace = await command("dtruss", ["-p", String(worker.child.pid)], env, "/usr/bin/dtruss", cwd, 2_000);
    results.registry = {
      status: "pass", workerPid: worker.child.pid, listedKind: entries[0]?.kind, profileIsolation: true,
      cwdFilter: true, headlessSdkAttach: "no matching background job", recordKeys: Object.keys(record),
    };
    results.tracing = { filesystemExitCode: filesystemTrace.code, syscallExitCode: syscallTrace.code, lsof: "captured for owned PID" };
  } finally {
    await stop(worker);
  }
  const stopped = await command("registry-stopped", ["agents", "--json"]);
  assert.deepEqual(JSON.parse(stopped.stdout), []);
}

async function sdkUrlProbe(): Promise<void> {
  let connections = 0;
  const server = createHttpServer((_request, response) => { connections++; response.writeHead(400).end(); });
  server.on("upgrade", (_request, socket) => { connections++; socket.end(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const probe = await command("sdk-url", [
      "--bare", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--model", "haiku", "--sdk-url", `ws://127.0.0.1:${address.port}/spike-015`,
    ]);
    assert.equal(probe.code, 1);
    assert.match(probe.stderr, /not an approved Anthropic endpoint/);
    assert.equal(connections, 0);
    results.sdkUrl = { status: "unsupported", localConnections: connections, reason: "CLI rejects local hostname before connecting" };
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function attachProbe(): Promise<void> {
  // Trust only this newly created empty workspace. No normal profile is read.
  const localPath = join(config, ".claude.json");
  const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : {};
  local.hasCompletedOnboarding = true;
  local.projects = { [cwd]: { hasTrustDialogAccepted: true } };
  writeFileSync(localPath, JSON.stringify(local), { mode: 0o600 });
  const namespace = createHash("sha256").update(config).digest("hex").slice(0, 8);
  const socket = join("/tmp", `cc-daemon-${process.getuid?.() ?? 0}`, namespace, "control.sock");
  const upstreamPath = join(dirname(socket), "spike-upstream.sock");
  const daemon = launch(["daemon", "run", "--origin", "transient"]);
  const connections: Array<{ request: Buffer[]; response: Buffer[] }> = [];
  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    const upstream = connect(upstreamPath);
    sockets.add(client); sockets.add(upstream);
    const capture = { request: [] as Buffer[], response: [] as Buffer[] };
    connections.push(capture);
    client.on("data", (data: Buffer) => capture.request.push(Buffer.from(data)));
    upstream.on("data", (data: Buffer) => capture.response.push(Buffer.from(data)));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    client.pipe(upstream); upstream.pipe(client);
  });
  let renamed = false;
  let workerPid: number | undefined;
  try {
    await poll(() => existsSync(socket), "isolated foreground daemon socket");
    renameSync(socket, upstreamPath); renamed = true;
    proxy.listen(socket);
    await once(proxy, "listening");
    const background = await command("background-create", [
      "--bare", "--bg", "--model", "haiku", "--setting-sources", "", "--strict-mcp-config", "--name", "spike-015-empty",
    ]);
    assert.equal(background.code, 0);
    const listing = await command("background-list", ["agents", "--json", "--all"]);
    const entries = JSON.parse(listing.stdout) as Array<{ id: string; kind: string }>;
    const id = entries.find((entry) => entry.kind === "background")?.id;
    assert.ok(id);
    const casePath = join(run, "pty-case.json");
    writeFileSync(casePath, JSON.stringify({ binary, env, cwd, id, output: join(run, "attach-terminal.bin") }), { mode: 0o600 });
    const uv = spawnSync("/usr/bin/which", ["uv"], { encoding: "utf8" }).stdout.trim();
    assert.ok(uv, "uv must be available");
    const ptyResult = await command("attach-pty", [
      "run", "--frozen", "python", join(spike, "src/pty_probe.py"), casePath,
    ], process.env as Record<string, string>, uv, workspace, 15_000);
    assert.equal(ptyResult.code, 0);
    const afterAttach = await command("background-after-attach", ["agents", "--json", "--all"]);
    workerPid = (JSON.parse(afterAttach.stdout) as Array<{ id: string; pid?: number }>).find((entry) => entry.id === id)?.pid;
    assert.ok(workerPid, "attachment must launch a real background worker");
    const agentsCase = join(run, "agents-pty-case.json");
    writeFileSync(agentsCase, JSON.stringify({
      binary, env, cwd, args: ["agents", "--model", "haiku"], exitKeys: "\u0003\u0003",
      output: join(run, "agents-terminal.bin"),
    }), { mode: 0o600 });
    const agentsTui = await command("agents-pty", [
      "run", "--frozen", "python", join(spike, "src/pty_probe.py"), agentsCase,
    ], process.env as Record<string, string>, uv, workspace, 15_000);
    assert.equal(agentsTui.code, 0);
    const tuiOutput = readFileSync(join(run, "agents-terminal.bin"), "utf8");
    assert.match(tuiOutput, /spike-015-empty/, "native agents TUI must display our session");
    await command("daemon-lsof", ["-nP", "-p", String(daemon.child.pid)], env, "/usr/sbin/lsof");
    const observations = connections.map((capture, index) => {
      const request = Buffer.concat(capture.request);
      const response = Buffer.concat(capture.response);
      writeFileSync(join(run, `socket-${index}-request.bin`), request, { mode: 0o600 });
      writeFileSync(join(run, `socket-${index}-response.bin`), response, { mode: 0o600 });
      let first: Record<string, unknown> = {};
      let ack: Record<string, unknown> = {};
      try { first = JSON.parse(request.subarray(0, request.indexOf(10)).toString()); } catch { /* Non-JSON clients are recorded. */ }
      const boundary = response.indexOf(10);
      try { ack = JSON.parse(response.subarray(0, boundary).toString()); } catch { /* Empty responses are recorded. */ }
      return {
        op: first.op, proto: first.proto, requestKeys: Object.keys(first), ackOk: ack.ok, ackOp: ack.op,
        ackKeys: Object.keys(ack), terminalBytes: boundary >= 0 ? response.length - boundary - 1 : 0,
        startsWithEscapeAfterAck: boundary >= 0 && response[boundary + 1] === 27,
      };
    });
    save("socket-summary.json", observations);
    const attaches = observations.filter((entry) => entry.op === "attach");
    assert.ok(attaches.some((entry) => entry.ackOk === true && entry.terminalBytes > 0), "native attach must receive real terminal output");
    results.attach = {
      status: "pass", id, daemonPid: daemon.child.pid, workerPid, socketNamespace: namespace, attaches,
      agentsTuiDisplayedOwnedSession: true, modelPromptSubmitted: false,
    };
  } finally {
    for (const connected of sockets) connected.destroy();
    if (proxy.listening) await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()));
    if (renamed && existsSync(upstreamPath)) renameSync(upstreamPath, socket);
    await command("daemon-stop", ["daemon", "stop", "--any"]);
    await stop(daemon);
    save("daemon-output.json", daemon.output());
    if (workerPid !== undefined) {
      const ownedWorkerPid = workerPid;
      await poll(() => {
        try { process.kill(ownedWorkerPid, 0); return false; } catch { return true; }
      }, "owned background worker must exit after daemon stop");
      results.cleanup = { status: "pass", daemonExited: true, workerExited: true };
    }
  }
}

try {
  assert.equal(process.platform, "darwin", "This bounded system/PTY probe currently targets macOS");
  assert.equal(manifest.version, "0.3.296", "Review the experiment on SDK version drift");
  const version = await command("version", ["--version"]);
  const metadata = {
    observedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    osRelease: release(), sdkVersion: manifest.version, sdkSha256: hash(sdkEntry), binaryPackage,
    binarySha256: hash(binary), version: version.stdout.trim(),
    installedVersion: installed ? (await command("installed-version", ["--version"], env, installed)).stdout.trim() : null,
    installedSha256: installed ? hash(installed) : null, isolated, artifactDirectory: run,
    cost: { authenticatedRequests: 0, submittedUserPrompts: 0, inferenceEstimateUsd: 0, actualBilledUsd: null, modelSelection: "haiku" },
  };
  save("metadata.json", metadata);
  await command("help", ["--help"]);
  await command("agents-help", ["agents", "--help"]);
  await command("daemon-help", ["daemon", "--help"]);
  sourceInspection();
  await registryProbe();
  await sdkUrlProbe();
  await attachProbe();
  save("results.json", results);
  console.log(JSON.stringify({ metadata, results }, null, 2));
} catch (error) {
  save("failure.json", { error: String(error), stack: error instanceof Error ? error.stack : null, results });
  throw error;
} finally {
  for (const child of ownProcesses) child.kill("SIGTERM");
}
