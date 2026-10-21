import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Run, until } from '../026-codex-session-admin/harness.mjs';

// Isolated lifecycle probe. No login, model turn or provider request is needed.
// The only work is explicit local shell commands in the harness's temporary cwd.
const run = new Run('056-codex-inactive-lifecycle', { overrides: [
  'thread_unload_delay_secs=2',
  'model_provider="spike_offline"',
  'model_providers.spike_offline.name="Offline lifecycle probe"',
  'model_providers.spike_offline.base_url="http://127.0.0.1:1"',
  'model_providers.spike_offline.requires_openai_auth=false',
  'model_providers.spike_offline.wire_api="responses"',
] });
const result = { metadata: run.metadata, configuredDelaySeconds: 2, checks: [], timings: {},
  catalogueVisibility: {}, historyObservations: {}, inferenceRequests: 0, observedProviderTokens: 0, estimatedProviderCostUsd: 0 };
const check = (ok, label) => { assert(ok, label); result.checks.push(label); };
const deadline = setTimeout(() => run.process?.kill('SIGTERM'), 75_000);
let b;
const allSources = { modelProviders: [], sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'unknown'] };
const read = async (id, includeTurns = false) => (await b.ok('thread/read', { threadId: id, includeTurns })).thread;
const loaded = async id => (await b.ok('thread/loaded/list')).data.includes(id);
async function waitStatus(id, status, timeout = 10_000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const thread = await read(id);
    if (thread.status.type === status) return { thread, elapsedMs: Math.round(performance.now() - start) };
    await delay(70);
  }
  throw Error(`Thread did not reach ${status} in ${timeout}ms`);
}
async function makeThread(client, marker) {
  const thread = (await client.ok('thread/start', { model: 'gpt-6-luna', cwd: run.work,
    approvalPolicy: 'never', sandbox: 'danger-full-access', historyMode: 'paginated' })).thread;
  const begin = run.events.length;
  await client.ok('thread/shellCommand', { threadId: thread.id, command: `printf ${marker}`, timeoutMs: 2000 });
  await until(() => run.events.slice(begin).some(e => e.message.method === 'turn/completed' && e.message.params.threadId === thread.id), 8000);
  await waitStatus(thread.id, 'idle');
  return thread.id;
}
try {
  const a = await run.start();
  b = await run.connect('observer');
  const id = await makeThread(a, 'LIFECYCLE_HISTORY_MARKER');
  result.primaryThreadId = id;
  run.phase = 'subscribed-idle';
  await delay(2300);
  check(await loaded(id) && (await read(id)).status.type === 'idle', 'Subscribed idle thread remains loaded beyond the delay');
  const initial = await read(id, true);
  check(JSON.stringify(initial.turns).includes('LIFECYCLE_HISTORY_MARKER'), 'Local shell history is readable while loaded without inference');

  run.phase = 'warm-resume';
  await a.ok('thread/unsubscribe', { threadId: id });
  await delay(450);
  const warm = await a.ok('thread/resume', { threadId: id });
  check(warm.thread.id === id && warm.thread.status.type === 'idle', 'Resume before expiry attaches to the still-loaded thread');
  await delay(2200);
  check(await loaded(id), 'Warm resume cancels pending idle unload');

  run.phase = 'last-unsubscribe';
  const unsubscribedAt = performance.now();
  await a.ok('thread/unsubscribe', { threadId: id });
  check(await loaded(id), 'Unsubscribe acknowledgement is not immediate unloading');
  await waitStatus(id, 'notLoaded');
  result.timings.lastUnsubscribeToNotLoadedMs = Math.round(performance.now() - unsubscribedAt);
  check(!(await loaded(id)), 'Last-unsubscribe timer removes the runtime while an observer keeps polling');
  const history = await b.rpc('thread/read', { threadId: id, includeTurns: true });
  result.historyObservations.coldRead = history;
  if (!history.error) check(JSON.stringify(history.result.thread.turns).includes('LIFECYCLE_HISTORY_MARKER'), 'Inactive fixture history remains readable');
  // Listing deliberately excludes empty-preview threads. A shell-only fixture is
  // useful for lifecycle tests but is not proof of normal conversation discovery.
  result.catalogueVisibility.unarchivedBefore = (await b.ok('thread/list', allSources)).data.some(t => t.id === id);

  run.phase = 'cold-resume';
  const cold = await b.rpc('thread/resume', { threadId: id });
  result.historyObservations.coldResume = cold;
  let controlledId = id;
  if (!cold.error) {
    check(cold.result.thread.id === id && await loaded(id), 'Cold resume loads the same durable thread ID');
    check(JSON.stringify(cold.result.thread.turns).includes('LIFECYCLE_HISTORY_MARKER'), 'Cold resume restores saved shell history');
  } else {
    // A fresh shell-only fixture need not be resumable. Retain that failure and
    // qualify the independent subscription cases on another actual thread.
    controlledId = await makeThread(b, 'MULTI_SUBSCRIBER_MARKER');
  }

  run.phase = 'multiple-subscribers';
  await a.ok('thread/resume', { threadId: controlledId });
  await a.ok('thread/unsubscribe', { threadId: controlledId });
  await delay(2200);
  check(await loaded(controlledId), 'Another subscribed client prevents unload');
  await b.ok('thread/unsubscribe', { threadId: controlledId });
  await waitStatus(controlledId, 'notLoaded');
  check(!(await loaded(controlledId)), 'Final subscribed client leaving allows unload');

  run.phase = 'active-local-work';
  const activeId = await makeThread(a, 'ACTIVE_WORK_MARKER');
  const began = performance.now();
  await a.ok('thread/shellCommand', { threadId: activeId, command: 'sleep 4; printf ACTIVE_WORK_FINISHED > lifecycle-finished.txt', timeoutMs: 6000 });
  await waitStatus(activeId, 'active');
  await a.ok('thread/unsubscribe', { threadId: activeId });
  await delay(2300);
  check(await loaded(activeId) && (await read(activeId)).status.type === 'active', 'Active local shell task survives no subscribers beyond the unload delay');
  await waitStatus(activeId, 'notLoaded', 8000);
  result.timings.activeShellStartToNotLoadedMs = Math.round(performance.now() - began);
  check(readFileSync(join(run.work, 'lifecycle-finished.txt'), 'utf8') === 'ACTIVE_WORK_FINISHED', 'Active task finishes before idle unloading');

  run.phase = 'socket-disconnect';
  const c = await run.connect('disconnect-client');
  const disconnectedId = await makeThread(c, 'DISCONNECT_MARKER');
  c.socket.close();
  await waitStatus(disconnectedId, 'notLoaded');
  check(!(await loaded(disconnectedId)), 'Socket disconnect removes its subscription and permits delayed unload');

  run.phase = 'archive-distinction';
  const archiveId = await makeThread(b, 'ARCHIVE_MARKER');
  await b.ok('thread/archive', { threadId: archiveId });
  check(!(await loaded(archiveId)), 'Archiving a loaded thread unloads it');
  result.catalogueVisibility.archived = (await b.ok('thread/list', { ...allSources, archived: true })).data.some(t => t.id === archiveId);
  await b.ok('thread/unarchive', { threadId: archiveId });
  check(!(await loaded(archiveId)), 'Unarchive alone does not resume the runtime');
  result.catalogueVisibility.unarchivedAfter = (await b.ok('thread/list', allSources)).data.some(t => t.id === archiveId);
  check((await read(archiveId)).status.type === 'notLoaded', 'Unarchived thread metadata is readable without a new runtime');
  check(!run.events.some(e => e.direction === 'client' && e.message.method === 'turn/start'), 'No model turn was submitted');
  result.passed = true;
} catch (error) { result.passed = false; result.error = error.stack; }
finally {
  clearTimeout(deadline);
  await run.stop();
  result.statusNotifications = run.events.filter(e => e.direction === 'server' &&
    ['thread/status/changed', 'thread/closed', 'thread/archived', 'thread/unarchived'].includes(e.message.method))
    .map(e => ({ phase: e.phase, connection: e.connection, time: e.time, ...e.message }));
  run.save('result.json', result);
}
console.log(JSON.stringify({ passed: result.passed, checks: result.checks, timings: result.timings,
  history: { coldReadError: result.historyObservations.coldRead?.error, coldResumeError: result.historyObservations.coldResume?.error },
  catalogueVisibility: result.catalogueVisibility, artifacts: run.artifacts, version: run.metadata.version, error: result.error }));
if (!result.passed) process.exitCode = 1;
