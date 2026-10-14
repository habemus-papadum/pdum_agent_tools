import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, Run } from './harness.mjs';

const source = JSON.parse(readFileSync(join(resolve(process.argv[2]), 'corpus.json')));
const run = new Run('026-codex-session-admin', { binary: resolve('artifacts/003-codex-control/target/debug/codex') });
cpSync(join(source.metadata.isolated, 'home/.codex'), run.codexHome, { recursive: true });
cpSync(join(source.metadata.isolated, 'work'), run.work, { recursive: true });
rmSync(join(run.codexHome, 'auth.json'), { force: true });
// Native state contains absolute paths. Rebase the experiment-owned clone before loading it.
execFileSync('uv', ['run', '--frozen', 'python', '-c', `
import pathlib, sqlite3, sys
old, new = sys.argv[1:]
base = pathlib.Path(new) / 'home/.codex'
def rebase(value):
    return value.replace('/private' + old, '/private' + new).replace(old, new)
for path in base.rglob('*.jsonl'):
    path.write_text(rebase(path.read_text()))
db = sqlite3.connect(base / 'state_5.sqlite')
for table, column in [('threads','rollout_path'),('threads','cwd'),('rollout_migration_skipped_rollouts','rollout_path'),('project_roots','path')]:
    for rowid, value in db.execute(f'SELECT rowid, {column} FROM {table}').fetchall():
        if isinstance(value, str) and old in value:
            db.execute(f'UPDATE {table} SET {column}=? WHERE rowid=?', (rebase(value), rowid))
db.commit()
`, source.metadata.isolated, run.isolated], { cwd: root, stdio: 'pipe' });
const result = { metadata: run.metadata, cases: {}, inference: false, sourceRevision: '6c372fbef45f730b6d8aa727b0ec8332365588db' };
try {
  let a = await run.start();
  let b = await run.connect('B');
  const record = async (label, method, params) => result.cases[label] = await a.rpc(method, params);
  const threadId = source.histories.paginated.threadId;
  const turn = source.histories.paginated.snapshots.restart.full.result.thread.turns[0];
  const initial = await record('read', 'thread/read', { threadId });
  const revision = initial.result.readState.revision;
  const unread = await record('markUnread', 'thread/readState/update', { threadId, operation: { type: 'unread' }, expectedRevision: revision });
  await record('staleRead', 'thread/readState/update', { threadId, operation: { type: 'read' }, expectedRevision: revision });
  await record('loadedAfterMark', 'thread/loaded/list', {});
  assert.deepEqual(result.cases.loadedAfterMark.result.data, []);
  const seq = run.events.length;
  await b.ok('thread/resume', { threadId, excludeTurns: true });
  await record('markRead', 'thread/readState/update', { threadId, operation: { type: 'read' }, expectedRevision: unread.result.readState.revision });
  await delay(50);
  result.bReadStateNotifications = run.events.slice(seq).filter(x => x.connection === 'B' && x.message.method === 'thread/readState/changed');
  await record('itemLookup', 'thread/items/read', { threadId, turnId: turn.id, itemIds: turn.items.map(x => x.id) });
  await record('itemLookupMixed', 'thread/items/read', { threadId, turnId: turn.id, itemIds: [turn.items[0].id, 'missing-item'] });
  await record('itemLookupEmpty', 'thread/items/read', { threadId, turnId: turn.id, itemIds: [] });
  const legacy = source.histories.legacy;
  const legacyTurn = legacy.snapshots.restart.full.result.thread.turns[0];
  await record('legacyItemLookup', 'thread/items/read', { threadId: legacy.threadId, turnId: legacyTurn.id, itemIds: [legacyTurn.items[0].id] });
  await run.stop();
  run.phase = 'restart';
  a = await run.start();
  await record('readRestart', 'thread/read', { threadId });
  await record('loadedRestart', 'thread/loaded/list', {});
  assert.equal(result.cases.readRestart.result.readState.firstUnread, null);
  result.passed = true;
} catch (error) { result.passed = false; result.error = error.stack; }
finally { await run.stop(); run.save('result.json', result); }
console.log(JSON.stringify({ passed: result.passed, artifacts: run.artifacts, error: result.error }));
if (!result.passed) process.exitCode = 1;
