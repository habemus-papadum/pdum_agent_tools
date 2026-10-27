/** Pure source-specific projections. Native envelopes are retained verbatim for inspection. */
export type Native = Record<string, unknown>;
export interface HistorySource extends Native {kind: string; method: string; capturedAt: string;}
export interface HistoryEntry extends Native {
  key: string; provider: string; sessionId: string; title: string; source: HistorySource;
}
export interface HistoryDocument extends HistoryEntry {payload: unknown;}
export interface HistoryCatalog extends Native {version?: number; sessions: HistoryEntry[];}
export interface Usage {
  input: number | null; cachedInput: number | null; cacheCreation: number | null; output: number | null;
}
export type Block = {kind: 'markdown' | 'thinking' | 'code' | 'image' | 'tool' | 'result' | 'unknown';
  text?: string; language?: string; label?: string; url?: string; reference?: string; origin?: string; qualification?: string; raw: unknown;};
export interface ItemTiming {startedAtMs: number | null; completedAtMs: number | null; reportedDurationMs: number | null;}
export interface HistoryOperation {
  kind: string; label: string; basis: 'native' | 'recognized-text'; targetAgentId?: string;
  taskId?: string; detail?: string; reportedStatus?: string;
}
export interface HistoryItem {
  id: string; nativeId: string | null; turnId: string | null; role: string; label: string;
  path: string; blocks: Block[]; raw: unknown; timestamp: string | null;
  requestId: string | null; parentRequestId: string | null; model: string | null; usage: Usage | null;
  phase: string | null; status: string | null;
  timing: ItemTiming; operation: HistoryOperation | null; messageDisposition: string | null;
  modelScope: 'actor-response' | 'child-creation' | null;
  childIds: string[]; search: string;
}
export interface HistoryProjection {
  document: HistoryDocument; items: HistoryItem[]; unknownBlocks: number; warnings: string[];
  ledger: ReturnType<typeof usageLedger>;
}
export const object = (value: unknown): Native => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Native : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const text = (value: unknown): string => str(value) ?? '';
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const emptyTiming = (): ItemTiming => ({startedAtMs: null, completedAtMs: null, reportedDurationMs: null});
// Image bytes stay in raw records. A tool summary must not copy megabytes of base64 into
// search strings and code blocks; actual images have their own projection below.
const json = (value: unknown): string => JSON.stringify(value, function(key, entry) {
  if (typeof entry === 'string' && (entry.startsWith('data:image/') ||
    (key === 'data' && (this?.media_type || this?.mimeType)))) return '[image bytes retained in native record]';
  return entry;
}, 2) ?? String(value);

/** Image policy: show embedded raster bytes / exported same-origin assets; other locations remain inspectable references. */
export function imageURL(value: unknown): string | undefined {
  const url = str(value);
  if (!url) return;
  // Native bytes are trusted local data; the browser decoder validates the payload.
  // Matching the header avoids scanning megabytes again for every thumbnail render.
  if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(url)) return url;
  if (url.startsWith('/__history/assets/') || url.startsWith('/history/specimen.')) return url;
}

