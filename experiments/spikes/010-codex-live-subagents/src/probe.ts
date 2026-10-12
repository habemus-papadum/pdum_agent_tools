import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { analyze, type Data } from "./analyze.js";
import { verify } from "./verify.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const luna = process.argv.includes("--luna");
const model = "gpt-6-sol";
const binary = realpathSync(resolve(process.env.SPIKE_CODEX_BIN ?? join(homedir(), ".local/bin/codex")));
const sourceAuth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const rawAuth = readFileSync(sourceAuth, "utf8");
const authHash = digest(rawAuth);
let accessToken: string;
let accountId: string;
try {
  const credentials = JSON.parse(rawAuth) as Data;
  accessToken = credentials.tokens?.access_token;
  accountId = credentials.tokens?.account_id;
  if (typeof accessToken !== "string" || !accessToken || typeof accountId !== "string" || !accountId) throw new Error();
} catch { throw new Error("Existing authentication unavailable or malformed; contents withheld"); }
process.umask(0o077);
const artifacts = join(root, "artifacts/010-codex-live-subagents", `${Date.now()}-${luna ? "luna" : "inherit"}`);
const isolated = mkdtempSync(join(tmpdir(), "agent-spike-010-"));
const home = join(isolated, "home");
const codexHome = join(home, ".codex");
const work = join(isolated, "work");
for (const path of [artifacts, codexHome, work, join(artifacts, "ca")]) mkdirSync(path, { recursive: true, mode: 0o700 });
const scrub = (value: unknown) => JSON.stringify(value, (key, item: unknown) => /^(authorization|accessToken|chatgptAccountId|account_id|email)$/i.test(key) ? "[REDACTED]" : item).replaceAll(accessToken, "[REDACTED]").replaceAll(accountId, "[REDACTED]");
const save = (name: string, value: unknown) => writeFileSync(join(artifacts, name), scrub(value), { mode: 0o600 });
const envBase: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: isolated, LANG: "en_US.UTF-8" };
const processes: ChildProcess[] = [];
const closed = new Map<ChildProcess, Promise<void>>();
let fatal: string | undefined;
const helper = (command: string, args: string[], env: NodeJS.ProcessEnv, name: string) => {
  const process = spawn(command, args, { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
  processes.push(process);
  let stderr = "";
  process.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 4_194_304) fatal = "Stderr limit exceeded"; });
  process.on("error", () => { fatal = `${name} failed to launch`; });
  closed.set(process, new Promise<void>((done) => process.once("close", () => { save(`${name}-stderr.json`, stderr); done(); })));
  return process;
};
async function stop(process: ChildProcess) {
  if (process.exitCode === null && process.signalCode === null) {
    process.stdin?.end();
    process.kill("SIGINT");
    await Promise.race([closed.get(process), delay(2000)]);
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
  }
  await closed.get(process);
}
async function until(predicate: () => boolean, timeout = 30_000) {
  const started = Date.now();
  while (!predicate()) {
    if (fatal) throw new Error(fatal);
    if (Date.now() - started > timeout) throw new Error("Observation timed out; inspect private evidence");
    await delay(100);
  }
}
const socket = createServer();
await new Promise<void>((done, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", done); });
const address = socket.address();
assert(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((done) => socket.close(() => done()));
const proxyUrl = `http://127.0.0.1:${port}`;
const ca = join(artifacts, "ca/mitmproxy-ca-cert.pem");
const summary: Data = { artifacts, isolated, binary, model, childSelection: luna ? "explicit gpt-6-luna" : "inherit parent", sourceRevision: spawnSync("git", ["-C", join(root, "vendor/codex"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() };
const messages: Data[] = [];
let recordedBytes = 0;
let app: ChildProcess | undefined;
const watchdog = setInterval(() => {
  const observed = analyze(artifacts);
  const cost = observed.apiEquivalentUsd.total;
  if (observed.unknownPriceResponses > 0) fatal = "Observed model or tier outside the priced experiment";
  if (cost > 0.20) fatal = "Observed API-equivalent cost crossed $0.20 per-run limit";
  if (fatal) app?.kill("SIGTERM");
}, 1000);
const deadline = setTimeout(() => { fatal = "Three-minute probe deadline exceeded"; app?.kill("SIGTERM"); }, 180_000);
try {
  const proxy = helper(join(root, ".venv/bin/mitmdump"), ["--listen-host", "127.0.0.1", "--listen-port", String(port), "--set", `confdir=${join(artifacts, "ca")}`, "--set", "connection_strategy=lazy", "--set", "flow_detail=0", "-q", "-s", join(root, "spikes/004-codex-traffic/python/capture.py")], { ...envBase, SPIKE_CAPTURE_DIR: artifacts, SPIKE_REDACT_SECRET: accessToken, SPIKE_REDACT_ACCOUNT_ID: accountId, SPIKE_BODY_LIMIT: "8388608", SPIKE_FILE_LIMIT: "100663296" }, "proxy");
  await until(() => existsSync(ca) && existsSync(join(artifacts, "level2.jsonl")) || proxy.exitCode !== null);
  assert.equal(proxy.exitCode, null);
  await delay(150);
  const env = { ...envBase, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "", CODEX_CA_CERTIFICATE: ca };
  const overrides = ['cli_auth_credentials_store="file"', "analytics.enabled=false", "feedback.enabled=false", "features.apps=false", "features.plugins=false", "skills.bundled.enabled=false", "features.multi_agent=true", "features.enable_request_compression=false", "agents.max_threads=3", "agents.max_depth=1", 'model_reasoning_effort="low"', 'web_search="disabled"'];
  const args = ["app-server", "--listen", "stdio://", ...overrides.flatMap((value) => ["-c", value])];
  const version = spawnSync(binary, ["--version"], { env, cwd: work, encoding: "utf8", timeout: 10_000 });
  assert.equal(version.status, 0);
  summary.version = version.stdout.trim();
  save("level0.json", { binary, args, env, cwd: work, version: summary.version, sha256: digest(readFileSync(binary)) });
  app = helper(binary, args, env, "app-server");
  const child = app;
  child.stdin!.on("error", () => { fatal = "App-server input closed"; });
  const pending = new Map<number, { resolve: (value: Data) => void; reject: (reason: Error) => void }>();
  const record = (direction: string, message: Data) => {
    const line = scrub({ time: new Date().toISOString(), direction, message }) + "\n";
    recordedBytes += Buffer.byteLength(line);
    if (recordedBytes > 32 * 1024 * 1024) { fatal = "Level1 capture limit exceeded"; return; }
    appendFileSync(join(artifacts, "level1.jsonl"), line, { mode: 0o600 });
  };
  const send = (message: Data) => { record("client", message); child.stdin!.write(JSON.stringify(message) + "\n"); };
  const rejectPending = () => { for (const request of pending.values()) request.reject(new Error(fatal ?? "App-server disconnected")); pending.clear(); };
  child.once("close", rejectPending);
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let message: Data;
    try { message = JSON.parse(line) as Data; } catch { fatal = "Invalid protocol JSON; contents withheld"; rejectPending(); return; }
    record("server", message);
    if (messages.length < 20_000) messages.push(message); else fatal = "Protocol message limit exceeded";
    if ("method" in message && "id" in message) send({ id: message.id, error: { code: -32601, message: "Probe rejects approvals and credential refresh" } });
    else if (typeof message.id === "number") {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(scrub(message.error))); else request?.resolve(message.result as Data);
    }
  });
  let sequence = 0;
  async function request(method: string, params: Data = {}): Promise<Data> {
    const id = ++sequence;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<Data>((resolveRequest, reject) => {
        pending.set(id, { resolve: resolveRequest, reject });
        timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 25_000);
        send({ id, method, params });
      });
    } finally { clearTimeout(timer); }
  }
  await request("initialize", { clientInfo: { name: "agent_spike_010", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  await request("account/login/start", { type: "chatgptAuthTokens", accessToken, chatgptAccountId: accountId });
  const models = await request("model/list", { includeHidden: true });
  save("models.json", models);
  const available = models.data.map((entry: Data) => entry.model);
  assert(available.includes(model), "Exact requested gpt-6-sol is absent; refusing a model substitution");
  if (luna) assert(available.includes("gpt-6-luna"), "Luna model unavailable");
  const parent = await request("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "read-only", ephemeral: false, model });
  summary.parentId = String(parent.thread.id);
  const selection = luna ? "Explicitly set model to gpt-6-luna and reasoning effort to low in each spawn call. Use fresh context (fork_turns=none, or fork_context=false for the older tool)." : "Use fresh context (fork_turns=none, or fork_context=false for the older tool). Omit model and reasoning overrides so both children inherit your model and effort.";
  const prompt = `This is a small live test of model-driven delegation. Use your spawn_agent tool to create exactly two subagents; do not answer the two tasks yourself. ${selection} Child one: compute 17 * 19 and reply only ARITHMETIC=323. Child two: alphabetically sort pear, apple, kiwi and reply only SORT=apple,kiwi,pear. Instruct each child not to use tools, not to spawn children, and to keep its answer to one line. Spawn both before waiting, wait for both final answers, then give a final two-line report containing both results. No shell, files, browsing, or other work. If spawning or requested model selection is unavailable, report that briefly rather than substituting a model.`;
  save("prompt.json", { prompt });
  await request("turn/start", { threadId: summary.parentId, input: [{ type: "text", text: prompt }] });
  const done = (id: string) => messages.find((message) => message.method === "turn/completed" && message.params?.threadId === id);
  await until(() => Boolean(done(summary.parentId)), 150_000);
  summary.parentTurn = done(summary.parentId)?.params.turn;
  const wire = analyze(artifacts);
  const childIds = [...new Set(wire.requests.filter((entry: Data) => entry.parentId === summary.parentId).map((entry: Data) => String(entry.threadId)))];
  summary.childIds = childIds;
  const histories: Data[] = [];
  for (const id of [summary.parentId, ...childIds]) {
    const history = await request("thread/read", { threadId: id, includeTurns: true });
    save(`history-${id}.json`, history);
    histories.push({ id, parentThreadId: history.thread.parentThreadId, turns: history.thread.turns, path: history.thread.path });
  }
  summary.histories = histories;
  summary.complete = summary.parentTurn?.status === "completed" && childIds.length === 2 && histories.every((history) => history.turns.some((turn: Data) => turn.status === "completed"));
  summary.appServerPid = child.pid;
  summary.level1Bytes = recordedBytes;
  if (fatal) throw new Error(fatal);
} catch (error) { summary.error = error instanceof Error ? error.message : "Probe failed"; }
finally {
  clearInterval(watchdog);
  clearTimeout(deadline);
  for (const process of processes.reverse()) await stop(process);
  summary.sourceAuthUnchanged = digest(readFileSync(sourceAuth, "utf8")) === authHash;
  const analysis = analyze(artifacts);
  save("analysis.json", analysis);
  summary.captureComplete = analysis.captureStats?.events_dropped === 0 && analysis.truncatedRecords === 0 && analysis.malformedRecords === 0 && analysis.undecodedWebSocketBodies === 0 && analysis.httpDecodeErrors === 0 && analysis.unmatchedRequests === 0 && recordedBytes <= 32 * 1024 * 1024;
  summary.apiEquivalentUsd = analysis.apiEquivalentUsd;
  if (!summary.error) {
    try { summary.verification = verify(artifacts, summary); }
    catch { summary.error = "Evidence verification failed; inspect private artifacts"; }
  }
  save("result.json", summary);
  console.log(scrub({ artifacts, version: summary.version, model, childSelection: summary.childSelection, childIds: summary.childIds, complete: summary.complete, captureComplete: summary.captureComplete, cost: summary.apiEquivalentUsd, error: summary.error }));
}
assert(!summary.error && summary.sourceAuthUnchanged, "Probe failed; inspect private result.json");
