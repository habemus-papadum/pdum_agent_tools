import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Run } from './harness.mjs';

const source = JSON.parse(readFileSync(join(resolve(process.argv[2]), 'result.json')));
const run = new Run('026-codex-session-admin', { isolated: source.metadata.isolated });
const result = { metadata: run.metadata, cases: {}, inference: false };
try {
  const a = await run.start();
  const record = async (label, method, params) => result.cases[label] = await a.rpc(method, params);
  const parent = source.ids.parent;
  const fork = source.ids.full;
  await record('loadedBefore', 'thread/loaded/list', {});
  await record('renameFork', 'thread/name/set', { threadId: fork, name: 'ADMIN_FINAL_NEEDLE' });
  await record('listAll', 'thread/list', { sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'unknown'], modelProviders: [] });
  await record('searchName', 'thread/list', { searchTerm: 'ADMIN_FINAL_NEEDLE' });
  await record('listAssistantTerm', 'thread/list', { searchTerm: 'PARENT_ONLY' });
  await record('searchAssistantTerm', 'thread/search', { searchTerm: 'PARENT_ONLY' });
  await record('occurrences', 'thread/searchOccurrences', { threadId: parent, searchTerm: 'PARENT_ONLY', limit: 10 });
  const page = await record('page1', 'thread/list', { limit: 1, sortDirection: 'asc' });
  assert(page.result.nextCursor);
  await record('renameBetweenPages', 'thread/name/set', { threadId: fork, name: 'ADMIN_FINAL_RENAMED' });
  let cursor = page.result.nextCursor;
  for (let i = 2; cursor && i < 12; i++) {
    const next = await record(`page${i}`, 'thread/list', { limit: 1, sortDirection: 'asc', cursor });
    cursor = next.result?.nextCursor;
  }
  await record('reverseAnchor', 'thread/list', { limit: 2, sortDirection: 'desc', cursor: page.result.backwardsCursor });
  for (const threadId of [parent, fork]) await record(`tag-${threadId}`, 'thread/attachment/add', { threadId, attachmentType: 'spike.tag', identityKey: 'research', payload: { label: 'research' } });
  await record('owners', 'thread/attachmentOwner/list', { attachmentType: 'spike.tag', identityKey: 'research' });
  await record('archiveParent', 'thread/archive', { threadId: parent });
  await record('ownersIncludingArchive', 'thread/attachmentOwner/list', { attachmentType: 'spike.tag', identityKey: 'research' });
  await record('ownersActive', 'thread/attachmentOwner/list', { attachmentType: 'spike.tag', identityKey: 'research', archived: false });
  await record('forkAfterParentArchive', 'thread/read', { threadId: fork });
  await record('unarchiveParent', 'thread/unarchive', { threadId: parent });
  await record('loadedAfter', 'thread/loaded/list', {});
  assert.deepEqual(result.cases.loadedBefore.result.data, []);
  assert.deepEqual(result.cases.loadedAfter.result.data, []);
  result.passed = true;
} catch(error) { result.passed = false; result.error = error.stack; }
finally { await run.stop(); run.save('result.json', result); }
console.log(JSON.stringify({ passed: result.passed, artifacts: run.artifacts, error: result.error }));
if (!result.passed) process.exitCode = 1;
