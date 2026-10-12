import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc } from "./rpc.js";

type Thread = { id: string; path: string | null; turns: { items: unknown[] }[] };
type ThreadResult = { thread: Thread };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const binary = await realpath(resolve(process.env.SPIKE_CODEX_BIN ?? join(homedir(), ".local/bin/codex")));
const output = join(root, "artifacts/005-codex-auth-storage", `run-${Date.now()}`);
const temporary = await mkdtemp(join(tmpdir(), "agent-spike-auth-storage-"));
const cwd = join(temporary, "work");
await Promise.all([mkdir(output, { recursive: true, mode: 0o700 }), mkdir(cwd)]);
const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
assert.equal(version.status, 0);
const sourceRevision = spawnSync("git", ["-C", join(root, "vendor/codex"), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const requests: { authorization: string; priorMarker: boolean; importedMarker: boolean }[] = [];
let expectedBearer = "fixture-key-A";
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
    response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
    return;
  }
  let payload = "";
  for await (const chunk of request) payload += String(chunk);
  const authorization = request.headers.authorization === `Bearer ${expectedBearer}` ? "expected-fixture-token" : "unexpected";
  requests.push({ authorization, priorMarker: payload.includes("STORAGE_MARKER"), importedMarker: payload.includes("IMPORTED_CONTEXT_MARKER") });
  const responseId = `resp_${randomUUID()}`;
  const events = [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `msg_${randomUUID()}`, content: [{ type: "output_text", text: "STORAGE_MARKER fixture response" }] } },
    { type: "response.completed", response: { id: responseId, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}/v1`;
const clients: Rpc[] = [];
const results: Record<string, unknown> = { version: version.stdout.trim(), binary, sourceRevision, temporary, output, liveModelCalls: 0 };
const profile = join(temporary, "profile");
const start = async (name: string, home: string, commandAuth = false) => {
  const evidence = join(output, name);
  const codexHome = join(home, ".codex");
  await Promise.all([mkdir(evidence, { recursive: true }), mkdir(codexHome, { recursive: true })]);
  const env = { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: temporary, LANG: "en_US.UTF-8" };
  const overrides = [
    'cli_auth_credentials_store="file"', "analytics.enabled=false", "feedback.enabled=false", "features.apps=false", "features.plugins=false", "skills.bundled.enabled=false",
    "features.enable_request_compression=false", 'model_provider="fixture"', 'model="gpt-5.4"',
    'model_providers.fixture.name="Local fixture"', `model_providers.fixture.base_url=${JSON.stringify(endpoint)}`,
    'model_providers.fixture.wire_api="responses"', "model_providers.fixture.supports_websockets=false",
    `model_providers.fixture.requires_openai_auth=${!commandAuth}`,
  ];
  if (commandAuth) overrides.push(`model_providers.fixture.auth.command="/bin/cat"`, `model_providers.fixture.auth.args=[${JSON.stringify(join(temporary, "token.txt"))}]`, "model_providers.fixture.auth.refresh_interval_ms=100");
  const args = ["app-server", "--listen", "stdio://", ...overrides.flatMap((value) => ["-c", value])];
  await writeFile(join(evidence, "level-0.json"), JSON.stringify({ binary, args, env, cwd }, null, 2), { mode: 0o600 });
  const client = new Rpc(binary, args, env, cwd, evidence);
  clients.push(client);
  await client.request("initialize", { clientInfo: { name: "agent_spike_005", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  client.send({ method: "initialized", params: {} });
  return client;
};
const turn = async (client: Rpc, threadId: string, text: string) => {
  const result = await client.request<{ turn: { id: string } }>("turn/start", { threadId, input: [{ type: "text", text }] });
  const completed = await client.wait("turn/completed", (params) => (params.turn as { id: string }).id === result.turn.id);
  assert.equal((completed.turn as { status: string }).status, "completed");
};
const threadParams = { cwd, approvalPolicy: "never", sandbox: "read-only" };
try {
  const first = await start("managed-profile", profile);
  assert.equal((await first.request("account/read", { refreshToken: false })).account, null);
  const login = await first.request<{ loginId: string; authUrl: string }>("account/login/start", { type: "chatgpt" });
  assert.equal(new URL(login.authUrl).hostname, "auth.openai.com");
  await first.request("account/login/cancel", { loginId: login.loginId });
  results.browserLogin = "authorization URL returned, then canceled; browser sign-in not completed";
  await first.request("account/login/start", { type: "apiKey", apiKey: expectedBearer });
  const authPath = join(profile, ".codex/auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8")) as { OPENAI_API_KEY: string };
  assert.equal(auth.OPENAI_API_KEY, expectedBearer);
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  results.apiKeySaved = true;
  const original = await first.request<ThreadResult>("thread/start", threadParams);
  await turn(first, original.thread.id, "Produce the fixed storage fixture answer; do not use tools.");
  await first.close();
  clients.splice(clients.indexOf(first), 1);

  const second = await start("restarted-profile", profile);
  assert.equal((await second.request<{ account: { type: string } }>("account/read", { refreshToken: false })).account.type, "apiKey");
  const resumed = await second.request<ThreadResult>("thread/resume", { threadId: original.thread.id, ...threadParams });
  assert.ok(JSON.stringify(resumed.thread.turns).includes("STORAGE_MARKER"));
  const forked = await second.request<ThreadResult>("thread/fork", { threadId: original.thread.id, ...threadParams });
  assert.notEqual(forked.thread.id, original.thread.id);
  assert.ok(JSON.stringify(forked.thread.turns).includes("STORAGE_MARKER"));
  await turn(second, resumed.thread.id, "Continue from the persisted conversation.");
  expectedBearer = "fixture-key-B";
  await second.request("account/login/start", { type: "apiKey", apiKey: expectedBearer });
  await turn(second, resumed.thread.id, "Continue using the replaced fixture credential.");
  results.storage = { resumedId: resumed.thread.id, forkedId: forked.thread.id, rolloutPath: resumed.thread.path, restartPreservedHistory: true, forkPreservedHistory: true };
  results.apiKeySurvivedRestartAndReplacement = true;
  await second.close();
  clients.splice(clients.indexOf(second), 1);

  expectedBearer = "fixture-command-A";
  await writeFile(join(temporary, "token.txt"), expectedBearer, { mode: 0o600 });
  const commandHome = join(temporary, "command-profile");
  const command = await start("command-auth", commandHome, true);
  const dynamic = await command.request<ThreadResult>("thread/start", threadParams);
  await turn(command, dynamic.thread.id, "Use the command token.");
  expectedBearer = "fixture-command-B";
  await writeFile(join(temporary, "token.txt"), expectedBearer, { mode: 0o600 });
  await new Promise((done) => setTimeout(done, 150));
  await turn(command, dynamic.thread.id, "Use the renewed command token.");
  const authFileCreated = await access(join(commandHome, ".codex/auth.json")).then(() => true, () => false);
  assert.equal(authFileCreated, false);
  results.commandAuth = { refreshedBetweenTurns: true, authFileCreated };
  const imported = await command.request<ThreadResult>("thread/resume", {
    threadId: randomUUID(), ...threadParams,
    history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Imported user context" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "IMPORTED_CONTEXT_MARKER" }] }],
  });
  await turn(command, imported.thread.id, "Continue from the imported context.");
  assert.equal(requests.at(-1)?.importedMarker, true);
  results.experimentalHistoryImport = { reachedNextModelRequest: true, initialResponseTurns: imported.thread.turns.length };
  assert.equal(requests.length, 6);
  assert.ok(requests.every((request) => request.authorization === "expected-fixture-token"));
  assert.equal(requests[1]?.priorMarker, true);
  results.fixtureRequests = requests;
  results.profileFiles = await readdir(join(profile, ".codex"));
  const validationHome = join(temporary, "validation-profile");
  await mkdir(join(validationHome, ".codex"), { recursive: true });
  const validationEnv = { HOME: validationHome, CODEX_HOME: join(validationHome, ".codex"), PATH: "/usr/bin:/bin", TMPDIR: temporary };
  const incompleteWif = spawnSync(binary, ["app-server", "--listen", "stdio://"], {
    env: { ...validationEnv, OPENAI_FEDERATION_RULE_ID: "fixture-rule-not-real" }, cwd, input: "", encoding: "utf8", timeout: 10_000,
  });
  assert.match(incompleteWif.stderr, /OPENAI_IDENTITY_TOKEN_FILE/);
  assert.notEqual(incompleteWif.status, 0);
  results.incompleteWorkloadIdentityFailsClosed = incompleteWif.stderr.trim();
  const remoteStore = spawnSync(binary, ["app-server", "--listen", "stdio://", "-c", 'experimental_thread_store_endpoint="http://127.0.0.1:1"'], {
    env: validationEnv, cwd, input: "", encoding: "utf8", timeout: 10_000,
  });
  assert.match(remoteStore.stderr, /no longer supported/);
  assert.notEqual(remoteStore.status, 0);
  results.remoteStoreEndpointRejected = remoteStore.stderr.trim();
  results.passed = true;
} finally {
  await Promise.all(clients.map((client) => client.close()));
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await writeFile(join(output, "result.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(results, null, 2));
}
