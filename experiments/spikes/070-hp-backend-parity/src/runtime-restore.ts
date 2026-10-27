import { AgentRuntime, type RuntimeOptions, type SavedThread } from '../../039-hp-agent-runtime/src/runtime.ts';
import { configurationFor, snapshotAt, type ArchiveConfiguration, type HpArchive, type CompletedBoundary } from './archive.ts';

export interface RestoredRuntime {
  runtime: AgentRuntime;
  threadId: string;
  warnings: string[];
}
function optionsFor(configuration: ArchiveConfiguration, bindings: RuntimeOptions): RuntimeOptions {
  return { ...bindings, instructions: bindings.instructions ?? configuration.instructions,
    model: bindings.model ?? configuration.model };
}
function warningsFor(archive: HpArchive, configuration: ArchiveConfiguration, bindings: RuntimeOptions, selected: SavedThread[]): string[] {
  const ids = new Set(selected.map(saved => saved.thread.id));
  const warnings = archive.jobs.filter(job => job.threadId && ids.has(job.threadId)
    && (job.status === 'running' || job.status === 'cancelling'))
    .map(job => `Job ${job.id} was ${job.status} in the saved owner; execution is not restored`);
  const boundTools = new Set((bindings.tools ?? []).map(tool => String(tool.definition.name)));
  for (const name of configuration.toolNames) if (!boundTools.has(name)) warnings.push(`Previously available tool ${name} is not bound in the new owner`);
  for (const saved of selected) for (const input of saved.inputRecords ?? []) {
    if (['queued', 'sent', 'included'].includes(input.state)) warnings.push(`Pending input ${input.id} is retained as uncommitted evidence, not delivered`);
  }
  return warnings;
}

/** Resume preserves conversation identity but creates a new execution owner. */
export function resumeArchive(archive: HpArchive, threadId: string, bindings: RuntimeOptions): RestoredRuntime {
  const selected: SavedThread[] = [];
  const seen = new Set<string>();
  let id: string | null = threadId;
  while (id) {
    if (seen.has(id)) throw new Error('Cyclic saved parent chain');
    seen.add(id);
    const saved = archive.snapshots.find(snapshot => snapshot.thread.id === id);
    if (!saved) throw new Error(`Missing saved conversation or ancestor: ${id}`);
    if (saved.thread.turns.some(turn => turn.status === 'inProgress')) throw new Error('Unfinished saved turn requires an explicit completed checkpoint');
    selected.unshift(structuredClone(saved)); id = saved.thread.parentThreadId;
  }
  const configuration = configurationFor(archive, threadId);
  const runtime = new AgentRuntime(optionsFor(configuration, bindings));
  runtime.restoreSnapshots(selected);
  return { runtime, threadId, warnings: warningsFor(archive, configuration, bindings, selected) };
}

/** Forks the exact recorded context, not reconstructed prose or a truncated current context. */
export function forkArchive(archive: HpArchive, threadId: string,
  boundary: Pick<CompletedBoundary, 'runId' | 'seq'>, bindings: RuntimeOptions): RestoredRuntime {
  const original = snapshotAt(archive, threadId, boundary);
  const saved = structuredClone(original);
  const newId = crypto.randomUUID(); const now = Math.floor(Date.now() / 1000);
  saved.thread.id = newId; saved.thread.parentThreadId = null; saved.thread.forkedFromId = threadId;
  saved.thread.createdAt = now; saved.thread.updatedAt = now; saved.thread.status = { type: 'idle' };
  saved.inheritedTurnIds = saved.thread.turns.map(turn => turn.id);
  // Retain these observations in the source archive. A fork does not inherit commands to deliver.
  saved.inputRecords = [];
  const configuration = configurationFor(archive, threadId, boundary.runId);
  const runtime = new AgentRuntime(optionsFor(configuration, bindings));
  runtime.restoreSnapshots([saved]);
  return { runtime, threadId: newId, warnings: warningsFor(archive, configuration, bindings, [original]) };
}
