import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.js";
import { RpcClient } from "./rpc.js";

type Message = Record<string, unknown>;
type ThreadState = { thread: { id: string }; approvalPolicy: string; sandbox: { type: string }; activePermissionProfile?: unknown };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, "artifacts/006-codex-permissions", `run-${Date.now()}`);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-spike-permissions-")));
const home = join(scratch, "home");
const codexHome = join(home, ".codex");
const cwd = join(scratch, "work");
const temp = join(scratch, "tmp");
await Promise.all([codexHome, cwd, temp].map((directory) => mkdir(directory, { recursive: true })));
const binary = await realpath(resolve(process.env.SPIKE_CODEX_BIN ?? join(root, "artifacts/003-codex-control/target/debug/codex")));
const env = { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: temp, LANG: "en_US.UTF-8" };
const version = spawnSync(binary, ["--version"], { env, cwd, encoding: "utf8", timeout: 15_000 });
assert.equal(version.status, 0);
const builtRevision = process.env.SPIKE_CODEX_BIN ? null : JSON.parse(await readFile(join(root, "artifacts/003-codex-control/build-result.json"), "utf8")).revision as string;
const fixture = await startFixture();
const observations: Message[] = [];
const launches: Message[] = [];
const transcripts: Message[] = [];
const config = `model = "mock-model"
model_provider = "spike_fixture"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
analytics.enabled = false
feedback.enabled = false
skills.bundled.enabled = false
[features]
apps = false
plugins = false
code_mode = false
shell_snapshot = false
multi_agent = true
[model_providers.spike_fixture]
name = "Local deterministic fixture"
base_url = "${fixture.url}"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`;
await writeFile(join(codexHome, "config.toml"), config, { mode: 0o600 });
await writeFile(join(artifacts, "fixture-config.toml"), config, { mode: 0o600 });
const launch = async (overrides: string[] = [], prefixArgs: string[] = []) => {
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => reservation.close(() => done()));
  const url = `ws://127.0.0.1:${address.port}`;
  const args = [...prefixArgs, "app-server", "--listen", url, ...overrides.flatMap((value) => ["-c", value])];
  const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000_000); });
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  const clients: RpcClient[] = [];
  launches.push({ binary, version: version.stdout.trim(), builtRevision, args, cwd, env });
  const connect = async () => {
    const client = await RpcClient.connect(url);
    clients.push(client);
    await client.request("initialize", { clientInfo: { name: "agent_spike_permissions", version: "0.0.0" }, capabilities: { experimentalApi: true } });
    client.send({ method: "initialized", params: {} });
    return client;
  };
  const close = async () => {
    for (const client of clients) client.close();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await closed;
    clearTimeout(timer);
    transcripts.push({ clients: clients.map((client) => client.transcript), stderr });
  };
  return { connect, close };
};
const summarize = (state: ThreadState) => ({ threadId: state.thread.id, approvalPolicy: state.approvalPolicy, sandbox: state.sandbox, activePermissionProfile: state.activePermissionProfile });
const snapshot = async (client: RpcClient, threadId: string, overrides: Message = {}) => client.request<ThreadState>("thread/resume", { threadId, excludeTurns: true, ...overrides });
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const runTurn = async (client: RpcClient, threadId: string, label: string, overrides: Message = {}) => {
  const output = join(artifacts, `${label}.txt`);
  fixture.actions.push({ name: "exec_command", arguments: { cmd: `printf permissions-probe > ${shellQuote(output)}`, workdir: cwd, yield_time_ms: 1_000 } }, { text: `Completed ${label}.` });
  const requestStart = fixture.requests.length;
  const start = await client.request<{ turn: { id: string } }>("turn/start", { threadId, input: [{ type: "text", text: `Run bounded local fixture ${label}.` }], ...overrides });
  const event = await client.waitFor((event) => {
    const params = event.params as { threadId?: string; turn?: { id?: string } } | undefined;
    return event.method === "turn/completed" && params?.threadId === threadId && params.turn?.id === start.turn.id;
  });
  const wroteFile = await access(output).then(() => true, () => false);
  if (wroteFile) assert.equal(await readFile(output, "utf8"), "permissions-probe");
  const latestRequest = fixture.requests.at(-1)?.body as { input?: { type: string; output?: string }[] } | undefined;
  const toolOutput = latestRequest?.input?.findLast((item) => item.type === "function_call_output")?.output;
  assert.equal(typeof toolOutput, "string", "Expected a real tool result in the fixture continuation");
  if (wroteFile) assert.match(toolOutput!, /exited with code 0/);
  else assert.match(toolOutput!, /operation not permitted|permission denied/i);
  const state = await snapshot(client, threadId);
  observations.push({ label, wroteFile, state: summarize(state), completed: event, toolOutput, fixtureRequests: fixture.requests.length - requestStart });
  assert.equal(fixture.actions.length, 0, `Fixture actions unconsumed for ${label}`);
  return { wroteFile, state };
};