/** Optional temporary export sidecar; native records retain their original image reference. */
export function resolveImage(image: Partial<Block>, assets: unknown): Partial<Block> {
  if (image.url || !image.reference || !Array.isArray(assets)) return image;
  const asset = assets.find(value => object(value).reference === image.reference);
  const path = object(asset).path;
  if (typeof path !== 'string' || !/^assets\/[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(path)) return image;
  return {...image, url: `/__history/${path}`, qualification: 'File copied at export time; historical byte equality unverified'};
}

function imageBlock(raw: unknown, origin = 'Image reference'): Block {
  const block = object(raw), source = object(block.source);
  const reference = block.url ?? block.imageUrl ?? block.image_url ?? block.path ?? block.fileId ?? source.url;
  const url = imageURL(reference ??
    (source.type === 'base64' ? `data:${text(source.media_type)};base64,${text(source.data)}` :
      block.mimeType && block.data ? `data:${text(block.mimeType)};base64,${text(block.data)}` : undefined));
  return {kind: 'image', url, reference: typeof reference === 'string' && !reference.startsWith('data:') ? reference : undefined,
    origin, label: text(block.alt) || origin, raw};
}

/** Follow native content containers only; image origin belongs to its containing operation. */
function nestedImages(value: unknown, origin: string): Block[] {
  if (Array.isArray(value)) return value.flatMap(entry => nestedImages(entry, origin));
  const raw = object(value);
  if (['image', 'input_image', 'inputImage'].includes(text(raw.type))) return [imageBlock(raw, origin)];
  return ['content', 'contentItems', 'result'].flatMap(key => raw[key] ? nestedImages(raw[key], origin) : []);
}

function claudeBlock(raw: unknown): Block {
  if (typeof raw === 'string') return {kind: 'markdown', text: raw, raw};
  const block = object(raw);
  switch (block.type) {
    case 'text': return {kind: 'markdown', text: text(block.text), raw};
    case 'thinking': return {kind: 'thinking', text: text(block.thinking), raw};
    case 'redacted_thinking': return {kind: 'unknown', label: 'Redacted thinking · native record retained', raw};
    case 'image': return imageBlock(raw);
    case 'tool_use': return {kind: 'tool', label: text(block.name), text: json(block.input), raw};
    case 'tool_result': return {kind: 'result', label: block.is_error ? 'Tool error' : 'Tool result',
      text: typeof block.content === 'string' ? block.content : json(block.content), raw};
    default: return {kind: 'unknown', label: text(block.type) || 'Unrecognized content', raw};
  }
}

function usageFrom(raw: unknown): Usage | null {
  const u = object(raw);
  const usage = {input: num(u.input_tokens ?? u.inputTokens), cachedInput: num(u.cache_read_input_tokens ?? u.cachedInputTokens),
    cacheCreation: num(u.cache_creation_input_tokens), output: num(u.output_tokens ?? u.outputTokens)};
  return Object.values(usage).some(value => value !== null) ? usage : null;
}

/** Explicit, narrowly recognized CLI text is an operation notice, not a provider-native event. */
export function recognizedClaudeOperation(content: unknown): HistoryOperation | null {
  const textContent = typeof content === 'string' ? content : list(content)
    .filter(block => object(block).type === 'text').map(block => text(object(block).text)).join('\n');
  const value = textContent.trim();
  const tag = (name: string) => value.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim();
  if (/^<command-(?:name|message)>/.test(value) && tag('command-name') === '/compact')
    return {kind: 'compact-command', label: 'Compact requested', basis: 'recognized-text', detail: tag('command-args')};
  if (value.startsWith('<local-command-stdout>')) return {
    kind: 'local-command-output', label: 'Local command output', basis: 'recognized-text',
    detail: tag('local-command-stdout')?.slice(0, 180),
  };
  if (/^(?:<system-reminder>\s*)?<task-notification>/.test(value)) return {
    kind: 'task-notification', label: `Task ${tag('status') || 'notification'}`, basis: 'recognized-text',
    taskId: tag('task-id'), detail: tag('summary') || tag('result')?.slice(0, 180), reportedStatus: tag('status'),
  };
  return null;
}

function claudeOperation(blocks: Block[], content: unknown): HistoryOperation | null {
  for (const block of blocks) {
    const raw = object(block.raw), input = object(raw.input);
    if (raw.type === 'tool_use' && input.run_in_background === true && ['Bash', 'Agent', 'Task'].includes(text(raw.name)))
      return {kind: 'background-request', label: `Background ${text(raw.name)} requested`, basis: 'native',
        taskId: str(input.task_id) ?? undefined, detail: 'Requested background execution; this record does not establish its lifetime.'};
  }
  return recognizedClaudeOperation(content);
}

function codexOperation(item: Native): HistoryOperation | null {
  if (item.type === 'subAgentActivity') {
    const kind = text(item.kind);
    return {kind: `child-${kind || 'activity'}`, label: kind === 'completed' ? 'Child work completed' : `Child ${kind || 'activity'}`,
      basis: 'native', targetAgentId: str(item.agentThreadId) ?? undefined,
      detail: kind === 'completed' ? 'A child work outcome; not process termination.' : str(item.agentPath) ?? undefined};
  }
  if (item.type === 'contextCompaction') return {kind: 'compaction', label: 'Context compacted', basis: 'native', detail: 'No context occupancy is inferred.'};
  if (item.type === 'sleep') return {kind: 'sleep', label: 'Sleep', basis: 'native'};
  return null;
}

/** Report explicit failures without classifying a missing result as success or failure. */
export function itemHasError(item: HistoryItem): boolean {
  const raw = object(item.raw);
  return ['failed', 'error'].includes(item.status ?? '') ||
    (typeof raw.exitCode === 'number' && raw.exitCode !== 0) || raw.success === false ||
    item.blocks.some(block => object(block.raw).is_error === true) ||
    ['failed', 'error'].includes(item.operation?.reportedStatus ?? '');
}

function claudeItems(document: HistoryDocument): HistoryItem[] {
  const messages = list(object(document.payload).messages);
  const toolRequests = new Map<string, string>();
  const items = messages.map((raw, index): HistoryItem => {
    const wrapper = object(raw), message = object(wrapper.message);
    const role = text(message.role) || text(wrapper.type) || 'unknown';
    const requestId = role === 'assistant' ? str(message.id) : null;
    const content = message.content ?? wrapper.content;
    const blocks = (Array.isArray(content) ? content : [content]).filter(value => value !== undefined).flatMap(value => {
      if (object(value).type === 'image') return [imageBlock(value, role === 'user' ? 'User input' : 'Assistant image')];
      return [claudeBlock(value), ...nestedImages(object(value).content, object(value).type === 'tool_result' ? 'Tool output' : 'Nested image')];
    });
    for (const block of blocks) {
      if (block.kind === 'tool' && requestId && str(object(block.raw).id)) toolRequests.set(text(object(block.raw).id), requestId);
    }
    const nativeId = str(wrapper.uuid ?? wrapper.id ?? message.id);
    const parentTool = str(wrapper.parent_tool_use_id) ?? blocks.map(block => str(object(block.raw).tool_use_id)).find(Boolean) ?? null;
    const childIds = [wrapper.agent_id, wrapper.agentId, ...blocks.flatMap(block => {
      const value = object(block.raw), result = object(value.content);
      return [value.agent_id, value.session_id, result.agent_id, result.session_id];
    })].filter((value): value is string => typeof value === 'string' && value !== document.sessionId);
    return {id: `${document.key}:${index}`, nativeId, turnId: null, role,
      label: blocks.some(block => block.kind === 'result') && blocks.every(block => ['result','image'].includes(block.kind)) ? 'Tool result' : role === 'assistant' ? 'Assistant' : role === 'user' ? 'You' : role,
      path: `payload.messages[${index}]`, blocks, raw, timestamp: str(wrapper.timestamp), requestId,
      parentRequestId: parentTool ? toolRequests.get(parentTool) ?? null : null,
      model: str(message.model), usage: role === 'assistant' ? usageFrom(message.usage) : null,
      phase: null, status: str(wrapper.status), messageDisposition: str(message.stop_reason),
      modelScope: str(message.model) ? 'actor-response' : null, timing: emptyTiming(), operation: claudeOperation(blocks, content),
      childIds: [...new Set(childIds)], search: ''};
  });
  return items;
}

function codexBlocks(raw: unknown): Block[] {
  const item = object(raw);
  switch (item.type) {
    case 'userMessage': return list(item.content).map(content => {
      const block = object(content);
      if (block.type === 'text') return {kind: 'markdown', text: text(block.text), raw: content};
      if (block.type === 'image' || block.type === 'localImage') return imageBlock(content, 'User input');
      return {kind: 'unknown', label: text(block.type), raw: content};
    });
    case 'agentMessage': case 'plan': return [{kind: 'markdown', text: text(item.text), raw}];
    case 'reasoning': return [{kind: 'thinking', text: [...list(item.summary), ...list(item.content)].map(value =>
      typeof value === 'string' ? value : text(object(value).text) || json(value)).join('\n\n'), raw}];
    case 'commandExecution': return [
      {kind: 'code', text: text(item.command), language: 'bash', label: 'Command', raw},
      {kind: 'result', text: text(item.aggregatedOutput), label: `Output · ${text(item.status) || 'status unknown'}${num(item.exitCode) !== null ? ` · exit ${item.exitCode}` : ''}`, raw}];
    case 'fileChange': return [{kind: 'tool', label: `File change · ${text(item.status)}`, raw},
      ...list(item.changes).map(change => ({kind: 'code' as const, label: text(object(change).path), language: 'diff', text: text(object(change).diff), raw: change}))];
    case 'mcpToolCall': case 'dynamicToolCall': case 'collabAgentToolCall': case 'webSearch':
      return [{kind: 'tool', label: text(item.tool) || text(item.type), text: json(item.arguments ?? item.prompt ?? item.action), raw},
        ...(item.result !== undefined || item.content !== undefined || item.contentItems !== undefined ? [{kind: 'result' as const, text: json(item.result ?? item.content ?? item.contentItems), raw}] : []),
        ...nestedImages(item.result ?? item.content ?? item.contentItems, 'Tool output')];
    case 'imageView': return [imageBlock({path: item.path}, 'Image viewed by agent')];
    case 'imageGeneration': return [imageBlock({url: imageURL(item.result), path: item.savedPath, alt: 'Generated image'}, 'Agent-generated image'),
      {kind: 'tool', label: `Image generation · ${text(item.status)}`, raw}];
    case 'contextCompaction': return [{kind: 'tool', label: 'Context compacted', raw}];
    case 'subAgentActivity': return [{kind: 'tool', label: codexOperation(item)?.label, raw}];
    case 'sleep': return [{kind: 'tool', label: 'Sleep', raw}];
    default: return [{kind: 'unknown', label: text(item.type) || 'Unrecognized native item', raw}];
  }
}

function codexItems(document: HistoryDocument, warnings: string[]): HistoryItem[] {
  const payload = object(document.payload), thread = object(payload.thread);
  const turns = list(thread.turns);
  const clocks = new Map<string, ItemTiming>();
  const clockKey = (turn: string, item: string) => JSON.stringify([turn, item]);
  for (const page of list(payload.itemPages)) for (const entry of list(object(object(page).result).data)) {
    const record = object(entry), item = object(record.item), turnId = str(record.turnId), itemId = str(item.id);
    if (!turnId || !itemId) {warnings.push('An item-clock record lacks turn/item identity; it was not joined.'); continue;}
    const key = clockKey(turnId, itemId), value = {startedAtMs: num(record.startedAtMs), completedAtMs: num(record.completedAtMs), reportedDurationMs: num(item.durationMs)};
    const previous = clocks.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) {
      clocks.set(key, emptyTiming()); warnings.push('Conflicting item clocks for one native turn/item; timing is unknown.');
    } else if (!previous) clocks.set(key, value);
  }
  if (!turns.length && list(payload.turnPages).length) warnings.push('thread/read has no turns. Native turn pages are retained in raw payload; no reconstructed execution state.');
  return turns.flatMap((turnValue, turnIndex) => {
    const turn = object(turnValue);
    return list(turn.items).map((raw, itemIndex): HistoryItem => {
      const item = object(raw), type = text(item.type);
      const role = type === 'userMessage' ? 'user' : type === 'agentMessage' || type === 'reasoning' ? 'assistant' : 'tool';
      const nativeId = str(item.id), turnId = str(turn.id), clock = nativeId && turnId ? clocks.get(clockKey(turnId, nativeId)) : undefined;
      return {id: `${document.key}:${turnIndex}:${itemIndex}`, nativeId: str(item.id), turnId: str(turn.id), role,
        label: type.replace(/([a-z])([A-Z])/g, '$1 $2'), path: `payload.thread.turns[${turnIndex}].items[${itemIndex}]`, blocks: codexBlocks(raw), raw,
        timestamp: str(item.timestamp ?? item.createdAt), requestId: str(item.requestId), parentRequestId: null,
        model: str(item.model), usage: usageFrom(item.usage), phase: str(item.phase ?? item.channel),
        timing: clock ? {...clock, reportedDurationMs: num(item.durationMs) ?? clock.reportedDurationMs} : {...emptyTiming(), reportedDurationMs: num(item.durationMs)},
        operation: codexOperation(item), messageDisposition: null,
        modelScope: str(item.model) ? ['subAgentActivity', 'collabAgentToolCall'].includes(type) ? 'child-creation' : 'actor-response' : null,
        status: str(item.status), childIds: [...new Set([
          ...list(item.receiverThreadIds), item.newThreadId, item.agentThreadId, ...Object.keys(object(item.agentsStates)),
        ].filter((id): id is string => typeof id === 'string' && id !== document.sessionId))], search: ''};
    });
  });
}

