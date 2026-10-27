import type { AgentRuntime, JournalEntry, SavedThread, UsageRecord } from '../../039-hp-agent-runtime/src/runtime.ts';
import type { JobEvent, JobSnapshot } from '../../039-hp-agent-runtime/src/jobs/registry.ts';
import type { BlobStore } from './storage/store.ts';

export interface ArchivedUsage extends Omit<UsageRecord, 'turnId'> {
  turnId: string | null;
  originRunId: string;
  endpoint?: 'responses' | 'responses.compact';
  afterTurnId?: string | null;
  disposition?: 'applied' | 'discarded';
}
export interface HpArchive {
  format: 'hp-session-archive';
  version: 1;
  /** Storage-independent provenance: stable while the same history gains new runtime epochs. */
  sourceId: string;
  runtimeId: string;
  savedAt: string;
  snapshots: SavedThread[];
  usages: ArchivedUsage[];
  epochs: { runId: string; journal: JournalEntry[]; configuration: ArchiveConfiguration }[];
  jobs: JobSnapshot[];
  jobEvents: JobEvent[];
  configuration: ArchiveConfiguration;
}
export interface ArchiveConfiguration { instructions: string; model: string; toolNames: string[] }
const clone = <T>(value: T): T => structuredClone(value);

/** Capturing has no storage I/O. The caller separately chooses when to commit. */
export function captureArchive(runtime: AgentRuntime, options: {
  previous?: HpArchive; sourceId?: string; extraUsages?: ArchivedUsage[];
} = {}): HpArchive {
  const previous = options.previous;
  if (previous && options.sourceId && previous.sourceId !== options.sourceId) throw new Error('Cannot silently change archive source identity');
  const sourceId = previous?.sourceId ?? options.sourceId ?? runtime.runId;
  const snapshots = new Map(previous?.snapshots.map(saved => [saved.thread.id, clone(saved)]) ?? []);
  for (const saved of runtime.snapshots()) snapshots.set(saved.thread.id, saved);
  const configuration = {
    instructions: runtime.options.instructions ?? 'You are a helpful agent.',
    model: runtime.options.model ?? 'gpt-6-luna',
    toolNames: (runtime.options.tools ?? []).map(tool => String(tool.definition.name)),
  };
  const epochs = new Map(previous?.epochs.map(epoch => [epoch.runId, clone(epoch)]) ?? []);
  epochs.set(runtime.runId, { runId: runtime.runId, journal: clone(runtime.journal), configuration });
  const usages = new Map<string, ArchivedUsage>();
  for (const usage of [...(previous?.usages ?? []), ...runtime.usages.map(record => ({ ...record, originRunId: runtime.runId, endpoint: 'responses' as const })), ...(options.extraUsages ?? [])]) {
    const id = usage.usage.responseId;
    const old = usages.get(id);
    if (old && (JSON.stringify(old.usage) !== JSON.stringify(usage.usage)
      || old.threadId !== usage.threadId || old.turnId !== usage.turnId
      || (old.endpoint ?? 'responses') !== (usage.endpoint ?? 'responses')
      || old.originRunId !== usage.originRunId)) throw new Error(`Conflicting usage for response ${id}`);
    if (!old) usages.set(id, clone(usage));
  }
  const jobs = new Map(previous?.jobs.map(job => [job.id, clone(job)]) ?? []);
  for (const job of runtime.jobs.list({ ownerId: runtime.runId })) jobs.set(job.id, job);
  const jobEvents = new Map((previous?.jobEvents ?? []).map(event => [`${event.ownerId}:${event.seq}`, clone(event)]));
  for (const event of runtime.jobs.events().filter(event => event.ownerId === runtime.runId)) jobEvents.set(`${event.ownerId}:${event.seq}`, event);
  return {
    format: 'hp-session-archive', version: 1, sourceId, runtimeId: runtime.runId,
    savedAt: new Date().toISOString(), snapshots: [...snapshots.values()], usages: [...usages.values()],
    epochs: [...epochs.values()], jobs: [...jobs.values()], jobEvents: [...jobEvents.values()], configuration,
  };
}