let runtime: Awaited<ReturnType<typeof launch>> | undefined;
let success = false;
try {
  runtime = await launch();
  const clientA = await runtime.connect();
  const account = await clientA.request("account/read", { refreshToken: false });
  assert.equal(account.account, null);
  observations.push({ label: "startup-requirements", result: await clientA.request("configRequirements/read") });
  const full = await clientA.request<ThreadState>("thread/start", { cwd, sandbox: "danger-full-access", approvalPolicy: "never" });
  const defaultThread = await clientA.request<ThreadState>("thread/start", { cwd });
  const independentFull = await clientA.request<ThreadState>("thread/start", { cwd, sandbox: "danger-full-access", approvalPolicy: "never" });
  observations.push({ label: "different-threads-same-process", explicit: summarize(full), default: summarize(defaultThread) });
  assert.equal(full.sandbox.type, "dangerFullAccess");
  assert.equal(defaultThread.sandbox.type, "readOnly");
  assert.equal((await runTurn(clientA, independentFull.thread.id, "independent-first")).wroteFile, true);
  assert.equal((await runTurn(clientA, full.thread.id, "full-first")).wroteFile, true);
  assert.equal((await runTurn(clientA, full.thread.id, "full-inherited")).wroteFile, true);
  const fork = await clientA.request<ThreadState>("thread/fork", { threadId: full.thread.id, excludeTurns: true });
  observations.push({ label: "fork-without-overrides", state: summarize(fork) });
  await runTurn(clientA, fork.thread.id, "fork-inherited");
  const clientB = await runtime.connect();
  const joined = await snapshot(clientB, full.thread.id, { sandbox: "read-only", approvalPolicy: "on-request" });
  observations.push({ label: "second-client-conflicting-warm-resume", state: summarize(joined) });
  assert.equal(joined.sandbox.type, "dangerFullAccess");
  const changed = await runTurn(clientB, full.thread.id, "second-client-restricts", { sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" });
  assert.equal(changed.wroteFile, false);
  const independentState = await snapshot(clientA, independentFull.thread.id);
  assert.equal(independentState.sandbox.type, "dangerFullAccess");
  observations.push({ label: "other-thread-unaffected", state: summarize(independentState) });
  const originalRejoins = await snapshot(clientA, full.thread.id, { sandbox: "danger-full-access", approvalPolicy: "never" });
  observations.push({ label: "original-client-full-resume-ignored", state: summarize(originalRejoins) });
  assert.equal(originalRejoins.sandbox.type, "readOnly");
  assert.equal((await runTurn(clientA, full.thread.id, "restriction-inherited")).wroteFile, false);
  assert.equal((await runTurn(clientA, full.thread.id, "explicit-turn-restores", { sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" })).wroteFile, true);
  const directTarget = join(artifacts, "command-exec-independent.txt");
  const direct = await clientA.request("command/exec", { command: ["/bin/sh", "-c", `printf separate > ${shellQuote(directTarget)}`], cwd, timeoutMs: 5_000 });
  observations.push({ label: "command-exec-omitted-policy", result: direct, wroteFile: await access(directTarget).then(() => true, () => false) });
  await runtime.close();
  runtime = await launch();
  const restarted = await runtime.connect();
  const cold = await snapshot(restarted, full.thread.id);
  observations.push({ label: "cold-resume-without-overrides", state: summarize(cold) });
  await runTurn(restarted, full.thread.id, "cold-inherited");
  const explicitFork = await restarted.request<ThreadState>("thread/fork", { threadId: full.thread.id, excludeTurns: true, sandbox: "danger-full-access", approvalPolicy: "never" });
  observations.push({ label: "explicit-fork", state: summarize(explicitFork) });
  assert.equal((await runTurn(restarted, explicitFork.thread.id, "explicit-fork-writes")).wroteFile, true);
  await runtime.close();
  runtime = await launch();
  const explicitResumer = await runtime.connect();
  const explicitCold = await snapshot(explicitResumer, full.thread.id, { sandbox: "danger-full-access", approvalPolicy: "never" });
  observations.push({ label: "explicit-cold-resume", state: summarize(explicitCold) });
  assert.equal((await runTurn(explicitResumer, full.thread.id, "explicit-cold-writes")).wroteFile, true);
  await runtime.close();
  runtime = await launch(['sandbox_mode="danger-full-access"', 'approval_policy="never"']);
  const fullDefaultClient = await runtime.connect();
  const fullDefault = await fullDefaultClient.request<ThreadState>("thread/start", { cwd });
  observations.push({ label: "process-full-default", state: summarize(fullDefault) });
  assert.equal((await runTurn(fullDefaultClient, fullDefault.thread.id, "process-full-writes")).wroteFile, true);
  const fullDefaultFork = await fullDefaultClient.request<ThreadState>("thread/fork", { threadId: fullDefault.thread.id, excludeTurns: true });
  observations.push({ label: "process-full-default-fork", state: summarize(fullDefaultFork) });
  assert.equal((await runTurn(fullDefaultClient, fullDefaultFork.thread.id, "process-full-fork-writes")).wroteFile, true);
  assert.equal((await runTurn(fullDefaultClient, fullDefault.thread.id, "process-default-can-be-overridden", { sandboxPolicy: { type: "readOnly" } })).wroteFile, false);
  await runtime.close();
  runtime = await launch([], ["--dangerously-bypass-approvals-and-sandbox"]);
  const cliFlagClient = await runtime.connect();
  const cliFlagDefault = await cliFlagClient.request<ThreadState>("thread/start", { cwd });
  observations.push({ label: "root-cli-bypass-flag", state: summarize(cliFlagDefault) });
  await runTurn(cliFlagClient, cliFlagDefault.thread.id, "root-cli-flag-write");
  const wrongField = await cliFlagClient.request<ThreadState>("thread/start", { cwd, sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" });
  observations.push({ label: "thread-start-wrong-policy-field", state: summarize(wrongField) });
  assert.deepEqual(fixture.errors, []);
  success = true;
} finally {
  await runtime?.close();
  await fixture.close();
  await writeFile(join(artifacts, "level-0.json"), JSON.stringify({ launches, scratch }, null, 2), { mode: 0o600 });
  await writeFile(join(artifacts, "level-1.json"), JSON.stringify(transcripts, null, 2), { mode: 0o600 });
  await writeFile(join(artifacts, "level-2-fixture.json"), JSON.stringify(fixture.requests, null, 2), { mode: 0o600 });
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ success, version: version.stdout.trim(), builtRevision, binary, observations, fixtureErrors: fixture.errors, paidModelCalls: 0 }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ success, version: version.stdout.trim(), observations: observations.map((observation) => ({ label: observation.label, wroteFile: observation.wroteFile, state: observation.state })), artifacts }, null, 2));
}
