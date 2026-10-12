import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "./rpc.js";

type Message = Record<string, unknown>;
type State = { thread: { id: string }; model: string; approvalPolicy: string; sandbox: { type: string } };
type Settings = { model: string; approvalPolicy: string; sandboxPolicy: { type: string } };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, "artifacts/006-codex-permissions", `config-${Date.now()}`);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-spike-config-")));
const binary = await realpath(process.env.SPIKE_CODEX_BIN ?? join(homedir(), ".local/bin/codex"));
const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
assert.equal(version.status, 0);
const sourcePin = spawnSync("git", ["-C", join(root, "vendor/codex"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const results: Message[] = [];
const transcripts: Message[] = [];
let success = false;

try {
  for (const pinned of [false, true]) {
    const home = join(scratch, pinned ? "cli-pinned" : "file-defaults");
    const codexHome = join(home, ".codex");
    const cwd = join(home, "work");
    await Promise.all([codexHome, cwd].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
    const configPath = join(codexHome, "config.toml");
    await writeFile(configPath, `model = "gpt-6-luna"
model_provider = "unused"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
analytics.enabled = false
feedback.enabled = false
skills.bundled.enabled = false
[features]
apps = false
plugins = false
shell_snapshot = false
[model_providers.unused]
name = "No inference in this control-plane probe"
base_url = "http://127.0.0.1:9"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((done) => reservation.close(() => done()));
    const url = `ws://127.0.0.1:${address.port}`;
    const args = ["app-server", "--listen", url, ...(pinned ? ["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "-c", 'model="gpt-6-luna"'] : [])];
    const env = { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1_000_000); });
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    let client: RpcClient | undefined;
    try {
      client = await RpcClient.connect(url);
      await client.request("initialize", { clientInfo: { name: "agent_spike_config", version: "0.0.0" }, capabilities: { experimentalApi: true } });
      client.send({ method: "initialized", params: {} });
      const account = await client.request("account/read", { refreshToken: false });
      assert.equal(account.account, null);
      const before = await client.request<State>("thread/start", { cwd });
      const write = await client.request("config/value/write", { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "replace" });
      const afterSingle = await client.request<State>("thread/start", { cwd });
      const batch = await client.request("config/batchWrite", {
        edits: [
          { keyPath: "approval_policy", value: "on-request", mergeStrategy: "replace" },
          { keyPath: "model", value: "gpt-6-sol", mergeStrategy: "replace" },
        ],
        reloadUserConfig: true,
      });
      const configRead = await client.request("config/read", { includeLayers: true });
      const afterBatch = await client.request<State>("thread/start", { cwd });
      const eventStart = client.events.length;
      await client.request("thread/settings/update", { threadId: before.thread.id, effort: "low" });
      const settingsEvent = await client.waitFor((event) => client!.events.indexOf(event) >= eventStart && event.method === "thread/settings/updated" && (event.params as Message)?.threadId === before.thread.id);
      const existing = (settingsEvent.params as { threadSettings: Settings }).threadSettings;
      const outputPath = join(artifacts, `${pinned ? "pinned" : "file"}-command.txt`);
      const direct = await client.request("command/exec", { command: ["/bin/sh", "-c", `printf control-plane > '${outputPath.replaceAll("'", "'\\''")}'`], cwd, timeoutMs: 5_000 });
      const commandWrote = await readFile(outputPath, "utf8").then(() => true, () => false);
      results.push({ pinned, before, write, afterSingle, batch, configRead, afterBatch, existing, direct, commandWrote });
      assert.equal(before.sandbox.type, "readOnly");
      assert.equal(afterSingle.sandbox.type, pinned ? "readOnly" : "dangerFullAccess");
      assert.equal(afterBatch.sandbox.type, pinned ? "readOnly" : "dangerFullAccess");
      assert.equal(afterBatch.approvalPolicy, pinned ? "never" : "on-request");
      assert.equal(afterBatch.model, pinned ? "gpt-6-luna" : "gpt-6-sol");
      assert.equal(existing.sandboxPolicy.type, "readOnly");
      assert.equal(existing.approvalPolicy, "never");
      assert.equal(existing.model, "gpt-6-luna");
      assert.equal(commandWrote, false);
    } finally {
      client?.close();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await closed;
      clearTimeout(timer);
      transcripts.push({ args, cwd, env, stderr, transcript: client?.transcript });
    }
  }
  success = true;
} finally {
  await writeFile(join(artifacts, "level-0.json"), JSON.stringify({ binary, version: version.stdout.trim(), inspectedSourcePin: sourcePin, scratch, launches: transcripts.map(({ args, cwd, env }) => ({ args, cwd, env })) }, null, 2), { mode: 0o600 });
  await writeFile(join(artifacts, "level-1.json"), JSON.stringify(transcripts, null, 2), { mode: 0o600 });
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ success, binary, version: version.stdout.trim(), inspectedSourcePin: sourcePin, modelCalls: 0, scratch, results }, null, 2), { mode: 0o600 });
  const summarize = (state: unknown) => {
    const value = state as State;
    return { model: value.model, sandbox: value.sandbox.type, approvalPolicy: value.approvalPolicy };
  };
  console.log(JSON.stringify({ success, artifacts, version: version.stdout.trim(), results: results.map(({ pinned, before, afterSingle, afterBatch, existing, commandWrote }) => ({ pinned, before: summarize(before), afterSingle: summarize(afterSingle), afterBatch: summarize(afterBatch), existing, commandWrote })) }, null, 2));
}