export function encodeArchive(archive: HpArchive): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(archive));
}
export function decodeArchive(bytes: Uint8Array): HpArchive {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (value?.format !== 'hp-session-archive' || value.version !== 1) throw new Error('Unsupported HP archive format/version');
  if (typeof value.sourceId !== 'string' || typeof value.runtimeId !== 'string' || typeof value.savedAt !== 'string'
    || !Array.isArray(value.snapshots) || !Array.isArray(value.usages) || !Array.isArray(value.epochs)
    || !Array.isArray(value.jobs) || !Array.isArray(value.jobEvents) || typeof value.configuration?.instructions !== 'string'
    || !Array.isArray(value.configuration?.toolNames)) throw new Error('Incomplete HP archive');
  const ids = new Set<string>();
  for (const saved of value.snapshots) {
    if (typeof saved?.thread?.id !== 'string' || !Array.isArray(saved.thread.turns) || !Array.isArray(saved.context)
      || !Array.isArray(saved.inheritedTurnIds) || !Array.isArray(saved.contextCheckpoints)) throw new Error('Invalid saved thread');
    if (ids.has(saved.thread.id)) throw new Error('Duplicate saved conversation identity');
    ids.add(saved.thread.id);
  }
  return value as HpArchive;
}

/** Pure read operations never create a runtime, connector, credentials or tool bindings. */
export class ArchiveRepository {
  constructor(readonly store: BlobStore) {}
  async put(key: string, archive: HpArchive): Promise<void> { await this.store.write(key, encodeArchive(archive)); }
  async get(key: string): Promise<HpArchive | null> {
    const bytes = await this.store.read(key); return bytes === null ? null : decodeArchive(bytes);
  }
  async list() {
    const records = await Promise.all((await this.store.keys()).map(async key => {
      const archive = await this.get(key);
      return archive && { key, sourceId: archive.sourceId, savedAt: archive.savedAt, runtimeId: archive.runtimeId,
        threads: archive.snapshots.map(saved => ({ id: saved.thread.id, preview: saved.thread.preview,
          turns: saved.thread.turns.length, status: clone(saved.thread.status) })) };
    }));
    return records.filter(record => record !== null);
  }
  async remove(key: string) { await this.store.remove(key); }
}

export interface CompletedBoundary {
  runId: string; seq: number; afterTurnId: string; reason: string; ts: string;
}

/** Exact snapshot references distinguish before/after compaction at the same turn. */
export function completedBoundaries(archive: HpArchive, threadId: string): CompletedBoundary[] {
  const result: CompletedBoundary[] = [];
  for (const epoch of archive.epochs) for (const entry of epoch.journal) {
    if (entry.kind !== 'threadSnapshot') continue;
    const saved = entry.data as unknown as SavedThread;
    const last = saved.thread.turns.at(-1);
    if (saved.thread.id !== threadId || last?.status !== 'completed'
      || saved.thread.turns.some(turn => turn.status === 'inProgress')) continue;
    const checkpoint = saved.contextCheckpoints.at(-1);
    result.push({ runId: epoch.runId, seq: entry.seq, afterTurnId: last.id, ts: entry.ts,
      reason: checkpoint?.afterTurnId === last.id ? checkpoint.reason : 'completed-turn' });
  }
  return result;
}

export function snapshotAt(archive: HpArchive, threadId: string, boundary: Pick<CompletedBoundary, 'runId' | 'seq'>): SavedThread {
  const allowed = completedBoundaries(archive, threadId).some(item => item.runId === boundary.runId && item.seq === boundary.seq);
  if (!allowed) throw new Error('Fork requires a recorded completed-turn snapshot');
  const entry = archive.epochs.find(epoch => epoch.runId === boundary.runId)!.journal.find(item => item.seq === boundary.seq)!;
  return clone(entry.data as unknown as SavedThread);
}

/** The recipe follows its producing epoch, not a later owner's configuration. */
export function configurationFor(archive: HpArchive, threadId: string, runId?: string): ArchiveConfiguration {
  for (const epoch of [...archive.epochs].reverse()) {
    if (runId ? epoch.runId === runId : epoch.journal.some(entry => entry.kind === 'threadSnapshot'
      && (entry.data as unknown as SavedThread).thread.id === threadId)) return clone(epoch.configuration);
  }
  throw new Error('Saved conversation has no producing configuration epoch');
}
