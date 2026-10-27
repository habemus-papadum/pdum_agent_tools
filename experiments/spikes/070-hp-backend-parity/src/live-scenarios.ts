import { AgentRuntime, type Tool } from '../../039-hp-agent-runtime/src/runtime.ts';
import type { ModelConnector } from '../../038-hp-sdk-fit/src/connector.ts';
import { compactIdleThread, type CompactionClient } from '../../043-hp-context-compaction/src/compaction.ts';
import { ArchiveRepository, captureArchive, completedBoundaries, type HpArchive, type ArchivedUsage } from './archive.ts';
import { resumeArchive, forkArchive } from './runtime-restore.ts';
import { summarizeArchive, type Prices } from './accounting.ts';

export const LIVE_SUFFIX = '\n\n# Persistence qualification\nFollow the precise short task. Use read_marker only when explicitly asked. Retain remembered markers in context. Do not invent a marker you have not seen. Answer UNKNOWN when requested information is absent. Keep final replies under 40 words.\n';
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const answer = (runtime: AgentRuntime, id: string) => runtime.read(id).turns.at(-1)!.items
  .filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
function tools(counter: { calls: number }): Tool[] {
  return [{ definition: { type: 'function', name: 'read_marker', description: 'Read the stored primary marker from the host.',
    strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    async execute() { counter.calls++; return 'PRIMARY_070_JUNIPER'; } }];
}
export interface LiveBindings {
  connector: ModelConnector; instructions: string; prices: Prices; signal: AbortSignal;
}
async function turn(runtime: AgentRuntime, id: string, text: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const active = runtime.start(id, text);
  const abort = () => runtime.interrupt(id, active.id);
  signal.addEventListener('abort', abort, { once: true });
  try { check((await runtime.wait(id))?.status === 'completed', 'Live turn did not complete'); return answer(runtime, id); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Persist first; the caller then destroys its Node process or browser Worker. */
export async function seedLive(repository: ArchiveRepository, bindings: LiveBindings, compactor: CompactionClient) {
  const counter = { calls: 0 };
  const runtime = new AgentRuntime({ connector: bindings.connector, instructions: bindings.instructions, tools: tools(counter) });
  let archive: HpArchive | undefined;
  try {
    const parent = runtime.create();
    const first = await turn(runtime, parent.id, 'Call read_marker once. Remember its exact value as the primary marker and repeat it.', bindings.signal);
    check(first.includes('PRIMARY_070_JUNIPER') && counter.calls === 1, 'Primary tool marker missing');
    const firstTurnId = runtime.read(parent.id).turns.at(-1)!.id;
    await turn(runtime, parent.id, 'Remember SECONDARY_070_COPPER as the secondary marker. Reply RECORDED. Do not call tools.', bindings.signal);
    const compacted = await compactIdleThread(runtime, parent.id, compactor, { signal: bindings.signal, instructions: bindings.instructions });
    check(compacted.status === 'applied', 'Compaction was not applied');
    const u = compacted.usage;
    const extra: ArchivedUsage = { originRunId: runtime.runId, threadId: parent.id, turnId: null,
      endpoint: 'responses.compact', afterTurnId: u.afterTurnId, disposition: compacted.status,
      ts: compacted.capturedAt, usage: { type: 'usage', responseId: u.responseId, model: u.model,
        inputTokens: u.inputTokens, cachedInputTokens: u.cachedInputTokens, cacheWriteTokens: u.cacheWriteTokens,
        outputTokens: u.outputTokens, reasoningOutputTokens: u.reasoningTokens } };
    // One explicit child proves attribution, without relying on parent model delegation.
    const child = runtime.spawn(parent.id, 'Reply CHILD_070_ONLY, without tools.');
    await runtime.wait(child.threadId);
    check(runtime.read(child.threadId).turns.at(-1)?.status === 'completed', 'Child did not finish');
    archive = captureArchive(runtime, { extraUsages: [extra] });
    await repository.put('seed', archive);
    const early = completedBoundaries(archive, parent.id).find(boundary => boundary.afterTurnId === firstTurnId);
    check(early, 'Historical turn boundary absent');
    return { passed: true, archive, parentId: parent.id, childId: child.threadId, firstTurnId, early,
      toolCalls: counter.calls, compaction: { responseId: u.responseId, opaqueItems: compacted.nextContext.filter(item => item.type === 'compaction').length },
      stats: summarizeArchive(archive, bindings.prices) };
  } finally { runtime.dispose(); }
}

/** Reads a saved archive; native opaque context must work on entirely fresh connections. */
export async function continueLive(repository: ArchiveRepository, bindings: LiveBindings) {
  const archive = await repository.get('seed'); check(archive, 'Seed archive missing');
  const sourceBefore = JSON.stringify(archive);
  const parent = archive.snapshots.find(saved => !saved.thread.parentThreadId && !saved.thread.forkedFromId)!;
  const counter = { calls: 0 };
  const freshBindings = { connector: bindings.connector, tools: tools(counter) };
  const resumed = resumeArchive(archive, parent.thread.id, freshBindings);
  let fork: ReturnType<typeof forkArchive> | undefined;
  try {
    check(resumed.runtime.runId !== archive.runtimeId && resumed.threadId === parent.thread.id, 'Resume ownership/identity incorrect');
    check(counter.calls === 0, 'Restore executed an old tool');
    const reply = await turn(resumed.runtime, resumed.threadId, 'What are the exact primary and secondary markers? Reply with both values. Do not call tools.', bindings.signal);
    check(reply.includes('PRIMARY_070_JUNIPER') && reply.includes('SECONDARY_070_COPPER'), 'Restored compacted context lost facts');
    const resumedArchive = captureArchive(resumed.runtime, { previous: archive });
    const early = completedBoundaries(archive, parent.thread.id).find(boundary => boundary.afterTurnId === parent.thread.turns[0]!.id)!;
    fork = forkArchive(archive, parent.thread.id, early, freshBindings);
    check(fork.threadId !== parent.thread.id, 'Fork reused source identity');
    const forkReply = await turn(fork.runtime, fork.threadId, 'What are the exact primary and secondary markers? Use UNKNOWN for any marker you have not seen. Do not call tools.', bindings.signal);
    check(forkReply.includes('PRIMARY_070_JUNIPER') && forkReply.includes('UNKNOWN') && !forkReply.includes('COPPER'), 'Historical fork included later context or lost early context');
    check(JSON.stringify(archive) === sourceBefore, 'Fork changed source archive');
    check(counter.calls === 0, 'Continuation replayed previous tool');
    const final = captureArchive(fork.runtime, { previous: resumedArchive });
    check(JSON.stringify(final.snapshots.find(saved => saved.thread.id === parent.thread.id))
      === JSON.stringify(resumedArchive.snapshots.find(saved => saved.thread.id === parent.thread.id)), 'Fork replaced the latest source history');
    const stats = summarizeArchive(final, bindings.prices);
    check(stats.complete, 'Usage coverage incomplete');
    check(stats.compactionResponses === 1, 'Compaction accounting lost or repeated');
    await repository.put('final', final);
    return { passed: true, archive: final, resumedId: resumed.threadId, resumedOwner: resumed.runtime.runId,
      forkId: fork.threadId, reply, forkReply, toolCalls: counter.calls, stats, warnings: [...resumed.warnings, ...fork.warnings] };
  } finally { resumed.runtime.dispose(); fork?.runtime.dispose(); }
}
