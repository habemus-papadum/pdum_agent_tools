import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Run, until } from './harness.mjs';

const run = new Run('026-codex-session-admin');
const result = { cases: {}, metadata: run.metadata, inference: false };
const deadline = setTimeout(() => run.process?.kill('SIGTERM'), 120_000);
try {
  let a = await run.start();
  const b = await run.connect('B');
  const record = async (label, method, params, client = a) => result.cases[label] = await client.rpc(method, params);
  const options = { model: 'gpt-6-luna', approvalPolicy: 'never', sandbox: 'danger-full-access', cwd: run.work };
  const first = (await a.ok('thread/start', { ...options, historyMode: 'paginated' })).thread;
  const secondCwd = join(run.work, 'second');
  mkdirSync(secondCwd);
  const second = (await b.ok('thread/start', { ...options, cwd: secondCwd })).thread;
  const ephemeral = (await a.ok('thread/start', { ...options, ephemeral: true })).thread;
  result.ids = { first: first.id, second: second.id, ephemeral: ephemeral.id };
  await record('renameFirst', 'thread/name/set', { threadId: first.id, name: 'ADMIN_ALPHA_NEEDLE' });
  await record('renameSecond', 'thread/name/set', { threadId: second.id, name: 'ADMIN_BETA' }, b);
  await record('loaded', 'thread/loaded/list', {});
  await record('emptyThreadsCatalogue', 'thread/list', {});
  for (const thread of [first, second]) {
    await a.ok('thread/shellCommand', { threadId: thread.id, command: 'printf ADMIN_SHELL_MARKER', timeoutMs: 5000 });
    await until(() => run.events.some(x => x.message.method === 'turn/completed' && x.message.params.threadId === thread.id));
  }
  await record('listDefaults', 'thread/list', {});
  await record('listAllSources', 'thread/list', { sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'unknown'], modelProviders: [] });
  await record('searchTitle', 'thread/list', { searchTerm: 'ALPHA_NEEDLE' });
  await record('filterCwd', 'thread/list', { cwd: secondCwd });
  await record('filterOtherProvider', 'thread/list', { modelProviders: ['nonexistent_provider'] });
  await record('originatorNegative', 'thread/list', { originators: ['local-spike'] });
  const page = await record('firstPage', 'thread/list', { limit: 1, sortKey: 'created_at', sortDirection: 'asc' });
  if (page.result?.nextCursor) await record('secondPage', 'thread/list', { limit: 1, sortKey: 'created_at', sortDirection: 'asc', cursor: page.result.nextCursor });
  if (page.result?.backwardsCursor) await record('reversePage', 'thread/list', { limit: 1, sortKey: 'created_at', sortDirection: 'desc', cursor: page.result.backwardsCursor });
  const project = await record('projectCreate', 'project/create', { name: 'Research project', roots: [{ path: run.work }], idempotencyKey: 'admin-project', metadata: { owner: 'spike026' } });
  await record('projectList', 'project/list', {});
  if (project.result?.project) {
    result.ids.project = project.result.project.id;
    await record('assignProject', 'thread/metadata/update', { threadId: first.id, projectId: result.ids.project });
  }
  await record('unknownMetadata', 'thread/metadata/update', { threadId: first.id, tags: ['research'], note: 'annotation', isPinned: true });
  await record('readAfterUnknownMetadata', 'thread/read', { threadId: first.id });
  const section = await record('sectionCreate', 'threadSection/create', { name: 'Marked research' });
  await record('sectionList', 'threadSection/list', {});
  if (section.result?.section) await record('sectionMove', 'thread/section/move', { threadId: first.id, sectionId: section.result.section.id });
  await record('attachmentAdd', 'thread/attachment/add', { threadId: first.id, attachmentType: 'application.annotation', identityKey: 'note-1', payload: { tags: ['research'], note: 'Native attachment experiment', applicationOwner: 'spike026' } });
  await record('attachmentList', 'thread/attachment/list', { threadId: first.id });
  await record('attachmentDuplicate', 'thread/attachment/add', { threadId: first.id, attachmentType: 'application.annotation', identityKey: 'note-1', payload: { note: 'changed duplicate' } });
  await record('attachmentChangedList', 'thread/attachment/list', { threadId: first.id });
  await record('archive', 'thread/archive', { threadId: first.id });
  await record('archivedList', 'thread/list', { archived: true });
  await record('loadedAfterArchive', 'thread/loaded/list', {});
  await record('unarchive', 'thread/unarchive', { threadId: first.id });
  await record('deleteSecond', 'thread/delete', { threadId: second.id });
  await record('readDeleted', 'thread/read', { threadId: second.id });
  await record('readEphemeral', 'thread/read', { threadId: ephemeral.id, includeTurns: true });
  await delay(100);
  result.notificationsB = run.events.filter(x => x.connection === 'B' && x.direction === 'server' && x.message.method).map(x => x.message);
  await run.stop();
  run.phase = 'restart';
  a = await run.start();
  await record('loadedRestart', 'thread/loaded/list', {});
  await record('listRestart', 'thread/list', {});
  await record('readRestart', 'thread/read', { threadId: first.id, includeTurns: true });
  await record('attachmentsRestart', 'thread/attachment/list', { threadId: first.id });
  await record('ephemeralRestart', 'thread/read', { threadId: ephemeral.id });
  await record('loadedAfterRead', 'thread/loaded/list', {});
  assert.deepEqual(result.cases.loadedRestart.result.data, result.cases.loadedAfterRead.result.data);
  result.passed = true;
} catch (error) { result.error = error.stack; result.passed = false; }
finally { clearTimeout(deadline); await run.stop(); run.save('result.json', result); }
console.log(JSON.stringify({ passed: result.passed, artifacts: run.artifacts, errors: Object.fromEntries(Object.entries(result.cases).filter(([, x]) => x.error).map(([k, x]) => [k, x.error])), error: result.error }));
if (!result.passed) process.exitCode = 1;
