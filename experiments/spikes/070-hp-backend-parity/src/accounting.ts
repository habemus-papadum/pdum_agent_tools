import { historyRows } from '../../039-hp-agent-runtime/src/history.ts';
import type { Json } from '../../039-hp-agent-runtime/src/runtime.ts';
import type { HpArchive } from './archive.ts';
import type { CompactionOutcome } from '../../043-hp-context-compaction/src/compaction.ts';

type ArchivedUsage = HpArchive['usages'][number];

/** Compaction is paid work outside a turn, even if its result was discarded. */
export function compactionUsage(outcome: CompactionOutcome, originRunId: string): ArchivedUsage {
  const u = outcome.usage;
  return { originRunId, threadId: u.threadId, turnId: null, afterTurnId: u.afterTurnId,
    endpoint: 'responses.compact', disposition: outcome.status, ts: outcome.capturedAt,
    usage: { type: 'usage', responseId: u.responseId, model: u.model, inputTokens: u.inputTokens,
      cachedInputTokens: u.cachedInputTokens, cacheWriteTokens: u.cacheWriteTokens,
      outputTokens: u.outputTokens, reasoningOutputTokens: u.reasoningTokens } };
}
export interface Rates { uncached: number; cached: number; cacheWrite: number; output: number }
export interface Prices { version: string; models: Record<string, Rates> }
interface Snapshot {
  fetched_at: string;
  entries: Record<string, {
    input_cost_per_token?: number; cache_read_input_token_cost?: number;
    cache_creation_input_token_cost?: number; output_cost_per_token?: number;
  }>;
}

/** Adapt an injected dated table. No filesystem, browser storage or network dependency. */
export function pricesFromSnapshot(snapshot: Snapshot): Prices {
  const models: Record<string, Rates> = {};
  for (const [model, value] of Object.entries(snapshot.entries)) {
    if (value.input_cost_per_token === undefined || value.output_cost_per_token === undefined) continue;
    models[model] = { uncached: value.input_cost_per_token * 1e6,
      cached: (value.cache_read_input_token_cost ?? value.input_cost_per_token) * 1e6,
      cacheWrite: (value.cache_creation_input_token_cost ?? value.input_cost_per_token) * 1e6,
      output: value.output_cost_per_token * 1e6 };
  }
  return { version: `litellm ${snapshot.fetched_at}`, models };
}

function signature(record: ArchivedUsage): string {
  return JSON.stringify({ threadId: record.threadId, turnId: record.turnId,
    endpoint: record.endpoint ?? 'responses', usage: record.usage });
}

/** Native response identity is stable across archive copies, owner restarts and observers. */
export function uniqueUsage(archive: HpArchive): ArchivedUsage[] {
  const found = new Map<string, ArchivedUsage>();
  for (const record of archive.usages) {
    const id = record.usage.responseId;
    if (!id) throw new Error('Usage record has no response identity');
    const previous = found.get(id);
    if (previous && signature(previous) !== signature(record)) {
      throw new Error(`Conflicting usage for response ${id}; do not silently choose a price`);
    }
    if (!previous) found.set(id, record);
  }
  return [...found.values()];
}

function counters(record: ArchivedUsage) {
  const u = record.usage;
  const values = [u.inputTokens, u.cachedInputTokens, u.cacheWriteTokens, u.outputTokens];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)
    || u.cachedInputTokens + u.cacheWriteTokens > u.inputTokens) return null;
  return { input: u.inputTokens, uncached: u.inputTokens - u.cachedInputTokens - u.cacheWriteTokens,
    cached: u.cachedInputTokens, cacheWrite: u.cacheWriteTokens, output: u.outputTokens };
}

function expectedResponses(archive: HpArchive): Set<string> {
  const ids = new Set<string>();
  for (const epoch of archive.epochs) for (const record of epoch.journal) {
    if (record.kind !== 'modelEvent') continue;
    const event = record.data.event as Json | undefined;
    if (event?.type === 'completed' && typeof event.responseId === 'string') ids.add(event.responseId);
    if (event?.type === 'raw') {
      const raw = event.event as Json | undefined;
      const response = raw?.response as Json | undefined;
      if (raw?.type === 'response.created' && typeof response?.id === 'string') ids.add(response.id);
    }
  }
  return ids;
}

