import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type RecordValue = Record<string, unknown>;
type Inventory = { data: { name: string; tools: RecordValue }[]; nextCursor: string | null };
type SkillInventory = { data: { cwd: string; skills: { name: string; path: string; enabled: boolean }[]; errors: unknown[] }[] };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const binary = await realpath(resolve(process.env.SPIKE_CODEX_BIN ?? join(homedir(), ".local/bin/codex")));
const artifacts = join(root, "artifacts/003-codex-control", `isolation-${Date.now()}`);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const sandbox = await mkdtemp(join(tmpdir(), "agent-spike-codex-"));
const home = join(sandbox, "home");
const codexHome = join(home, ".codex");
const work = join(sandbox, "work");
const fixtureWork = join(sandbox, "fixture-work");
const skillPath = join(fixtureWork, ".agents/skills/scope-fixture/SKILL.md");
await Promise.all([codexHome, work, join(fixtureWork, ".agents/skills/scope-fixture")].map((path) => mkdir(path, { recursive: true })));
await writeFile(skillPath, "---\nname: scope-fixture\ndescription: Inert skill for discovery testing.\n---\nThis is a discovery fixture, not an instruction to execute anything.\n");
const env = { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: sandbox, LANG: "en_US.UTF-8" };
const version = spawnSync(binary, ["--version"], { env, cwd: work, encoding: "utf8", timeout: 15_000 });
assert.equal(version.status, 0);
const overrides = [
  'cli_auth_credentials_store="file"', "analytics.enabled=false", "feedback.enabled=false",
  "features.apps=false", "features.plugins=false", "skills.bundled.enabled=false",
];
const args = ["app-server", "--listen", "stdio://", ...overrides.flatMap((value) => ["-c", value])];
await writeFile(join(artifacts, "level-0.json"), JSON.stringify({ binary, version: version.stdout.trim(), args, env, cwd: work }, null, 2), { mode: 0o600 });
const child = spawn(binary, args, { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
const closed = new Promise<void>((done) => child.once("close", () => done()));
const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
const secrets: string[] = [];
const redact = (value: unknown): string => {
  let text = JSON.stringify(value);
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
  return text.replace(/"(?:accessToken|email|chatgptAccountId)":"[^"]*"/g, '"redacted":"[REDACTED]"');
};
const transcript: string[] = [];
let stderr = "";
let nextId = 1;
const rejectAll = (error: Error) => {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
};
child.once("error", rejectAll);
child.once("close", () => rejectAll(new Error("App-server closed")));
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-1_048_576); });
const send = (message: unknown) => {
  transcript.push(redact({ direction: "client", message }));
  child.stdin.write(`${JSON.stringify(message)}\n`);
};
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line) as RecordValue;
    transcript.push(redact({ direction: "server", message }));
    if ("method" in message && "id" in message) {
      send({ id: message.id, error: { code: -32601, message: "Probe does not refresh credentials or approve actions" } });
    } else if (typeof message.id === "number") {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(redact(message.error)));
      else request?.resolve(message.result);
    }
  } catch {
    rejectAll(new Error("Invalid app-server response"));
  }
});
const request = async <Result = RecordValue>(method: string, params: unknown = {}): Promise<Result> => {
  const id = nextId++;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<unknown>((resolveRequest, reject) => {
      timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
      pending.set(id, { resolve: resolveRequest, reject });
      send({ id, method, params });
    }) as Result;
  } finally {
    clearTimeout(timer);
  }
};
const results: RecordValue = { version: version.stdout.trim(), binary, artifacts, sandbox, modelCallsRequested: 0 };
const sourceAuth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
let authHash: string | undefined;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
try {
  await request("initialize", { clientInfo: { name: "agent_spike_isolation", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  const accountBefore = await request("account/read", { refreshToken: false });
  assert.equal(accountBefore.account, null);
  const config = await request("config/read", { includeLayers: true });
  results.configBefore = config;
  const initialMcp = await request<Inventory>("mcpServerStatus/list", {});
  assert.deepEqual(initialMcp.data, []);
  const initialSkills = await request<SkillInventory>("skills/list", { cwds: [work], forceReload: true });
  assert.deepEqual(initialSkills.data.flatMap((entry) => entry.skills), []);
  assert.deepEqual(initialSkills.data.flatMap((entry) => entry.errors), []);
  results.initialMcp = initialMcp;
  results.initialSkills = initialSkills;

  const rawAuth = await readFile(sourceAuth, "utf8");
  authHash = digest(rawAuth);
  let auth: { tokens?: { access_token?: string; account_id?: string } };
  try { auth = JSON.parse(rawAuth) as typeof auth; } catch { throw new Error("Invalid local auth file; contents withheld"); }
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  assert.ok(typeof accessToken === "string" && accessToken.length > 0, "No existing ChatGPT access token");
  assert.ok(typeof accountId === "string" && accountId.length > 0, "No existing ChatGPT account ID");
  secrets.push(accessToken, accountId);
  await request("account/login/start", { type: "chatgptAuthTokens", accessToken, chatgptAccountId: accountId });
  const accountAfter = await request<{ account: { type: string } }>("account/read", { refreshToken: false });
  assert.equal(accountAfter.account.type, "chatgpt");
  results.auth = { type: accountAfter.account.type, mode: "chatgptAuthTokens", rateLimitsAccepted: false };
  const limits = await request("account/rateLimits/read");
  assert.ok(limits.rateLimits);
  results.auth = { type: accountAfter.account.type, mode: "chatgptAuthTokens", rateLimitsAccepted: true };

  const start = { cwd: work, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" };
  const withMcp = await request<{ thread: { id: string } }>("thread/start", {
    ...start,
    config: { "mcp_servers.scope_fixture": { command: process.execPath, args: [fileURLToPath(new URL("./mcp-fixture.ts", import.meta.url))] } },
  });
  const withoutMcp = await request<{ thread: { id: string } }>("thread/start", start);
  const scopedMcp = await request<Inventory>("mcpServerStatus/list", { threadId: withMcp.thread.id });
  const otherMcp = await request<Inventory>("mcpServerStatus/list", { threadId: withoutMcp.thread.id });
  const globalMcp = await request<Inventory>("mcpServerStatus/list");
  assert.deepEqual(scopedMcp.data.map((server) => server.name), ["scope_fixture"]);
  assert.ok(scopedMcp.data[0]?.tools.fixture_ping);
  assert.deepEqual(otherMcp.data, []);
  assert.deepEqual(globalMcp.data, []);
  results.mcp = { withOverride: scopedMcp, otherThread: otherMcp, global: globalMcp };
  const skills = await request<SkillInventory>("skills/list", { cwds: [work, fixtureWork], forceReload: true });
  assert.deepEqual(skills.data.find((entry) => entry.cwd === work)?.skills, []);
  const discovered = skills.data.flatMap((entry) => entry.skills);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.name, "scope-fixture");
  assert.equal(discovered[0]?.enabled, true);
  results.skillsBeforeWrite = skills;
  await request("skills/config/write", { path: skillPath, enabled: false });
  const disabled = await request<SkillInventory>("skills/list", { cwds: [fixtureWork], forceReload: true });
  assert.equal(disabled.data[0]?.skills[0]?.enabled, false);
  const writtenConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  assert.ok(writtenConfig.includes("enabled = false"));
  results.skillsAfterWrite = disabled;
  results.skillsWritePersistedInIsolatedHome = true;
  const authFileCreated = await access(join(codexHome, "auth.json")).then(() => true, () => false);
  assert.equal(authFileCreated, false);
  results.authFileCreated = authFileCreated;
  results.passed = true;
} finally {
  child.stdin.end();
  const terminate = setTimeout(() => child.kill("SIGTERM"), 2_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 4_000);
  await closed;
  clearTimeout(terminate);
  clearTimeout(kill);
  lines.close();
  if (authHash) results.sourceAuthUnchanged = digest(await readFile(sourceAuth, "utf8")) === authHash;
  await writeFile(join(artifacts, "level-1.jsonl"), transcript.join("\n") + "\n", { mode: 0o600 });
  await writeFile(join(artifacts, "stderr.json"), redact(stderr), { mode: 0o600 });
  await writeFile(join(artifacts, "result.json"), redact(results), { mode: 0o600 });
  console.log(JSON.stringify({ passed: results.passed ?? false, version: results.version, auth: results.auth, sourceAuthUnchanged: results.sourceAuthUnchanged, artifacts, sandbox }, null, 2));
  if (authHash) assert.equal(results.sourceAuthUnchanged, true, "Developer auth file changed during the probe");
}
