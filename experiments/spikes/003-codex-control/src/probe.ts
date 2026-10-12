import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, "artifacts/003-codex-control");
const runDirectory = join(artifacts, `probe-${new Date().toISOString().replaceAll(":", "-")}`);
const binary = process.env.SPIKE_CODEX_BIN
  ? resolve(process.env.SPIKE_CODEX_BIN)
  : join(artifacts, "target/debug/codex");
const home = join(runDirectory, "home");
const codexHome = join(home, ".codex");
const cwd = join(runDirectory, "work");
await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(cwd, { recursive: true })]);
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  CODEX_HOME: codexHome,
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: "en_US.UTF-8",
};
const versionResult = spawnSync(binary, ["--version"], { cwd, env, encoding: "utf8", timeout: 15_000 });
if (versionResult.error || versionResult.status !== 0) {
  throw versionResult.error ?? new Error(`Version command failed: ${versionResult.stderr}`);
}
const version = versionResult.stdout.trim();
const args = ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"', "-c", "analytics.enabled=false", "-c", "feedback.enabled=false"];
await writeFile(join(runDirectory, "level-0.json"), JSON.stringify({ binary, version, args, cwd, env, startedAt: new Date().toISOString() }, null, 2));
const processHandle = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
const closed = new Promise<void>((resolveClosed) => processHandle.once("close", () => resolveClosed()));
const messages: { direction: string; message: unknown }[] = [];
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let stderr = "";
let nextId = 1;
const rejectPending = (error: Error) => {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
};
processHandle.once("error", rejectPending);
processHandle.once("close", (code, signal) => rejectPending(new Error(`App-server closed: ${code ?? signal}`)));
processHandle.stderr.setEncoding("utf8");
processHandle.stderr.on("data", (chunk: string) => { stderr += chunk; });
const lines = createInterface({ input: processHandle.stdout });
const send = (message: unknown) => {
  messages.push({ direction: "client", message });
  processHandle.stdin.write(`${JSON.stringify(message)}\n`);
};
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line) as Record<string, unknown>;
    messages.push({ direction: "server", message });
    if ("method" in message && "id" in message) {
      send({ id: message.id, error: { code: -32601, message: "This bounded probe does not handle interactive requests" } });
      return;
    }
    if (typeof message.id === "number") {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      }
    }
  } catch (error) {
    rejectPending(error instanceof Error ? error : new Error(String(error)));
  }
});
const request = async (method: string, params: unknown): Promise<unknown> => {
  const id = nextId++;
  let timer: NodeJS.Timeout;
  try {
    return await new Promise<unknown>((resolveRequest, reject) => {
      timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15_000);
      pending.set(id, { resolve: resolveRequest, reject });
      send({ id, method, params });
    });
  } finally {
    clearTimeout(timer!);
  }
};
try {
  const initialized = await request("initialize", {
    clientInfo: { name: "agent_spike_003", title: "Agent spike 003", version: "0.0.0" },
    capabilities: { experimentalApi: false },
  });
  send({ method: "initialized", params: {} });
  const account = await request("account/read", { refreshToken: false }) as { account: unknown };
  assert.equal(account.account, null, "Isolated instance must not reuse developer credentials");
  const threads = await request("thread/list", { limit: 10 }) as { data: unknown[] };
  assert.deepEqual(threads.data, [], "Isolated instance must have no developer threads");
  const command = await request("command/exec", {
    command: ["/usr/bin/printf", "agent-spike-003-ok"],
    cwd,
    sandboxPolicy: { type: "dangerFullAccess" },
    timeoutMs: 5_000,
  }) as { exitCode: number; stdout: string };
  assert.equal(command.exitCode, 0);
  assert.equal(command.stdout, "agent-spike-003-ok");
  await writeFile(join(runDirectory, "result.json"), JSON.stringify({ version, initialized, account, threads, command, modelCallsRequested: 0 }, null, 2));
  console.log(JSON.stringify({ version, initialized, isolatedAccount: true, isolatedThreads: true, commandSucceeded: true, artifacts: runDirectory }, null, 2));
} finally {
  processHandle.stdin.end();
  const terminateTimer = setTimeout(() => processHandle.kill("SIGTERM"), 2_000);
  const killTimer = setTimeout(() => processHandle.kill("SIGKILL"), 4_000);
  await closed;
  clearTimeout(terminateTimer);
  clearTimeout(killTimer);
  lines.close();
  await writeFile(join(runDirectory, "level-1.jsonl"), messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  await writeFile(join(runDirectory, "stderr.log"), stderr);
}