/** Known recorded usage, not context size or an assertion of complete provider billing. */
export function summarizeArchive(archive: HpArchive, prices?: Prices) {
  const records = uniqueUsage(archive);
  const total = { input: 0, uncached: 0, cached: 0, cacheWrite: 0, output: 0 };
  const byThread: Record<string, { responses: number; knownCostUsd: number }> = {};
  const invalidResponseIds: string[] = [];
  const unpricedResponseIds: string[] = [];
  let knownCostUsd = 0;
  for (const record of records) {
    const counter = counters(record);
    if (!counter) { invalidResponseIds.push(record.usage.responseId); continue; }
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += counter[key];
    const thread = byThread[record.threadId] ??= { responses: 0, knownCostUsd: 0 };
    thread.responses++;
    const rates = prices?.models[record.usage.model];
    if (!rates) { unpricedResponseIds.push(record.usage.responseId); continue; }
    const cost = (counter.uncached * rates.uncached + counter.cached * rates.cached
      + counter.cacheWrite * rates.cacheWrite + counter.output * rates.output) / 1e6;
    knownCostUsd += cost; thread.knownCostUsd += cost;
  }
  const observed = new Set(records.map(record => record.usage.responseId));
  const missingResponseIds = [...expectedResponses(archive)].filter(id => !observed.has(id));
  const observedTurnKeys = new Set(records.filter(record => record.turnId !== null)
    .map(record => `${record.threadId}\0${record.turnId}`));
  const turnsWithoutUsage = archive.snapshots.flatMap(saved => saved.thread.turns
    .filter(turn => !saved.inheritedTurnIds.includes(turn.id) && !observedTurnKeys.has(`${saved.thread.id}\0${turn.id}`))
    .map(turn => ({ threadId: saved.thread.id, turnId: turn.id, status: turn.status })));
  return { sourceId: archive.sourceId, responses: records.length, duplicateUsageRecords: archive.usages.length - records.length,
    counts: total, knownCostUsd, pricingVersion: prices?.version ?? null, byThread,
    compactionResponses: records.filter(record => record.endpoint === 'responses.compact').length,
    invalidResponseIds, unpricedResponseIds, missingResponseIds, turnsWithoutUsage,
    complete: invalidResponseIds.length === 0 && unpricedResponseIds.length === 0
      && missingResponseIds.length === 0 && turnsWithoutUsage.length === 0,
    contextTokens: null,
    coverage: 'Recorded response usage only. Input includes cached tokens; context occupancy is not inferred.' };
}

/** Reuse the existing transcript exporter; add stable archive provenance and scoped usage. */
export function archiveHistoryRows(archive: HpArchive) {
  const records = uniqueUsage(archive);
  const exported = historyRows({ runId: archive.sourceId, snapshots: () => structuredClone(archive.snapshots), usages: [] });
  const source = { source_id: archive.sourceId, source: 'hp-agent', origin: 'runtime' };
  const byId = new Map(archive.snapshots.map(saved => [saved.thread.id, saved]));
  exported.tables.responses = records.map((record, index) => {
    const u = record.usage, known = counters(record);
    return { ...source, origin: record.endpoint === 'responses.compact' ? 'responses.compact' : 'runtime',
      thread_id: record.threadId, turn_id: record.turnId, root_turn_id: record.turnId,
      session_id: byId.get(record.threadId)?.thread.sessionId ?? null,
      response_id: u.responseId, ts: record.ts, rollout_ordinal: index + 1, model: u.model,
      input_tokens: known?.input ?? null, cached_input_tokens: known?.cached ?? null,
      cache_write_input_tokens: known?.cacheWrite ?? null, cache_write_1h_input_tokens: 0,
      output_tokens: known?.output ?? null, reasoning_output_tokens: u.reasoningOutputTokens ?? null,
      total_tokens: known ? known.input + known.output : null };
  });
  exported.tables.thread_links = archive.snapshots.filter(saved => saved.thread.forkedFromId).map(saved => ({
    ...source, thread_id: saved.thread.id, kind: 'forked-from', target_thread_id: saved.thread.forkedFromId,
    ordinal: 0, records: saved.inheritedTurnIds.length, ts: new Date(saved.thread.createdAt * 1000).toISOString(),
    detail: JSON.stringify({ inheritedTurnIds: saved.inheritedTurnIds }),
  }));
  for (const row of exported.tables.coverage ?? []) {
    const saved = byId.get(String(row.thread_id));
    row.rollout_format = 'hp-session-archive-v1';
    row.compactions = saved?.contextCheckpoints.filter(checkpoint => checkpoint.reason.startsWith('responses.compact:')).length ?? 0;
    row.usage_records = records.filter(record => record.threadId === row.thread_id).length;
  }
  // The ingestor owns provenance and operational ledger rows. Neither origin nor
  // source identity depends on the file/browser store that supplied this object.
  exported.tables.provenance = [];
  return exported;
}

export function historyExport(archive: HpArchive, prices?: Prices) {
  return { format: 'hp-history-export', version: 1, sourceId: archive.sourceId,
    archiveVersion: archive.version, savedAt: archive.savedAt, runtimeId: archive.runtimeId,
    rows: archiveHistoryRows(archive), statistics: summarizeArchive(archive, prices) };
}
