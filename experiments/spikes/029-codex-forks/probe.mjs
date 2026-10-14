import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Run, textInput, until } from '../026-codex-session-admin/harness.mjs';

assert(process.argv.includes('--live'), 'Pass corpus directory and --live for two replies, one compaction, bounded goal check');
const corpusPath = resolve(process.argv[2]);
const corpus = JSON.parse(readFileSync(join(corpusPath, 'corpus.json')));
const run = new Run('029-codex-forks', { isolated: corpus.metadata.isolated, overrides: ['features.goals=true'] });
const result = { metadata: run.metadata, corpus: corpusPath, cases: {}, turns: [], bounds: { explicitTurns: 2, queueSubmissions: 1, compactions: 1, goalTokenBudget: 64, wallSeconds: 240 } };
const parentId = corpus.histories.paginated.threadId;
const firstTurn = corpus.turns.find(x => x.mode === 'paginated').turn.id;
const deadline = setTimeout(() => run.process?.kill('SIGTERM'), 240_000);
try {
  let a = await run.start();
  await run.authenticate(a);
  const record = async (label, method, params) => result.cases[label] = await a.rpc(method, params);
  await record('coldResume', 'thread/resume', { threadId: parentId });
  await record('warmResumeOverride', 'thread/resume', { threadId: parentId, sandbox: 'read-only', approvalPolicy: 'on-request' });
  await record('warmResumeRestore', 'thread/resume', { threadId: parentId, sandbox: 'danger-full-access', approvalPolicy: 'never' });
  const full = await record('fullFork', 'thread/fork', { threadId: parentId });
  const forkId = full.result.thread.id;
  result.ids = { parent: parentId, full: forkId };
  await record('beforeFork', 'thread/fork', { threadId: parentId, beforeTurnId: firstTurn, excludeTurns: true });
  await record('throughFork', 'thread/fork', { threadId: parentId, lastTurnId: firstTurn });
  await record('conflictingBoundaries', 'thread/fork', { threadId: parentId, beforeTurnId: firstTurn, lastTurnId: firstTurn });
  await record('ephemeralNegative', 'thread/fork', { threadId: parentId, ephemeral: true });
  await record('ephemeralFork', 'thread/fork', { threadId: parentId, ephemeral: true, excludeTurns: true });
  await record('deferEphemeralNegative', 'thread/fork', { threadId: parentId, ephemeral: true, excludeTurns: true, deferGoalContinuation: true });
  run.phase = 'parent-continuation';
  result.turns.push({ label: run.phase, threadId: parentId, turn: await run.turn(a, parentId, 'Do not use tools. Reply with exactly PARENT_ONLY.') });
  run.phase = 'fork-continuation';
  result.turns.push({ label: run.phase, threadId: forkId, turn: await run.turn(a, forkId, 'Do not use tools. Reply with exactly FORK_ONLY.') });
  await record('parentAfterContinuation', 'thread/read', { threadId: parentId, includeTurns: true });
  await record('forkAfterContinuation', 'thread/read', { threadId: forkId, includeTurns: true });
  run.phase = 'active-local-command';
  const begin = run.events.length;
  await a.ok('thread/shellCommand', { threadId: parentId, command: 'sleep 1; printf ACTIVE_PARENT_ONLY >> side-effect.txt', timeoutMs: 4000 });
  await until(() => run.events.slice(begin).some(x => x.message.method === 'turn/started' && x.message.params.threadId === parentId));
  const active = await record('activeFork', 'thread/fork', { threadId: parentId });
  result.ids.activeFork = active.result?.thread.id;
  await until(() => run.events.slice(begin).some(x => x.message.method === 'turn/completed' && x.message.params.threadId === parentId));
  await delay(100);
  result.sideEffectAfterFork = readFileSync(join(corpus.histories.paginated.work, 'side-effect.txt'), 'utf8');
  await record('activeForkHistory', 'thread/read', { threadId: result.ids.activeFork, includeTurns: true });
  await record('parentBeforeRevert', 'thread/turns/list', { threadId: parentId, itemsView: 'full', sortDirection: 'asc' });
  const lastTurn = result.cases.parentBeforeRevert.result.data.at(-1).id;
  await record('revert', 'thread/revert', { threadId: parentId, beforeTurnId: lastTurn });
  result.sideEffectAfterRevert = readFileSync(join(corpus.histories.paginated.work, 'side-effect.txt'), 'utf8');
  assert.equal(result.sideEffectAfterRevert, result.sideEffectAfterFork);
  run.phase = 'manual-compaction';
  const compactBegin = run.events.length;
  await record('beforeCompaction', 'thread/read', { threadId: forkId, includeTurns: true });
  await a.ok('thread/compact/start', { threadId: forkId });
  await until(() => run.events.slice(compactBegin).some(x => x.message.method === 'turn/completed' && x.message.params.threadId === forkId), 60_000);
  await record('afterCompaction', 'thread/read', { threadId: forkId, includeTurns: true });
  result.compactionEvents = run.events.slice(compactBegin).filter(x => x.message.method);
  run.save('result.json', result);
  run.phase = 'queued-input';
  await record('queueAdd', 'thread/queue/add', { threadId: forkId, clientUserMessageId: 'queue-research-1', input: textInput('Do not execute this until explicitly started. Reply QUEUED_ONLY.') });
  await record('queueList', 'thread/queue/list', { threadId: forkId });
  await record('queuedFork', 'thread/fork', { threadId: forkId, excludeTurns: true });
  const queuedForkId = result.cases.queuedFork.result?.thread.id;
  if (queuedForkId) await record('forkQueueList', 'thread/queue/list', { threadId: queuedForkId });
  await run.stop();
  run.phase = 'cold-queue-and-goal';
  a = await run.start();
  await run.authenticate(a);
  const queueBegin = run.events.length;
  await record('coldQueuedResume', 'thread/resume', { threadId: forkId, excludeTurns: true });
  await delay(750);
  result.queueResumeStartedTurn = run.events.slice(queueBegin).some(x => x.message.method === 'turn/started');
  await record('coldQueueList', 'thread/queue/list', { threadId: forkId });
  const queue = result.cases.coldQueueList.result?.data ?? [];
  for (const item of queue) await record('queueDelete', 'thread/queue/delete', { threadId: forkId, queuedSubmissionId: item.id });
  // Set a goal on an unloaded materialized thread, then fork with the explicit defer control.
  await record('setColdActiveGoal', 'thread/goal/set', { threadId: parentId, objective: 'Reply GOAL_DONE and immediately mark this goal complete. No tools except update_goal.', tokenBudget: 64, status: 'active' });
  const goalBegin = run.events.length;
  await record('deferredGoalFork', 'thread/fork', { threadId: parentId, deferGoalContinuation: true, excludeTurns: true });
  const goalForkId = result.cases.deferredGoalFork.result?.thread.id;
  if (goalForkId) await record('deferredGoalGet', 'thread/goal/get', { threadId: goalForkId });
  await delay(750);
  result.deferredGoalStartedTurn = run.events.slice(goalBegin).some(x => x.message.method === 'turn/started');
  if (goalForkId) await record('pauseDeferredGoal', 'thread/goal/set', { threadId: goalForkId, status: 'paused' });
  // Resume can own goal continuation. Pause immediately after observing its first start.
  run.phase = 'active-goal-resume';
  const resumeBegin = run.events.length;
  await record('activeGoalResume', 'thread/resume', { threadId: parentId, excludeTurns: true });
  for (let i = 0; i < 150; i++) {
    const start = run.events.slice(resumeBegin).find(x => x.message.method === 'turn/started' && x.message.params.threadId === parentId);
    if (start) {
      result.automaticGoalTurn = start.message.params.turn;
      await record('pauseAutomaticGoal', 'thread/goal/set', { threadId: parentId, status: 'paused' });
      await record('interruptAutomaticGoal', 'turn/interrupt', { threadId: parentId, turnId: start.message.params.turn.id });
      break;
    }
    await delay(20);
  }
  await record('finalGoal', 'thread/goal/get', { threadId: parentId });
  await record('clearGoal', 'thread/goal/clear', { threadId: parentId });
  result.passed = true;
} catch (error) { result.error = error.stack; result.passed = false; }
finally {
  clearTimeout(deadline);
  await run.stop();
  result.usage = run.usage();
  run.save('result.json', result);
  run.save('ledger.json', { date: '2026-10-14', explicitTurns: result.turns, observedTurnStarts: run.events.filter(x => x.direction === 'server' && x.message.method === 'turn/started'), compaction: result.compactionEvents, goalAttempt: result.automaticGoalTurn, usage: result.usage, billing: 'API-equivalent only; actual subscription billing unknown; upstream-only usage not captured; queue/add may start work immediately' });
}
console.log(JSON.stringify({ passed: result.passed, artifacts: run.artifacts, turns: result.turns.length, error: result.error }));
if (!result.passed) process.exitCode = 1;
