import { AgentRuntime } from '../../039-hp-agent-runtime/src/runtime.ts';
import { FixtureConnector, echoTool } from '../../039-hp-agent-runtime/src/fixture.ts';
import { ArchiveRepository, captureArchive, completedBoundaries, decodeArchive, encodeArchive } from './archive.ts';
import { forkArchive, resumeArchive } from './runtime-restore.ts';
import type { BlobStore } from './storage/store.ts';

/** Same local scenarios run with Node files, memory and real browser IndexedDB. No provider requests. */
export async function runPersistenceScenarios(store: BlobStore) {
  const checks: string[] = [];
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); checks.push(message); };
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const repository = new ArchiveRepository(store);
  const key = `session / λ / ${crypto.randomUUID()}`;
  const connector = new FixtureConnector(); let toolExecutions = 0;
  const tools = [{ ...echoTool, execute: async (text: string) => { toolExecutions++; return echoTool.execute(text, {} as never); } }];
  const runtime = new AgentRuntime({ connector, instructions: 'Keep opaque model context.', tools });
  const owned: AgentRuntime[] = [runtime];
  try {
    const thread = runtime.create();
    const first = runtime.start(thread.id, 'tool FIRST_070'); await runtime.wait(thread.id);
    const firstContext = runtime.context(thread.id);
    runtime.replaceContext(thread.id, [{ type: 'compaction', id: 'fixture-context', encrypted_content: 'opaque_λ_070' },
      { role: 'developer', content: 'FIRST_070 is retained by a synthetic compaction fixture.' }], 'fixture-compaction');
    const compactedContext = runtime.context(thread.id);
    runtime.start(thread.id, 'LATER_070'); await runtime.wait(thread.id);
    const pending = runtime.sendMessage(thread.id, thread.id, 'UNDELIVERED_070');
    const job = runtime.startJob(thread.id, { name: 'unrestored task', run: async context => {
      context.output({ progress: 1 });
      await new Promise((_, reject) => {
        const abort = () => reject(context.signal.reason);
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort();
      });
    } });
    await Promise.resolve();
    const archive = captureArchive(runtime); const original = JSON.stringify(archive);
    const boundaries = completedBoundaries(archive, thread.id);
    const before = boundaries.find(item => item.afterTurnId === first.id && item.reason === 'completed-turn')!;
    const after = boundaries.find(item => item.afterTurnId === first.id && item.reason === 'fixture-compaction')!;
    check(Boolean(before && after && before.seq !== after.seq), 'Exact references distinguish before/after compaction at one turn');
    await repository.put(key, archive);
    const readRepository = new ArchiveRepository(store);
    const loaded = (await readRepository.get(key))!;
    check(equal(archive, loaded), 'Opaque-key byte storage round-trips full archive');
    check((await readRepository.list()).some(item => item.key === key && item.threads[0]?.id === thread.id), 'Catalogue reads saved conversations without a runtime');
    check(connector.calls === 3, 'Save/list/read invoke no model');
    runtime.dispose();
    const restoredConnector = new FixtureConnector();
    const restored = resumeArchive(loaded, thread.id, { connector: restoredConnector, tools }); owned.push(restored.runtime);
    check(restored.threadId === thread.id && restored.runtime.runId !== archive.runtimeId, 'Resume retains conversation identity and changes execution owner');
    check(equal(restored.runtime.context(thread.id), runtime.context(thread.id)), 'Resume retains complete current model context');
    check(restoredConnector.calls === 0 && toolExecutions === 1, 'Restoration itself executes neither model nor previous tools');
    check(restored.runtime.inspectInputs(thread.id).find(input => input.id === pending.messageId)?.state === 'uncommitted'
      && restored.warnings.some(warning => warning.includes(pending.messageId)), 'Pending mailbox input is retained as uncommitted evidence');
    check(restored.runtime.jobs.list().length === 0 && restored.warnings.some(warning => warning.includes(job.id)), 'Saved running job remains evidence, not restored execution');
    check(loaded.jobEvents.some(event => event.jobId === job.id && event.kind === 'output'), 'Job output survives separately from execution');
    restored.runtime.start(thread.id, 'Continued explicitly'); await restored.runtime.wait(thread.id);
    check(restored.runtime.read(thread.id).turns.length === 3, 'Restored runtime accepts an explicit new turn');
    check(!JSON.stringify(restored.runtime.context(thread.id)).includes('UNDELIVERED_070'), 'Explicit continuation does not silently deliver old pending mail');
    const resumedArchive = captureArchive(restored.runtime, { previous: loaded });
    check(resumedArchive.sourceId === loaded.sourceId && resumedArchive.epochs.length === 2, 'Storage provenance survives multiple owner epochs');
    const fork = forkArchive(resumedArchive, thread.id, before, { connector: new FixtureConnector(), tools }); owned.push(fork.runtime);
    check(fork.threadId !== thread.id && fork.runtime.read(fork.threadId).forkedFromId === thread.id, 'Historical fork creates new identity and preserves lineage');
    check(equal(fork.runtime.context(fork.threadId), firstContext), 'Historical fork uses exact earlier model context');
    const compactedFork = forkArchive(resumedArchive, thread.id, after, { connector: new FixtureConnector(), tools }); owned.push(compactedFork.runtime);
    check(equal(compactedFork.runtime.context(compactedFork.threadId), compactedContext), 'Post-compaction fork retains opaque context items');
    const combined = captureArchive(fork.runtime, { previous: resumedArchive });
    check(equal(combined.snapshots.find(saved => saved.thread.id === thread.id), resumedArchive.snapshots.find(saved => saved.thread.id === thread.id)), 'Saving old-boundary fork cannot replace latest source history');
    check(JSON.stringify(archive) === original, 'Read/resume/fork leave source archive unchanged');
    const active = restored.runtime.start(thread.id, 'unfinished');
    const interrupted = captureArchive(restored.runtime, { previous: resumedArchive });
    restored.runtime.interrupt(thread.id, active.id); await restored.runtime.wait(thread.id);
    const observed = decodeArchive(encodeArchive(interrupted));
    check(observed.snapshots.find(saved => saved.thread.id === thread.id)!.thread.turns.at(-1)!.status === 'inProgress', 'Abrupt-owner snapshot preserves incomplete observed turn');
    let rejected = false;
    try { resumeArchive(observed, thread.id, { connector: new FixtureConnector() }); } catch (error) { rejected = String(error).includes('completed checkpoint'); }
    check(rejected, 'Unfinished snapshot requires explicit completed checkpoint instead of tool replay');
    check(toolExecutions === 1, 'All read/restore/fork operations preserve previous tool side-effect count');
    await repository.remove(key);
    check(await repository.get(key) === null, 'Storage removal operates on opaque identity');
    return { checks, passed: checks.length, providerCalls: 0, syntheticCompaction: true };
  } finally {
    for (const owner of owned) owner.dispose();
    await repository.remove(key);
  }
}