/** Count request usage once, preserving partial fields and model identity. Duplicate native response records use maxima, never addition. */
export function usageLedger(items: HistoryItem[], provider: string) {
  const requests = new Map<string, {id: string; model: string | null; usage: Usage | null; itemIds: string[]}>();
  for (const item of items) {
    if (!item.requestId) continue;
    const prior = requests.get(item.requestId);
    if (!prior) { requests.set(item.requestId, {id: item.requestId, model: item.model, usage: item.usage ? {...item.usage} : null, itemIds: [item.id]}); continue; }
    prior.itemIds.push(item.id);
    if (!prior.usage) prior.usage = item.usage ? {...item.usage} : null;
    else if (item.usage) for (const key of ['input', 'cachedInput', 'cacheCreation', 'output'] as const) {
      const before: number | null = prior.usage[key], after: number | null = item.usage[key];
      prior.usage = {...prior.usage, [key]: before === null ? after : after === null ? before : Math.max(before, after)};
    }
  }
  const rows = [...requests.values()];
  const total = (field: keyof Usage) => {
    const values = rows.flatMap(row => row.usage?.[field] !== null && row.usage?.[field] !== undefined ? [row.usage[field]!] : []);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  return {requests: rows, knownRequests: rows.filter(row => row.usage).length, input: total('input'), cachedInput: total('cachedInput'),
    cacheCreation: total('cacheCreation'), output: total('output'), cost: null, context: null,
    explanation: provider === 'claude' ? 'Native response IDs deduplicate request usage. Claude input, cache read and cache creation are separate fields. Tools have no independent model charge. Hidden requests may be absent.' :
      'Native history items do not establish model request usage or current context. Tools have no independent model charge; no per-item cost is inferred.'};
}

export function projectHistory(document: HistoryDocument): HistoryProjection {
  const warnings: string[] = [];
  const items = document.provider === 'claude' || document.provider === 'specimen' ? claudeItems(document) : document.provider === 'codex' ? codexItems(document, warnings) : [];
  if (!['claude', 'codex', 'specimen'].includes(document.provider)) warnings.push('Unknown provider: inspect the preserved native payload.');
  for (const item of items) item.search = `${item.label} ${item.operation?.label ?? ''} ${item.operation?.detail ?? ''} ${item.nativeId ?? ''} ${item.turnId ?? ''} ${item.blocks.map(block => `${block.label ?? ''} ${block.text ?? ''}`).join(' ')}`.toLowerCase();
  return {document, items, warnings, unknownBlocks: items.reduce((count, item) => count + item.blocks.filter(block => block.kind === 'unknown').length, 0), ledger: usageLedger(items, document.provider)};
}

export function filterItems(items: HistoryItem[], query: string, kind: string): HistoryItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter(item => (!needle || item.search.includes(needle)) && (kind === 'all' ||
    (kind === 'image' ? item.blocks.some(block => block.kind === 'image') :
      kind === 'event' ? item.operation !== null : kind === 'error' ? itemHasError(item) :
      kind === 'tool' ? item.role === 'tool' || item.blocks.some(block => block.kind === 'tool' || block.kind === 'result') : item.role === kind)));
}
export function filterCatalog(entries: HistoryEntry[], provider: string, query: string): HistoryEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter(entry => (provider === 'all' || entry.provider === provider) && (!needle || `${entry.title} ${entry.sessionId} ${entry.provider}`.toLowerCase().includes(needle)));
}
export function formatCount(value: number | null): string {return value === null ? 'unknown' : new Intl.NumberFormat('en-US', {notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1}).format(value);}
