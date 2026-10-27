/** Disposable read projection of native family documents. No family state is persisted here. */
import {itemHasError, object, projectHistory, type HistoryDocument, type HistoryEntry, type HistoryItem, type HistoryProjection, type Native, type Usage} from './native';

export interface FamilyManifest extends Native {
  version?: number; id?: string; title?: string; provider?: string; available?: boolean;
  rootKey?: string; members?: HistoryEntry[]; relationships?: unknown; reason?: string;
  groupKind?: 'family' | 'collection';
}
export interface FamilyLane {
  key: string; entry: HistoryEntry; projection: HistoryProjection; items: HistoryItem[];
  parentKey: string | null; parentIdentity: string | null;
  parentStatus: 'root' | 'resolved' | 'missing' | 'unknown' | 'ambiguous';
  parentBasis: 'selected-root' | 'native-thread' | 'sdk-parent-agent' | 'native-tool-reference' | 'unavailable';
  sourceVersion: string | null; stats: ReturnType<typeof laneStats>;
  displayLabel?: string;
}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
const total = (values: (number | null)[]) => {const known = values.filter((value): value is number => value !== null); return known.length ? known.reduce((sum, value) => sum + value, 0) : null;};

/** Counts describe supplied records, not completeness, billing ownership or native task lifetime. */
export function laneStats(projection: HistoryProjection) {
  const items = projection.items;
  const timing = {
    started: items.filter(item => item.timing.startedAtMs !== null).length,
    completed: items.filter(item => item.timing.completedAtMs !== null).length,
    bothEndpoints: items.filter(item => item.timing.startedAtMs !== null && item.timing.completedAtMs !== null).length,
    reportedDuration: items.filter(item => item.timing.reportedDurationMs !== null).length,
    untimed: items.filter(item => item.timing.startedAtMs === null && item.timing.completedAtMs === null).length,
  };
  return {
    items: items.length, turns: projection.document.provider === 'codex' ? new Set(items.map(item => item.turnId).filter(Boolean)).size : null,
    reportedErrors: items.filter(itemHasError).length,
    nativeErrors: items.filter(item => itemHasError(item) && item.operation?.basis !== 'recognized-text').length,
    recognizedFailureNotices: items.filter(item => itemHasError(item) && item.operation?.basis === 'recognized-text').length,
    tools: items.filter(item => item.role === 'tool' || item.blocks.some(block => block.kind === 'tool')).length,
    operations: items.filter(item => item.operation).length,
    images: items.reduce((sum, item) => sum + item.blocks.filter(block => block.kind === 'image').length, 0),
    timing, durationCoverage: {known: timing.reportedDuration, total: items.length},
    usage: projection.ledger, cost: null, context: null,
  };
}

/** Count a response once across documents while retaining every occurrence, with no invented owner. */
export function familyUsage(lanes: readonly FamilyLane[]) {
  const requests = new Map<string, {key: string; id: string; provider: string; model: string | null;
    usage: Usage | null; occurrences: {laneKey: string; itemId: string}[]; modelConflict: boolean}>();
  for (const lane of lanes) for (const item of lane.items) {
    if (!item.requestId) continue;
    const key = JSON.stringify([lane.entry.provider, item.requestId]);
    const previous = requests.get(key);
    if (!previous) {
      requests.set(key, {key, id: item.requestId, provider: lane.entry.provider, model: item.model,
        usage: item.usage ? {...item.usage} : null, occurrences: [{laneKey: lane.key, itemId: item.id}], modelConflict: false});
      continue;
    }
    previous.occurrences.push({laneKey: lane.key, itemId: item.id});
    if (previous.model && item.model && previous.model !== item.model) previous.modelConflict = true;
    if (!previous.model) previous.model = item.model;
    if (!previous.usage) previous.usage = item.usage ? {...item.usage} : null;
    else if (item.usage) for (const field of ['input', 'cachedInput', 'cacheCreation', 'output'] as const) {
      const before = previous.usage[field], after = item.usage[field];
      previous.usage[field] = before === null ? after : after === null ? before : Math.max(before, after);
    }
  }
  const rows = [...requests.values()];
  return {requests: rows, knownRequests: rows.filter(row => row.usage).length,
    input: total(rows.map(row => row.usage?.input ?? null)), cachedInput: total(rows.map(row => row.usage?.cachedInput ?? null)),
    cacheCreation: total(rows.map(row => row.usage?.cacheCreation ?? null)), output: total(rows.map(row => row.usage?.output ?? null)),
    sharedResponses: rows.filter(row => new Set(row.occurrences.map(value => value.laneKey)).size > 1).length,
    cost: null, context: null, ownership: 'unassigned' as const,
    explanation: 'Provider + native response identity deduplicates supplied records. Shared response usage has no assigned lane owner; missing requests remain unknown.'};
}

