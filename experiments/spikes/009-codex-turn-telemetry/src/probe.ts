import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { analyzeCapture } from "./usage.js";

type Data = Record<string, any>;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const binary = realpathSync(resolve(process.env.SPIKE_CODEX_BIN ?? join(homedir(), ".local/bin/codex")));
assert.equal(process.argv.length, 2, "This probe accepts no arguments; use analyze for offline replay");
process.umask(0o077);
const artifacts = join(root, "artifacts/009-codex-turn-telemetry", `run-${Date.now()}`);
const isolated = mkdtempSync(join(tmpdir(), "agent-spike-009-"));
const home = join(isolated, "home");
const codexHome = join(home, ".codex");
const work = join(isolated, "work");
for (const directory of [codexHome, work, join(artifacts, "ca")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
const digest = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const sourceAuth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
const sourceAuthText = readFileSync(sourceAuth, "utf8");
const sourceAuthHash = digest(sourceAuthText);
const parsedAuth = JSON.parse(sourceAuthText) as Data;
const accessToken = parsedAuth.tokens?.access_token;
const accountId = parsedAuth.tokens?.account_id;
assert(typeof accessToken === "string" && accessToken && typeof accountId === "string" && accountId, "Existing subscription authentication is unavailable; no credentials printed");
const secrets: string[] = [accessToken, accountId];
function redact(input: unknown): string {
  let serialized = JSON.stringify(input, (key, value: unknown) => /^(authorization|accessToken|chatgptAccountId|email|account_id|refresh_token|id_token)$/i.test(key) ? "[REDACTED]" : value);
  for (const secret of secrets) serialized = serialized.replaceAll(secret, "[REDACTED]");
  return serialized;
}
const save = (name: string, value: unknown) => writeFileSync(join(artifacts, name), redact(value), { mode: 0o600 });
const processes: ChildProcess[] = [];
const closed = new Map<ChildProcess, Promise<void>>();
const stderrBytes: Record<string, number> = {};
const stderrDropped: Record<string, number> = {};
let failure: Error | undefined;
const baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, CODEX_HOME: codexHome, TMPDIR: isolated, LANG: "en_US.UTF-8" };
function helper(command: string, args: string[], env: NodeJS.ProcessEnv, name: string): ChildProcess {
  const child = spawn(command, args, { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
  processes.push(child);
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = `${redact({ time: new Date().toISOString(), text: chunk.toString() })}\n`;
    const size = Buffer.byteLength(line);
    if ((stderrBytes[name] ?? 0) + size > 8 * 1024 * 1024) { stderrDropped[name] = (stderrDropped[name] ?? 0) + 1; return; }
    stderrBytes[name] = (stderrBytes[name] ?? 0) + size;
    appendFileSync(join(artifacts, `${name}-stderr.jsonl`), line, { mode: 0o600 });
  });
  closed.set(child, new Promise<void>((done) => child.once("close", () => done())));
  child.once("error", () => { failure = new Error(`${name} could not launch`); });
  return child;
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}
async function until(check: () => boolean, timeout = 30_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (failure) throw failure;
    if (Date.now() - start > timeout) throw new Error("Bounded observation timed out; inspect private artifacts");
    await delay(25);
  }
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    child.kill("SIGINT");
    await Promise.race([closed.get(child), delay(1500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await closed.get(child);
}

const proxyPort = await freePort();
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const ca = join(artifacts, "ca/mitmproxy-ca-cert.pem");
const summary: Data = { live: true, artifacts, isolated, binary, sourceRevision: spawnSync("git", ["-C", join(root, "vendor/codex"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), turns: [], callbackSnapshots: [], toolCalls: [], rejectedToolCalls: [] };
const messages: Data[] = [];
let level1Bytes = 0;
let level1Dropped = 0;
let complete = false;
let nextStep = 1;
let challenge = "";
console.log("Three live turns: one multi-step Luna turn and two tiny Sol replies to verify override stickiness. Target below $0.15 API equivalent; no model fallback.");
const deadline = setTimeout(() => { failure = new Error("180-second probe deadline exceeded"); for (const child of processes) child.kill("SIGTERM"); }, 180_000);
try {
  const proxy = helper(join(root, ".venv/bin/mitmdump"), [
    "--listen-host", "127.0.0.1", "--listen-port", String(proxyPort), "--set", `confdir=${join(artifacts, "ca")}`,
    "--set", "connection_strategy=lazy", "--set", "flow_detail=0", "-q", "-s", join(root, "spikes/004-codex-traffic/python/capture.py"),
  ], { ...baseEnv, SPIKE_CAPTURE_DIR: artifacts, SPIKE_REDACT_SECRET: accessToken, SPIKE_REDACT_ACCOUNT_ID: accountId, SPIKE_FILE_LIMIT: "67108864", SPIKE_BODY_LIMIT: "4194304" }, "proxy");
  await until(() => (existsSync(ca) && existsSync(join(artifacts, "level2.jsonl"))) || proxy.exitCode !== null);
  assert.equal(proxy.exitCode, null, "Proxy exited during startup");
  await delay(150);
  const env = { ...baseEnv, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "", CODEX_CA_CERTIFICATE: ca };
  const overrides = [
    'model="gpt-6-sol"', 'cli_auth_credentials_store="file"', "analytics.enabled=false", "feedback.enabled=false",
    "features.apps=false", "features.plugins=false", "skills.bundled.enabled=false", "features.multi_agent=false",
    "features.enable_request_compression=false", 'model_reasoning_effort="low"', 'web_search="disabled"', 'service_tier="default"',
  ];
  const args = ["app-server", "--listen", "stdio://", ...overrides.flatMap((override) => ["-c", override])];
  const version = spawnSync(binary, ["--version"], { env, cwd: work, encoding: "utf8", timeout: 10_000 });
  assert.equal(version.status, 0);
  summary.version = version.stdout.trim();
  save("level0.json", { command: binary, args, cwd: work, env, version: summary.version, sha256: digest(readFileSync(binary)), sourceRevision: summary.sourceRevision, budgets: { wallClockSeconds: 180, targetEstimatedUsd: 0.15, toolCalls: 3, turns: 3 }, auth: "Existing access token supplied through redacted account/login/start, no credential file copied" });
  const app = helper(binary, args, env, "app-server");
  function record(direction: string, message: Data): void {
    const entry = { time: new Date().toISOString(), monotonicMs: performance.now(), direction, message };
    const line = `${redact(entry)}\n`;
    if (level1Bytes + Buffer.byteLength(line) > 32 * 1024 * 1024) { level1Dropped++; return; }
    level1Bytes += Buffer.byteLength(line);
    appendFileSync(join(artifacts, "level1.jsonl"), line, { mode: 0o600 });
  }
  const pending = new Map<number, { resolve: (value: Data) => void; reject: (error: Error) => void }>();
  const rejectAll = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  app.once("close", () => rejectAll(new Error("App-server closed")));
  app.once("error", rejectAll);
  const send = (message: Data) => { record("client", message); app.stdin!.write(`${JSON.stringify(message)}\n`); };
  let callbackChain = Promise.resolve();
  createInterface({ input: app.stdout! }).on("line", (line) => {
    let message: Data;
    try { message = JSON.parse(line) as Data; } catch { failure = new Error("Invalid app-server message; contents withheld"); rejectAll(failure); return; }
    record("server", message);
    if (messages.length >= 20_000) { failure = new Error("In-memory message bound exceeded"); return; }
    messages.push(message);
    if ("method" in message && "id" in message) {
      callbackChain = callbackChain.then(() => answerCallback(message)).catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error("Tool callback failed");
        send({ id: message.id, error: { code: -32603, message: "Probe callback failed" } });
      });
    } else if (typeof message.id === "number") {
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
  async function answerCallback(message: Data): Promise<void> {
    assert.equal(message.method, "item/tool/call", "Unexpected approval/auth callback; no approval or refresh granted");
    assert.equal(message.params.tool, "telemetry_step");
    const argumentsValue = message.params.arguments;
    assert(summary.toolCalls.length + summary.rejectedToolCalls.length < 12, "Too many tool calls");
    if (argumentsValue.step !== nextStep || nextStep > 3 || argumentsValue.challenge !== challenge) {
      summary.rejectedToolCalls.push({ step: argumentsValue.step, expectedStep: nextStep, callId: message.params.callId });
      send({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: `Rejected speculative or invalid call. Next required step is ${nextStep}. Use the exact nextChallenge returned by the most recent successful call. Issue only one call, wait for its result, then issue the next.` }] } });
      return;
    }
    const beforeReply = await observeRead(message.params.threadId);
    summary.callbackSnapshots.push({ step: nextStep, time: new Date().toISOString(), read: beforeReply });
    const result = { step: nextStep, nextChallenge: nextStep < 3 ? randomBytes(6).toString("hex") : "done" };
    challenge = result.nextChallenge;
    summary.toolCalls.push({ step: nextStep++, threadId: message.params.threadId, turnId: message.params.turnId, callId: message.params.callId });
    await delay(150);
    send({ id: message.id, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] } });
  }
  async function observeRead(threadId: string): Promise<Data> {
    try { return await request("thread/read", { threadId, includeTurns: true }); }
    catch (error) { return { observationError: error instanceof Error ? error.message : "Read failed" }; }
  }
  await request("initialize", { clientInfo: { name: "agent_spike_009", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  await request("account/login/start", { type: "chatgptAuthTokens", accessToken, chatgptAccountId: accountId });
  summary.config = await request("config/read");
  const options = { cwd: work, approvalPolicy: "never", sandbox: "read-only", serviceTier: "default" };
  const started = await request("thread/start", {
    ...options, model: "gpt-6-luna", dynamicTools: [{ type: "function", name: "telemetry_step", description: "Perform one telemetry experiment step. Call steps 1, 2, 3 sequentially; use an empty challenge for step 1 and the previous result's nextChallenge for each following step. Never batch or parallelize calls: each requires an unpredictable value returned only by the previous call.", inputSchema: { type: "object", properties: { step: { type: "integer", minimum: 1, maximum: 3 }, challenge: { type: "string" } }, required: ["step", "challenge"], additionalProperties: false } }],
  });
  summary.threadStart = started;
  assert.equal(started.model, "gpt-6-luna");
  const threadId = String(started.thread.id);
  async function runTurn(label: string, prompt: string, model?: string): Promise<void> {
    const sentAt = new Date().toISOString();
    const response = await request("turn/start", { threadId, ...(model ? { model } : {}), effort: "low", serviceTier: "default", input: [{ type: "text", text: prompt, text_elements: [] }] });
    const turnId = String(response.turn.id);
    const initialRead = await observeRead(threadId);
    const findDone = () => messages.find((message) => message.method === "turn/completed" && message.params?.threadId === threadId && message.params?.turn?.id === turnId);
    await until(() => Boolean(findDone()), 75_000);
    const done = findDone();
    const finalRead = await request("thread/read", { threadId, includeTurns: true });
    summary.turns.push({ label, requestedModel: model ?? null, sentAt, finishedAt: new Date().toISOString(), turnId, response, initialRead, completed: done?.params.turn, finalRead });
    assert.equal(done?.params.turn.status, "completed");
    const recent = analyzeCapture(artifacts, { requireComplete: false });
    assert(recent.includingWarmupEstimatedUsd < 0.15, "Spend sanity check exceeded target; no further turns");
  }
  await runTurn("luna-multistep", "This is a bounded telemetry experiment. Call telemetry_step three times, strictly sequentially: first step 1 with challenge empty string; then step 2 with the nextChallenge returned by step 1; then step 3 with the nextChallenge returned by step 2. Issue exactly one call at a time and wait for its result; never batch calls or guess challenges. Do not call any other tool. After step 3 succeeds, reply with exactly TELEMETRY_OK and stop.");
  assert.equal(summary.toolCalls.length, 3);
  await runTurn("sol-explicit", "Do not use any tools. Reply with exactly SOL_OVERRIDE_OK and stop.", "gpt-6-sol");
  await runTurn("model-omitted", "Do not use any tools. Reply with exactly STICKY_MODEL_OK and stop.");
  await delay(150);
  complete = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : "Probe failed";
} finally {
  clearTimeout(deadline);
  for (const child of processes.reverse()) await stop(child);
  summary.sourceAuthUnchanged = digest(readFileSync(sourceAuth, "utf8")) === sourceAuthHash;
  summary.level1 = { bytes: level1Bytes, dropped: level1Dropped };
  summary.stderr = { bytes: stderrBytes, dropped: stderrDropped };
  summary.passed = complete;
  save("result.json", summary);
  const report = analyzeCapture(artifacts, { requireComplete: complete });
  save("analysis.json", report);
  console.log(redact({ passed: complete, artifacts, version: summary.version, toolCalls: summary.toolCalls.length, turns: summary.turns.length, usage: report.usage, generatedEstimatedUsd: report.generatedEstimatedUsd, warmupEstimatedUsd: report.warmupEstimatedUsd, includingWarmupEstimatedUsd: report.includingWarmupEstimatedUsd, error: summary.error }));
}
assert(complete, "Live probe did not complete; inspect private artifacts");
assert.equal(summary.sourceAuthUnchanged, true, "Source authentication file changed");
