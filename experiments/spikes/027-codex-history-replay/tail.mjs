import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Run, until } from '../026-codex-session-admin/harness.mjs';

const corpus = JSON.parse(readFileSync(join(resolve(process.argv[2]), 'corpus.json')));
const run = new Run('027-codex-history-replay', { isolated: corpus.metadata.isolated });
const result = { metadata: run.metadata, cases: {}, inference: false };
try {
  const a = await run.start();
  const record = async (label, method, params) => result.cases[label] = await a.rpc(method, params);
  const fork = await a.ok('thread/fork', { threadId: corpus.histories.paginated.threadId, excludeTurns: true });
  const threadId = fork.thread.id;
  result.threadId = threadId;
  const begin = run.events.length;
  await a.ok('thread/shellCommand', { threadId, command: 'printf TAIL_BEGIN; sleep 1; printf TAIL_END', timeoutMs: 5000 });
  await until(() => run.events.slice(begin).some(x => x.message.method === 'item/started' && x.message.params.item.type === 'commandExecution'));
  const activeTurn = run.events.slice(begin).find(x => x.message.method === 'turn/started').message.params.turn.id;
  await record('activeTurns', 'thread/turns/list', { threadId, limit: 1, itemsView: 'full' });
  await record('activeItems', 'thread/items/list', { threadId, turnId: activeTurn });
  await until(() => run.events.slice(begin).some(x => x.message.method === 'turn/completed' && x.message.params.turn.id === activeTurn));
  await record('completedItems', 'thread/items/list', { threadId, turnId: activeTurn });
  const first = await record('turnPage1', 'thread/turns/list', { threadId, limit: 1, sortDirection: 'asc', itemsView: 'summary' });
  const next = first.result.nextCursor;
  if (next) await record('turnPage2', 'thread/turns/list', { threadId, limit: 1, sortDirection: 'asc', cursor: next });
  const last = await record('turnDescending', 'thread/turns/list', { threadId, limit: 1, sortDirection: 'desc' });
  await record('turnReverseAnchor', 'thread/turns/list', { threadId, limit: 1, sortDirection: 'asc', cursor: last.result.backwardsCursor });
  const entries = await a.ok('thread/items/list', { threadId, turnId: corpus.turns[0].turn.id });
  const anchor = { type: 'item', itemId: entries.data[1].item.id };
  await record('itemAfterAnchor', 'thread/items/list', { threadId, turnId: corpus.turns[0].turn.id, cursor: anchor });
  await record('itemBeforeAnchor', 'thread/items/list', { threadId, turnId: corpus.turns[0].turn.id, cursor: anchor, sortDirection: 'desc' });
  await record('itemAnchorWithoutTurn', 'thread/items/list', { threadId, cursor: anchor });
  const capBegin = run.events.length;
  await a.ok('thread/shellCommand', { threadId, command: '/usr/bin/awk \'BEGIN {for(i=0;i<70000;i++)printf "X"}\'', timeoutMs: 5000 });
  await until(() => run.events.slice(capBegin).some(x => x.message.method === 'turn/completed' && x.message.params.threadId === threadId));
  const completed = run.events.slice(capBegin).find(x => x.message.method === 'item/completed' && x.message.params.item.type === 'commandExecution').message.params;
  await record('longOutputHistory', 'thread/items/list', { threadId, turnId: completed.turnId });
  result.outputLimit = { liveBytes: Buffer.byteLength(completed.item.aggregatedOutput), historyBytes: Buffer.byteLength(result.cases.longOutputHistory.result.data[0].item.aggregatedOutput), historyMarker: result.cases.longOutputHistory.result.data[0].item.aggregatedOutput.match(/.{0,40}truncat.{0,80}/i)?.[0] ?? null };
  await record('archive', 'thread/archive', { threadId });
  await record('loadedAfterArchive', 'thread/loaded/list', {});
  await record('archivedRead', 'thread/read', { threadId, includeTurns: true });
  await record('archivedItems', 'thread/items/list', { threadId });
  assert(!result.cases.loadedAfterArchive.result.data.includes(threadId));
  result.passed = true;
} catch (error) { result.passed = false; result.error = error.stack; }
finally { await run.stop(); run.save('result.json', result); }
console.log(JSON.stringify({ passed: result.passed, artifacts: run.artifacts, error: result.error }));
if (!result.passed) process.exitCode = 1;
