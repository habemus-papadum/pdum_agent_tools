import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { analyze, type Data } from "./analyze.js";

process.umask(0o077);
const directory = resolve(process.argv[2] ?? ".");
const invocation = JSON.parse(readFileSync(join(directory, "level0.json"), "utf8")) as Data;
const previous = JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) as Data;
const evidence = analyze(directory);
const ids = [...new Set(evidence.requests.map((entry: Data) => entry.threadId).filter(Boolean))];
const env = Object.fromEntries(Object.entries(invocation.env).filter(([key]) => !/proxy|certificate/i.test(key))) as NodeJS.ProcessEnv;
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
save("recovery-level0.json", { binary: invocation.binary, args: invocation.args, cwd: invocation.cwd, env, inferenceRequested: false });
const child = spawn(invocation.binary, invocation.args, { env, cwd: invocation.cwd, stdio: ["pipe", "pipe", "pipe"] });
const closed = new Promise<void>((done) => child.once("close", () => done()));
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
const pending = new Map<number, { resolve: (result: Data) => void; reject: (error: Error) => void }>();
const record = (direction: string, message: Data) => appendFileSync(join(directory, "recovery-level1.jsonl"), JSON.stringify({ time: new Date().toISOString(), direction, message }) + "\n", { mode: 0o600 });
const send = (message: Data) => { record("client", message); child.stdin.write(JSON.stringify(message) + "\n"); };
createInterface({ input: child.stdout }).on("line", (line) => {
  let message: Data;
  try { message = JSON.parse(line); } catch { return; }
  record("server", message);
  if (message.method && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Recovery is read-only" } });
  else if (typeof message.id === "number") {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error("History read failed; inspect private recovery transcript")); else request?.resolve(message.result);
  }
});
let sequence = 0;
async function request(method: string, params: Data) {
  const id = ++sequence;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<Data>((resolveRequest, reject) => {
      pending.set(id, { resolve: resolveRequest, reject });
      timer = setTimeout(() => { pending.delete(id); reject(new Error("Recovery request timed out")); }, 15_000);
      send({ id, method, params });
    });
  } finally { clearTimeout(timer); }
}
try {
  await request("initialize", { clientInfo: { name: "spike_010_read_only_recovery", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  const histories = [];
  for (const threadId of ids) {
    const history = await request("thread/read", { threadId, includeTurns: true });
    save(`history-${threadId}.json`, history);
    assert.equal(history.thread.id, threadId);
    if (threadId !== previous.parentId) assert.equal(history.thread.parentThreadId, previous.parentId);
    assert(history.thread.turns.some((turn: Data) => turn.status === "completed"));
    histories.push({ threadId, parentThreadId: history.thread.parentThreadId, turns: history.thread.turns.length, path: history.thread.path });
  }
  assert.equal(histories.length, 3);
  save("history-recovery.json", { passed: true, inferenceRequested: false, histories, originalError: previous.error });
  save("analysis.json", evidence);
  console.log(JSON.stringify({ directory, recoveredThreads: histories.length, inferenceRequested: false, apiEquivalentUsd: evidence.apiEquivalentUsd }));
} finally {
  child.stdin.end();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  await closed;
  clearTimeout(timeout);
  save("recovery-stderr.json", stderr);
}