/** Resolve only evidenced parents. A missing Claude parent does not silently become the main agent. */
export function projectFamily(documents: readonly HistoryDocument[], manifest: FamilyManifest = {}) {
  const warnings: string[] = [];
  const collection=manifest.groupKind==='collection';
  const labels=new Map((Array.isArray(object(manifest.relationships).documents)?object(manifest.relationships).documents as unknown[]:[])
    .map(value=>[String(object(value).key),string(object(value).label)]));
  const available = manifest.available !== false && (manifest.version === undefined || manifest.version === 1);
  if (manifest.available === false) warnings.push(manifest.reason || 'This captured family is unavailable.');
  if (manifest.version !== undefined && manifest.version !== 1) warnings.push(`Unsupported family envelope version ${manifest.version}.`);
  const unique = new Map<string, HistoryDocument>();
  if (available) for (const document of documents) {
    if (unique.has(document.key)) {warnings.push(`Duplicate family document key ${document.key}; duplicate was not merged.`); continue;}
    unique.set(document.key, document);
  }
  const lanes: FamilyLane[] = [...unique.values()].map(document => {
    const projection = projectHistory(document), {payload: _, ...entry} = document;
    const sourceVersion = string(document.source.version);
    if (!sourceVersion) warnings.push(`Source version is not recorded for ${document.key}.`);
    warnings.push(...projection.warnings);
    return {key: document.key, entry, projection, items: projection.items, parentKey: null, parentIdentity: null,
      parentStatus: 'unknown', parentBasis: 'unavailable', sourceVersion, stats: laneStats(projection),displayLabel:collection?labels.get(document.key)??undefined:undefined};
  });
  const toolOwners = new Map<string, Set<string>>();
  for (const lane of lanes) for (const item of lane.items) for (const block of item.blocks) {
    const raw = object(block.raw), toolId = string(raw.id);
    if (lane.entry.provider !== 'claude' || raw.type !== 'tool_use' || !toolId) continue;
    const scope = string(object(lane.entry.source.relation).rootSessionId) ?? lane.entry.sessionId;
    const key = JSON.stringify([scope, toolId]);
    if (!toolOwners.has(key)) toolOwners.set(key, new Set());
    toolOwners.get(key)!.add(lane.key);
  }
  for (const lane of lanes) {
    if(collection)continue; // A review collection is not evidence of ancestry.
    const relation = object(lane.entry.source.relation), thread = object(object(lane.projection.document.payload).thread);
    if (lane.key === manifest.rootKey || relation.kind === 'root') {
      lane.parentStatus = 'root'; lane.parentBasis = 'selected-root'; lane.parentIdentity = string(thread.parentThreadId); continue;
    }
    let candidates: FamilyLane[] = [];
    if (lane.entry.provider === 'codex') {
      lane.parentIdentity = string(thread.parentThreadId);
      if (!lane.parentIdentity) {lane.parentStatus = 'unknown'; lane.parentBasis = 'unavailable'; continue;}
      lane.parentBasis = 'native-thread';
      candidates = lanes.filter(value => value.entry.provider === 'codex' && value.entry.sessionId === lane.parentIdentity && value.key !== lane.key);
    } else if (lane.entry.provider === 'claude') {
      const parentAgents = [...new Set(strings(relation.parentAgentIds))];
      const scope = string(relation.rootSessionId) ?? lane.entry.sessionId;
      if (parentAgents.length > 1) {lane.parentStatus = 'ambiguous'; continue;}
      if (parentAgents.length === 1) {
        lane.parentIdentity = parentAgents[0]; lane.parentBasis = 'sdk-parent-agent';
        candidates = lanes.filter(value => value.entry.provider === 'claude' && value.key !== lane.key &&
          string(object(value.entry.source.relation).agentId) === parentAgents[0] &&
          (string(object(value.entry.source.relation).rootSessionId) ?? value.entry.sessionId) === scope);
      } else {
        const parents = new Set(strings(relation.parentToolUseIds).flatMap(id => [...(toolOwners.get(JSON.stringify([scope, id])) ?? [])]));
        parents.delete(lane.key);
        if (!parents.size) continue;
        lane.parentBasis = 'native-tool-reference';
        candidates = lanes.filter(value => parents.has(value.key));
      }
    } else continue;
    lane.parentStatus = candidates.length === 1 ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'missing';
    lane.parentKey = candidates.length === 1 ? candidates[0].key : null;
  }
  // Malformed or partial evidence can contain cycles. Preserve identity, expose it,
  // and avoid asking a tree renderer to recurse forever.
  const byKey = new Map(lanes.map(lane => [lane.key, lane]));
  for (const lane of lanes) {
    const seen = new Set([lane.key]); let parent = lane.parentKey;
    while (parent) {
      if (seen.has(parent)) {warnings.push(`Cyclic parent evidence for ${lane.key}.`); lane.parentKey = null; lane.parentStatus = 'ambiguous'; break;}
      seen.add(parent); parent = byKey.get(parent)?.parentKey ?? null;
    }
  }
  const missingMembers = (manifest.members ?? []).filter(member => !unique.has(member.key))
    .map(member => ({key: member.key, identity: member.sessionId, reason: 'Metadata is present but its document is unavailable.'}));
  const unresolved = object(object(manifest.relationships).unresolvedReferences);
  for (const [identity, evidence] of Object.entries(unresolved)) missingMembers.push({key: '', identity, reason: string(object(evidence).reason) || 'Native reference is unresolved.'});
  const ledger = familyUsage(lanes);
  return {id: manifest.id ?? null, title: manifest.title ?? 'Captured family', groupKind:collection?'collection' as const:'family' as const, available, rootKey: manifest.rootKey ?? null,
    lanes, ledger, warnings, missingMembers, coverage: manifest.coverage ?? null,
    stats: {lanes: lanes.length, items: lanes.reduce((sum, lane) => sum + lane.items.length, 0),
      reportedErrors: lanes.reduce((sum, lane) => sum + lane.stats.reportedErrors, 0),
      untimedItems: lanes.reduce((sum, lane) => sum + lane.stats.timing.untimed, 0),
      unresolvedParents: lanes.filter(lane => ['missing', 'unknown', 'ambiguous'].includes(lane.parentStatus)).length,
      cost: null, context: null}};
}
