import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../../039-hp-agent-runtime/src/runtime.ts';
import { FixtureConnector } from '../../039-hp-agent-runtime/src/fixture.ts';
import { ArchiveRepository, captureArchive, decodeArchive, encodeArchive } from './archive.ts';
import { MemoryBlobStore, type BlobStore } from './storage/store.ts';
import { FileBlobStore } from './storage/filesystem.ts';
import { runPersistenceScenarios } from './persistence-scenarios.ts';

test('portable persistence, continuation and historical-fork scenarios with memory', async () => {
  assert.ok((await runPersistenceScenarios(new MemoryBlobStore())).passed >= 15);
});
test('same archive/restore semantics through real filesystem and fresh adapter instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hp070-'));
  try {
    assert.ok((await runPersistenceScenarios(new FileBlobStore(directory))).passed >= 15);
    const bytes = Uint8Array.from([0, 255, 1]); const key = '../not/a/filesystem/path/λ';
    await new FileBlobStore(directory).write(key, bytes);
    assert.deepEqual(await new FileBlobStore(directory).read(key), bytes);
    assert.deepEqual(await new FileBlobStore(directory).keys(), [key]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('commit failures stay visible and cannot erase previously committed history', async () => {
  const inner = new MemoryBlobStore(); let fail = false;
  const store: BlobStore = { keys: () => inner.keys(), read: key => inner.read(key), remove: key => inner.remove(key),
    write: async (key, bytes) => { if (fail) throw new Error('injected storage failure'); await inner.write(key, bytes); } };
  const repository = new ArchiveRepository(store);
  const runtime = new AgentRuntime({ connector: new FixtureConnector() }); runtime.create();
  const original = captureArchive(runtime); await repository.put('session', original); fail = true;
  runtime.create(); const newer = captureArchive(runtime, { previous: original });
  await assert.rejects(repository.put('session', newer), /storage failure/);
  assert.deepEqual(await repository.get('session'), original);
  assert.equal(runtime.list().length, 2, 'failed persistence did not stop in-memory execution');
  runtime.dispose();
});
test('unsupported or corrupt archives fail explicitly instead of becoming empty histories', () => {
  assert.throws(() => decodeArchive(new TextEncoder().encode('{')), SyntaxError);
  assert.throws(() => decodeArchive(new TextEncoder().encode('{"format":"hp-session-archive","version":900}')), /format\/version/);
  const runtime = new AgentRuntime({ connector: new FixtureConnector() }); runtime.create();
  const archive = captureArchive(runtime); archive.snapshots.push(structuredClone(archive.snapshots[0]!));
  assert.throws(() => decodeArchive(encodeArchive(archive)), /Duplicate/); runtime.dispose();
});
