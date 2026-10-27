/** Persisted context and this connection's live tail, with source provenance intact. */
import {projectHistory, projectLive} from './projections';
import type {HistoryDocument, Projection, Provider, WireRecord} from './types';

export function projectConversation(provider: Provider, records: WireRecord[], baseline?: HistoryDocument | null): Projection {
  const live = projectLive(provider, records);
  if (!baseline) return live;
  const saved = projectHistory(baseline);
  // The closing study resumes ended histories, not arbitrary mid-turn joins.
  // Codex item identity is stable across these sources. Claude wrapper UUIDs
  // and model response IDs differ, so never deduplicate them by body text.
  const liveNative = provider === 'codex' ? new Set(live.items.flatMap(item => item.nativeId ? [item.nativeId] : [])) : null;
  const prefix = saved.items.filter(item => !liveNative || !item.nativeId || !liveNative.has(item.nativeId));
  return {
    items: [...prefix, ...live.items],
    usage: {...live.usage, basis: live.usage.basis + ' Saved baseline measurements are not added to these counters.'},
    notes: [
      'Earlier context comes from a native history read at connection time; new records come from this live connection.',
      'This projection qualifies continuation of ended histories, not generic overlap reconciliation for an arbitrary late join.',
      ...live.notes,
    ],
  };
}
