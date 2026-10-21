import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Rpc } from '../030-codex-remote-operations/rpc.mjs';

// No provider credentials or model turn: a native local shell turn materializes history.
const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(process.env.HP_CODEX_BINARY ?? join(root, 'artifacts/003-codex-control/target/debug/codex'));
const directory = join(root, 'artifacts/040-hp-integration', `native-${Date.now()}`);
await mkdir(directory, { recursive: true });
const isolated = await mkdtemp(join(tmpdir(), 'hp-native-contract-'));
const rpc = Rpc.stdio(binary, isolated, isolated, join(directory, 'wire.jsonl'));
const exit = once(rpc.child, 'exit');
const report = { binary, version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
  sourceRevision: execFileSync('git', ['-C', join(root, 'vendor/codex'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  date: new Date().toISOString(), paidResponses: 0, cases: {} };
try {
  await rpc.initialize();
  report.cases.start = await rpc.request('thread/start', {
    cwd: isolated, model: 'gpt-6-luna', approvalPolicy: 'never', sandbox: 'danger-full-access',
    experimentalRawEvents: false, persistExtendedHistory: true,
  });
  const threadId = report.cases.start.thread.id;
  report.cases.shell = await rpc.request('thread/shellCommand', {
    threadId, command: 'printf HP_NATIVE_CONTRACT', timeoutMs: 2000,
  });
  await rpc.wait(e => e.method === 'turn/completed' && e.params.threadId === threadId);
  report.cases.read = await rpc.request('thread/read', { threadId, includeTurns: true });
  report.cases.list = await rpc.request('thread/list', { limit: 10, sourceKinds: [] });
  report.cases.fork = await rpc.request('thread/fork', { threadId });
  assert.notEqual(report.cases.fork.thread.id, threadId);
  assert(report.cases.read.thread.turns.length > 0);
  const completed = rpc.events.find(e => e.method === 'turn/completed');
  report.fields = {
    start: Object.keys(report.cases.start), thread: Object.keys(report.cases.start.thread),
    turn: Object.keys(completed.params.turn), list: Object.keys(report.cases.list),
    fork: Object.keys(report.cases.fork), read: Object.keys(report.cases.read),
    notifications: [...new Set(rpc.events.map(e => e.method))],
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, directory, ...report.fields, paidResponses: 0 }, null, 2));
} finally {
  rpc.close();
  const kill = setTimeout(() => rpc.child.kill('SIGKILL'), 2000);
  await exit;
  clearTimeout(kill);
  await rm(isolated, { recursive: true, force: true });
}
