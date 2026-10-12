import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type Data = Record<string, any>;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const spike = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const websocket = process.argv.includes("--websocket");
const binary = realpathSync(resolve(process.env.SPIKE_CODEX_BIN ?? join(homedir(), ".local/bin/codex")));
process.umask(0o077);
const artifacts = join(root, "artifacts/004-codex-traffic", `${Date.now()}-${live ? "live" : websocket ? "websocket" : "sse"}`);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const isolated = mkdtempSync(join(tmpdir(), "agent-spike-004-"));
const home = join(isolated, "home");
const codexHome = join(home, ".codex");
const work = join(isolated, "work");
for (const directory of [codexHome, work, join(artifacts, "ca")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
const secrets = ["spike-fixture-credential"];
let auth: { accessToken: string; accountId: string } | undefined;
let authHash: string | undefined;
const sourceAuth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
const digest = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
if (live) {
  const raw = readFileSync(sourceAuth, "utf8");
  authHash = digest(raw);
  try {
    const parsed = JSON.parse(raw) as Data;
    const accessToken = parsed?.tokens?.access_token;
    const accountId = parsed?.tokens?.account_id;
    if (typeof accessToken !== "string" || !accessToken || typeof accountId !== "string" || !accountId) throw new Error();
    auth = { accessToken, accountId };
    secrets.push(accessToken, accountId);
  } catch {
    throw new Error("Existing Codex authentication data is unavailable or malformed; contents withheld");
  }
}
function redact(input: unknown): string {
  let serialized = JSON.stringify(input, (key, value: unknown) => /^(authorization|accessToken|chatgptAccountId|email|account_id)$/i.test(key) ? "[REDACTED]" : value);
  for (const secret of secrets) serialized = serialized.replaceAll(secret, "[REDACTED]");
  return serialized;
}
const save = (name: string, value: unknown) => writeFileSync(join(artifacts, name), redact(value), { mode: 0o600 });
const processes: ChildProcess[] = [];
const processClosed = new Map<ChildProcess, Promise<void>>();
const helperErrors: string[] = [];
const baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, CODEX_HOME: codexHome, TMPDIR: isolated, LANG: "en_US.UTF-8" };
const helper = (command: string, args: string[], env: NodeJS.ProcessEnv, name: string) => {
  const child = spawn(command, args, { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
  processes.push(child);
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-1_048_576); });
  processClosed.set(child, new Promise<void>((closed) => child.once("close", () => { save(`${name}-stderr.json`, errors); closed(); })));
  child.once("error", () => { helperErrors.push(`${name} could not launch`); });
  return child;
};
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((closed) => server.close(() => closed()));
  return address.port;
}
async function until(check: () => boolean, timeout = 30_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (helperErrors.length > 0) throw new Error(helperErrors[0]);
    if (Date.now() - start > timeout) throw new Error("Bounded observation timed out; inspect private artifacts");
    await delay(50);
  }
}
async function stop(child: ChildProcess): Promise<void> {
  const closed = processClosed.get(child);
  if (child.exitCode !== null || child.signalCode !== null) { await closed; return; }
  child.stdin?.end();
  child.kill("SIGINT");
  await Promise.race([closed, delay(1500)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await closed;
}

const proxyPort = await freePort();
const fixturePort = await freePort();
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const ca = join(artifacts, "ca/mitmproxy-ca-cert.pem");
const summary: Data = { live, websocketRequested: websocket, artifacts, isolated, binary, sourceRevision: spawnSync("git", ["-C", join(root, "vendor/codex"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() };
let app: ChildProcess | undefined;
let completed = false;
const deadline = setTimeout(() => { for (const child of processes) child.kill("SIGTERM"); }, 90_000);
try {
  if (!live) helper(join(root, ".venv/bin/python"), [join(spike, "python/fixture.py"), String(fixturePort)], baseEnv, "fixture");
  const proxy = helper(join(root, ".venv/bin/mitmdump"), [
    "--listen-host", "127.0.0.1", "--listen-port", String(proxyPort),
    "--set", `confdir=${join(artifacts, "ca")}`, "--set", "connection_strategy=lazy",
    ...(!live ? ["--set", "upstream_cert=false"] : []), "--set", "flow_detail=0", "-q", "-s", join(spike, "python/capture.py"),
  ], { ...baseEnv, SPIKE_CAPTURE_DIR: artifacts, SPIKE_REDACT_SECRET: auth?.accessToken ?? secrets[0], ...(auth ? { SPIKE_REDACT_ACCOUNT_ID: auth.accountId } : {}), ...(!live ? { SPIKE_FIXTURE_PORT: String(fixturePort) } : {}) }, "proxy");
  await until(() => existsSync(ca) && existsSync(join(artifacts, "level2.jsonl")) || proxy.exitCode !== null);
  assert.equal(proxy.exitCode, null, "Proxy exited during startup");
  await delay(150);
  const env = {
    ...baseEnv, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
    https_proxy: proxyUrl, http_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "",
    CODEX_CA_CERTIFICATE: ca, SPIKE_FIXTURE_KEY: "spike-fixture-credential",
  };
  const overrides = [
    'cli_auth_credentials_store="file"', "analytics.enabled=false", "feedback.enabled=false",
    "features.apps=false", "features.plugins=false", "skills.bundled.enabled=false",
    "features.multi_agent=true", "features.enable_request_compression=false", "agents.max_threads=2", "agents.max_depth=1",
    "model_reasoning_effort=\"low\"", "web_search=\"disabled\"",
    ...(!live ? [
      'model_provider="spike_fixture"', 'model_providers.spike_fixture.name="spike_fixture"',
      'model_providers.spike_fixture.base_url="https://fixture.agent-spike.invalid/v1"',
      'model_providers.spike_fixture.env_key="SPIKE_FIXTURE_KEY"',
      'model_providers.spike_fixture.wire_api="responses"',
      `model_providers.spike_fixture.supports_websockets=${websocket}`,
      "model_providers.spike_fixture.requires_openai_auth=false",
      "model_providers.spike_fixture.request_max_retries=0", "model_providers.spike_fixture.stream_max_retries=0",
    ] : []),
  ];
  const args = ["app-server", "--listen", "stdio://", ...overrides.flatMap((override) => ["-c", override])];
  const version = spawnSync(binary, ["--version"], { env, cwd: work, encoding: "utf8", timeout: 10_000 });
  assert.equal(version.status, 0);
  summary.version = version.stdout.trim();
  save("level0.json", { command: binary, args, cwd: work, env, version: summary.version, sha256: digest(readFileSync(binary)), sourceRevision: summary.sourceRevision });
  app = helper(binary, args, env, "app-server");
  const child = app;
  const messages: Data[] = [];
  let bytes = 0;
  let dropped = 0;
  function record(direction: string, message: Data): void {
    const line = redact({ time: new Date().toISOString(), direction, message }) + "\n";
    if (bytes + Buffer.byteLength(line) > 16 * 1024 * 1024) { dropped++; return; }
    bytes += Buffer.byteLength(line);
    appendFileSync(join(artifacts, "level1.jsonl"), line, { mode: 0o600 });
  }
  const pending = new Map<number, { resolve: (value: Data) => void; reject: (error: Error) => void }>();
  const rejectAll = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  child.once("close", () => rejectAll(new Error("App-server closed")));
  child.once("error", rejectAll);
  const send = (message: Data) => { record("client", message); child.stdin!.write(`${JSON.stringify(message)}\n`); };
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let message: Data;
    try { message = JSON.parse(line) as Data; } catch { rejectAll(new Error("Invalid app-server response; contents withheld")); return; }
    record("server", message);
    if (messages.length < 20_000) messages.push(message);
    if ("method" in message && "id" in message) send({ id: message.id, error: { code: -32601, message: "Probe does not approve actions or refresh tokens" } });
    else if (typeof message.id === "number") {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(redact(message.error)));
      else request?.resolve(message.result as Data);
    }
  });
  let nextId = 1;
  async function request(method: string, params: Data = {}): Promise<Data> {
    const identifier = nextId++;
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await new Promise<Data>((resolveRequest, reject) => {
        pending.set(identifier, { resolve: resolveRequest, reject });
        timeout = setTimeout(() => { pending.delete(identifier); reject(new Error(`${method} timed out`)); }, 25_000);
        send({ id: identifier, method, params });
      });
    } finally { clearTimeout(timeout); }
  }
  await request("initialize", { clientInfo: { name: "agent_spike_004", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  if (auth) await request("account/login/start", { type: "chatgptAuthTokens", accessToken: auth.accessToken, chatgptAccountId: auth.accountId });
  const model = process.env.SPIKE_MODEL ?? (live ? "gpt-6-luna" : "gpt-5.4");
  summary.model = model;
  const threadOptions = { cwd: work, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", model };
  const regular = await request("thread/start", threadOptions);
  const regularId = String(regular.thread.id);
  await request("turn/start", { threadId: regularId, input: [{ type: "text", text: "Reply with exactly REGULAR_OK. Do not use tools.", text_elements: [] }] });
  const doneFor = (identifier: string) => messages.find((message) => message.method === "turn/completed" && message.params?.threadId === identifier);
  await until(() => Boolean(doneFor(regularId)), 45_000);
  summary.regular = { threadId: regularId, turn: doneFor(regularId)?.params.turn };
  assert.equal(summary.regular.turn.status, "completed");
  if (!live) {
    const parent = await request("thread/start", threadOptions);
    const parentId = String(parent.thread.id);
    await request("turn/start", { threadId: parentId, input: [{ type: "text", text: "SPIKE_PARENT_SPAWN: spawn one child, then finish.", text_elements: [] }] });
    await until(() => Boolean(doneFor(parentId)));
    summary.parent = { threadId: parentId, turn: doneFor(parentId)?.params.turn };
    assert.equal(summary.parent.turn.status, "completed");
    const childCompleted = () => messages.find((message) => message.method === "turn/completed" && ![regularId, parentId].includes(String(message.params?.threadId)));
    await until(() => Boolean(childCompleted()), 5000);
    const childId = String(childCompleted()?.params.threadId);
    summary.child = { threadId: childId, turn: childCompleted()?.params.turn };
    assert.equal(summary.child.turn.status, "completed");
    summary.childRead = await request("thread/read", { threadId: childId, includeTurns: false });
    assert.equal(summary.childRead.thread.parentThreadId, parentId);
    assert.equal(summary.childRead.thread.modelProvider, "spike_fixture");
  }
  summary.appServerPid = child.pid;
  const snapshot = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).stdout;
  summary.childProcessesAtEnd = snapshot.split("\n").filter((line) => Number(line.trim().split(/\s+/)[1]) === child.pid).map((line) => line.trim());
  summary.level1 = { bytes, dropped };
  completed = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : "Probe failed";
} finally {
  clearTimeout(deadline);
  for (const process of processes.reverse()) await stop(process);
  if (authHash) summary.sourceAuthUnchanged = digest(readFileSync(sourceAuth, "utf8")) === authHash;
  const captureFile = join(artifacts, "level2.jsonl");
  const records: Data[] = existsSync(captureFile) ? readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Data) : [];
  const requests = records.filter((record) => record.kind === "request");
  const websocketRequests = records.filter((record) => record.kind === "websocket" && record.from_client && record.body?.type === "response.create");
  const modelRequests = [...records.filter((record) => record.kind === "request_body" && record.body?.model), ...websocketRequests];
  if (completed) {
    assert(modelRequests.length > 0, "No model request was captured");
    if (!live) {
      const childFlow = requests.find((record) => record.headers?.["x-codex-parent-thread-id"] === summary.parent.threadId && record.headers?.["x-openai-subagent"] === "collab_spawn");
      assert(childFlow, "No child model connection was captured");
      assert(modelRequests.some((record) => record.flow_id === childFlow.flow_id), "Child connection had no captured model request");
      assert(records.some((record) => record.flow_id === childFlow.flow_id && JSON.stringify(record.body ?? record.data ?? null).includes("CHILD_OK")), "Child model result was not captured");
      if (websocket) assert(websocketRequests.length > 0, "Requested WebSocket mode did not use WebSockets");
      else assert(records.some((record) => record.kind === "sse"), "Requested SSE mode did not use SSE");
    }
    assert.equal(summary.sourceAuthUnchanged ?? true, true, "Existing auth file changed");
  }
  summary.capture = {
    counts: Object.fromEntries([...new Set(records.map((record) => String(record.kind)))].map((kind) => [kind, records.filter((record) => record.kind === kind).length])),
    requests: requests.map((record) => ({ method: record.method, url: record.url, httpVersion: record.http_version, session: record.headers?.session_id, parent: record.headers?.["x-codex-parent-thread-id"], subagent: record.headers?.["x-openai-subagent"] })),
    protocols: [...new Set(records.map((record) => record.http_version).filter(Boolean))],
    modelRequests: modelRequests.length,
    websocketWarmups: websocketRequests.filter((record) => record.body?.generate === false).length,
    websocketDeltaRequests: websocketRequests.filter((record) => record.body?.previous_response_id).length,
  };
  summary.passed = completed;
  save("result.json", summary);
  console.log(redact({ passed: summary.passed, version: summary.version, live, websocketRequested: websocket, counts: summary.capture.counts, artifacts, error: summary.error }));
}
assert(completed, "Probe did not complete; inspect private result.json");
