import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Run } from '../026-codex-session-admin/harness.mjs';

if (!process.argv.includes('--live')) throw new Error('Use --live to authorize at most two Luna turns');
const run = new Run('027-codex-history-replay');
const result = { metadata: run.metadata, histories: {}, turns: [], budget: { maxTurns: 2, maxSeconds: 240, maxToolStarts: 12, allocationUsd: 0.20 } };
const deadline = setTimeout(() => run.process?.kill('SIGTERM'), 240_000);
try {
  let a = await run.start();
  await run.authenticate(a);
  for (const mode of ['paginated', 'legacy']) {
    run.phase = `corpus-${mode}`;
    const work = join(run.work, mode);
    mkdirSync(work);
    const started = await a.ok('thread/start', { model: 'gpt-6-luna', approvalPolicy: 'never', sandbox: 'danger-full-access', cwd: work, historyMode: mode });
    assert.equal(started.model, 'gpt-6-luna');
    const threadId = started.thread.id;
    result.histories[mode] = { threadId, work, start: started, snapshots: {} };
    await a.ok('thread/name/set', { threadId, name: `HISTORY_${mode.toUpperCase()}_NEEDLE` });
    const begin = run.events.length;
    const guard = setInterval(() => {
      const tools = run.events.slice(begin).filter(x => x.message.method === 'item/started' && ['commandExecution', 'fileChange'].includes(x.message.params.item.type));
      if (tools.length > 12) run.process.kill('SIGTERM');
    }, 100);
    let turn;
    try {
      turn = await run.turn(a, threadId, 'Bounded history research. Do exactly these steps in this empty directory: (1) run a single shell command that prints HISTORY_STDOUT on stdout and HISTORY_STDERR on stderr; (2) use apply_patch to create evidence.txt containing exactly HISTORY_FILE followed by a newline; (3) reply with exactly HISTORY_DONE. No other tools or exploration.');
    } finally { clearInterval(guard); }
    result.turns.push({ mode, threadId, turn });
    assert.equal(turn.status, 'completed');
    assert.equal(readFileSync(join(work, 'evidence.txt'), 'utf8'), 'HISTORY_FILE\n');
    await snapshot(a, mode, 'loaded');
    await a.ok('thread/unsubscribe', { threadId });
    await snapshot(a, mode, 'unsubscribed');
  }
  run.save('corpus.json', result);
  await run.stop();
  run.phase = 'history-only-restart';
  a = await run.start();
  result.loadedBeforeReads = await a.ok('thread/loaded/list', {});
  const baseline = run.events.length;
  for (const mode of ['paginated', 'legacy']) await snapshot(a, mode, 'restart');
  result.loadedAfterReads = await a.ok('thread/loaded/list', {});
  result.historyReadNotifications = run.events.slice(baseline).filter(x => x.direction === 'server' && x.message.method);
  assert.deepEqual(result.loadedBeforeReads.data, []);
  assert.deepEqual(result.loadedAfterReads.data, []);
  assert(!result.historyReadNotifications.some(x => ['turn/started', 'item/started', 'thread/tokenUsage/updated'].includes(x.message.method)));
  for (const mode of ['paginated', 'legacy']) {
    const data = result.histories[mode];
    const native = data.snapshots.restart.full.result?.thread?.path;
    if (native && existsSync(native)) cpSync(native, join(run.artifacts, `${mode}-native-rollout.jsonl`));
  }
  result.passed = true;

  async function snapshot(client, mode, label) {
    const { threadId } = result.histories[mode];
    const s = result.histories[mode].snapshots[label] = {};
    s.loaded = await client.rpc('thread/loaded/list');
    s.summary = await client.rpc('thread/read', { threadId });
    s.full = await client.rpc('thread/read', { threadId, includeTurns: true });
    s.turnsSummary = await client.rpc('thread/turns/list', { threadId, limit: 1 });
    s.turnsFull = await client.rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'asc', itemsView: 'full' });
    s.itemsPages = [];
    let cursor;
    for (let i = 0; i < 30; i++) {
      const page = await client.rpc('thread/items/list', { threadId, limit: 2, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
      s.itemsPages.push(page);
      cursor = page.result?.nextCursor;
      if (!cursor) break;
    }
    s.itemsDesc = await client.rpc('thread/items/list', { threadId, limit: 2, sortDirection: 'desc' });
    const turnId = result.turns.find(x => x.mode === mode)?.turn.id;
    s.invalidCursor = await client.rpc('thread/items/list', { threadId, cursor: 'not-a-cursor' });
    s.invalidTurn = await client.rpc('thread/items/list', { threadId, turnId: 'not-a-turn' });
    if (turnId) s.itemsInTurn = await client.rpc('thread/items/list', { threadId, turnId, limit: 100 });
    const reverse = s.itemsDesc.result?.backwardsCursor;
    if (reverse) s.reverseAnchor = await client.rpc('thread/items/list', { threadId, cursor: reverse, sortDirection: 'asc', limit: 2 });
    run.save('corpus.json', result);
  }
} catch (error) { result.error = error.stack; result.passed = false; }
finally {
  clearTimeout(deadline);
  await run.stop();
  result.usage = run.usage();
  run.save('corpus.json', result);
  const ledger = result.turns.map(t => ({ label: `corpus-${t.mode}`, threadId: t.threadId, turnId: t.turn.id, requestedModel: 'gpt-6-luna', status: t.turn.status }));
  run.save('ledger.json', { date: '2026-10-14', auth: 'subscription token in memory; actual subscription billing unknown', invocations: ledger, rawUsage: result.usage, pricesPerMillion: { input: 0.10, cached: 0.01, output: 0.50 }, priceSource: 'https://developers.openai.com/api/docs/models/gpt-6-luna', coverage: 'Client-protocol usage; upstream warmups/retries not captured' });
}
console.log(JSON.stringify({ passed: result.passed, artifacts: run.artifacts, turns: result.turns.map(x => ({ mode: x.mode, id: x.turn.id, status: x.turn.status })), usageSnapshots: result.usage.length, error: result.error }));
if (!result.passed) process.exitCode = 1;
