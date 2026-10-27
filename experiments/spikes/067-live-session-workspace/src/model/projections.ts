/** Small view adapters over native records. They do not define a persisted or provider SDK schema. */
import {projectHistory as projectSaved, type HistoryDocument as SavedDocument} from '../../../059-historical-viewer/src/model/native';
import type {DisplayItem, HistoryDocument, Projection, Provider, Usage, WireRecord} from './types';
import {requestedCancellationIds} from './command-state';

type ObjectValue = Record<string, any>;
const obj = (v: any): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = (v: any): any[] => Array.isArray(v) ? v : [];
const text = (v: any): string => typeof v === 'string' ? v : '';
const number = (v: any): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const json = (v: any): string => JSON.stringify(v, function(key, value) {
  return typeof value === 'string' && (value.startsWith('data:image/') || key === 'data' && (this?.media_type || this?.mimeType))
    ? '[image bytes retained in raw record]' : value;
}, 2) ?? '';
const contentText = (v: any): string => typeof v === 'string' ? v : list(v).map(b => b.type === 'text' ? text(b.text) :
  b.type === 'thinking' ? text(b.thinking) : b.type === 'tool_result' ? contentText(b.content) : json(b)).join('\n');
const unknownUsage = (basis: string): Usage => ({basis});

function savedRows(document: HistoryDocument, source: 'live' | 'history'): DisplayItem[] {
  const projected = projectSaved(document as unknown as SavedDocument);
  return projected.items.flatMap(item => {
    const rows = item.blocks.map((block, index): DisplayItem => {
    const tool = ['tool', 'result', 'code'].includes(block.kind) && (item.role === 'tool' || block.kind !== 'code');
    const raw = obj(block.raw);
    const toolId = text(raw.id ?? raw.tool_use_id);
    return {
      id: source + ':' + item.id + ':' + index,
      nativeId: toolId || item.nativeId || undefined,
      role: tool ? 'tool' : item.role === 'user' || item.role === 'assistant' ? item.role : item.role === 'tool' ? 'tool' : 'system',
      kind: block.kind === 'thinking' ? 'reasoning' : tool ? 'tool' : block.kind === 'unknown' || block.kind === 'image' ? 'unknown' : 'message',
      title: block.label || (block.kind === 'thinking' ? 'Reasoning' : item.label),
      text: block.text ?? (block.kind === 'image' ? block.reference || 'Image bytes retained in raw record' : json(block.raw)),
      phase: item.phase ?? undefined,
      state: raw.is_error === true ? 'error' : item.status ?? item.messageDisposition ?? undefined,
      raw: {envelope: item.raw, block: block.raw, nativePath: item.path}, source,
    };
    });
    if (document.provider !== 'codex' || rows.length < 2) return rows;
    return [{...rows[0]!, text: rows.map(row=>row.text).filter(Boolean).join('\n\n'),
      raw: {envelope:item.raw,blocks:item.blocks.map(block=>block.raw),nativePath:item.path}}];
  });
}

/** Use the reviewed 059 native projection, with an explicit read-only page projection when necessary. */
export function projectHistory(document: HistoryDocument): Projection {
  const notes: string[] = [];
  let rendering = document;
  if (document.provider === 'codex' && !list(document.payload?.thread?.turns).some(t => list(t.items).length)) {
    const turns = new Map<string, any>();
    for (const page of list(document.payload?.turnPages)) for (const entry of list(page.result?.data)) {
      const turn = entry.turn ?? entry;
      if (typeof turn.id === 'string') turns.set(turn.id, {...turn, items: [...list(turn.items)]});
    }
    for (const page of list(document.payload?.itemPages)) for (const entry of list(page.result?.data)) {
      if (!entry.item || typeof entry.turnId !== 'string') continue;
      const turn = turns.get(entry.turnId) ?? {id: entry.turnId, items: []};
      if (!turn.items.some((item: any) => item.id === entry.item.id)) turn.items.push(entry.item);
      turns.set(entry.turnId, turn);
    }
    if (turns.size) {
      rendering = {...document, payload: {...document.payload, thread: {...document.payload?.thread, turns: [...turns.values()]}}};
      notes.push('Items are projected from native pages for reading; this does not recreate execution state.');
    }
  }
  const projected = projectSaved(rendering as unknown as SavedDocument);
  let items = savedRows(rendering, 'history');
  if (rendering !== document) items = items.map(item=>({...item, raw:{
    renderingInput:item.raw,
    nativePages:list(document.payload?.itemPages).flatMap((page,pageIndex)=>list(page.result?.data)
      .flatMap((entry,itemIndex)=>entry.item?.id===item.nativeId?[{
        path:'payload.itemPages['+pageIndex+'].result.data['+itemIndex+']',entry,
      }]:[])),
  }}));
  let usage: Usage = unknownUsage('Native Codex history does not establish request usage, cost or current context.');
  if (document.provider === 'claude') usage = {
    input: projected.ledger.input ?? undefined, cached: projected.ledger.cachedInput ?? undefined,
    inputBasis: projected.ledger.input === null ? undefined : 'uncached',
    cacheCreated: projected.ledger.cacheCreation ?? undefined, output: projected.ledger.output ?? undefined,
    basis: 'Known saved response IDs, deduplicated; uncached input, cache read and creation are separate. Cost/context not supplied by this history API.',
  };
  return {items, usage,
    notes: [...notes, ...projected.warnings, projected.ledger.explanation,
      'Saved records are a provider projection. They do not establish current process liveness.']};
}

interface PendingUser {key: string; text: string; consumed: boolean;}
function userRow(id: string, value: string, raw: any): DisplayItem {
  return {id, role: 'user', kind: 'message', title: 'You', text: value, state: 'submitted', raw, source: 'live'};
}
function localUser(record: WireRecord): boolean {return record.message?.type === 'local/user';}

function projectCodex(records: WireRecord[]): Projection {
  const rows = new Map<string, DisplayItem>();
  const nativeItems = new Map<string, {item: any; frames: any[]; turnId: string}>();
  const pending: PendingUser[] = [];
  const consumed = new Set<string>();
  let usage = unknownUsage('No native token-usage notification observed; cost is not reported by this stream.');
  const ignored = /^(thread\/(started|status\/changed|name\/updated)|turn\/(started|completed|diff\/updated|plan\/updated)|account\/|rateLimits\/|serverRequest\/|session\/)/;
  function putNative(key: string, item: any, turnId: string, raw: any, complete: boolean) {
    const previous = nativeItems.get(key);
    const merged = {...previous?.item, ...item};
    if (!complete && previous && item.text === '') merged.text = previous.item.text;
    const frames = [...previous?.frames ?? [], raw];
    nativeItems.set(key, {item: merged, frames, turnId});
    const projected = savedRows({version: 1, key, provider: 'codex', sessionId: '', title: '', source: {},
      payload: {thread: {turns: [{id: turnId, items: [merged]}]}}}, 'live');
    // Codex command inputs/output are one expandable operation, unlike the
    // separate Claude tool-use and tool-result messages.
    const first = projected[0];
    if (first) rows.set(key, {...first, id: key, nativeId: text(item.id) || first.nativeId,
      kind: merged.type === 'reasoning' ? 'reasoning' : first.kind,
      text: projected.map(p => p.text).filter(Boolean).join('\n\n'),
      state: text(merged.status) || (complete ? 'completed' : 'streaming'), raw: {item: merged, frames}});
    if (merged.type === 'userMessage' && !consumed.has(key)) {
      consumed.add(key);
      const value = contentText(merged.content);
      const echo = pending.find(p => !p.consumed && p.text === value);
      if (echo) {echo.consumed = true; rows.delete(echo.key);}
    }
  }
  for (const record of records) {
    const message = obj(record.message), p = obj(message.params);
    if (localUser(record)) {
      const key = 'local:' + (message.id || record.seq);
      rows.set(key, userRow(key, text(message.text), message));
      pending.push({key, text: text(message.text), consumed: false});
      continue;
    }
    if (record.direction === 'out') {
      if (message.method === 'turn/start') {
        const value = contentText(p.input);
        if (!pending.some(v => !v.consumed && v.text === value)) {
          const key = 'request:' + (message.id ?? record.seq);
          rows.set(key, userRow(key, value, message));pending.push({key, text: value, consumed: false});
        }
      }
      continue;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const u = obj(p.tokenUsage), total = obj(u.total), last = obj(u.last);
      usage = {input: number(total.inputTokens), cached: number(total.cachedInputTokens), output: number(total.outputTokens),
        inputBasis: number(total.inputTokens) === undefined ? undefined : 'includes-cache',
        context: number(last.totalTokens), contextWindow: number(u.modelContextWindow),
        basis: 'Latest native cumulative token totals; context is last.totalTokens. No stream-reported dollar cost.'};
      continue;
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = obj(p.item), turnId = text(p.turnId), id = text(item.id);
      if (id) putNative('codex:' + turnId + ':' + id, item, turnId, message, message.method === 'item/completed');
      else rows.set('unknown:' + record.seq, {id: 'unknown:' + record.seq, role: 'system', kind: 'unknown',
        title: 'Item without native identity', text: json(item), raw: message, source: 'live'});
      continue;
    }
    const deltaType = message.method === 'item/agentMessage/delta' ? 'agentMessage' :
      message.method === 'item/commandExecution/outputDelta' ? 'commandExecution' :
      /item\/reasoning\/(summaryTextDelta|textDelta)/.test(text(message.method)) ? 'reasoning' : null;
    if (deltaType && p.itemId) {
      const key = 'codex:' + text(p.turnId) + ':' + p.itemId;
      const before = nativeItems.get(key)?.item ?? {id: p.itemId, type: deltaType};
      const next = {...before};
      if (deltaType === 'commandExecution') next.aggregatedOutput = text(before.aggregatedOutput) + text(p.delta);
      else if (deltaType === 'reasoning') next.content = [list(before.content).join('') + text(p.delta)];
      else next.text = text(before.text) + text(p.delta);
      putNative(key, next, text(p.turnId), message, false);continue;
    }
    if (message.error || (message.method && !ignored.test(message.method))) {
      const id = 'event:' + record.seq;
      rows.set(id, {id, role: 'system', kind: 'unknown', title: message.error ? 'Protocol error' : text(message.method),
        text: json(message.error ?? message.params), state: message.error ? 'error' : undefined, raw: message, source: 'live'});
    }
  }
  return {items: [...rows.values()], usage, notes: [
    'Native start/delta/completion records share one item. Its completion replaces streamed text; raw frames remain inspectable.',
    'Submitted prompts use local receipt identity until a matching native user item arrives. Repeated prompts reconcile in arrival order.',
    'Codex message phase is retained when reported. Unknown events remain inspectable.',
  ]};
}

interface ClaudeResponse {id: string; message: any; blocks: Map<number, any>; frames: any[]; state: string;}
function projectClaude(records: WireRecord[]): Projection {
  const requestedCancellations = requestedCancellationIds(records);
  let currentCommand: string | undefined;
  const rows = new Map<string, DisplayItem>(), responses = new Map<string, ClaudeResponse>();
  const pending: PendingUser[] = [], resultSeen = new Set<string>();
  const modelUsage = new Map<string, any>(), responseUsage = new Map<string, any>(), resultUsage: any[] = [];
  const activeResponses = new Map<string,string>();
  let cost: number | undefined;
  const render = (response: ClaudeResponse) => {
    for (const [index, block] of response.blocks) {
      const key = 'claude:' + response.id + ':' + index;
      const tool = block.type === 'tool_use';
      rows.set(key, {id: key, nativeId: text(block.id) || response.id, role: tool ? 'tool' : 'assistant',
        kind: tool ? 'tool' : block.type === 'thinking' ? 'reasoning' : block.type === 'text' ? 'message' : 'unknown',
        title: tool ? text(block.name) || 'Tool call' : block.type === 'thinking' ? 'Reasoning' : block.type === 'text' ? 'Assistant' : text(block.type) || 'Unknown block',
        text: block.type === 'text' ? text(block.text) : block.type === 'thinking' ? text(block.thinking) :
          tool ? block.partialInput ?? json(block.input) : json(block),
        state: response.state, raw: {message: response.message, block, frames: response.frames}, source: 'live'});
    }
  };
  const mergeUsage = (id: string, value: any) => {
    const before = responseUsage.get(id) ?? {};
    for (const [key, amount] of Object.entries(obj(value))) if (number(amount) !== undefined)
      before[key] = Math.max(before[key] ?? 0, amount as number);
    responseUsage.set(id, before);
  };
  for (const record of records) {
    const message = obj(record.message);
    if (localUser(record)) {
      currentCommand = message.id;
      const key = 'local:' + (message.id || record.seq);
      rows.set(key, userRow(key, text(message.text), message));pending.push({key, text: text(message.text), consumed: false});continue;
    }
    if (record.direction === 'out' || message.type === 'local/interrupt') continue;
    if (message.type === 'stream_event') {
      const event = obj(message.event);
      const actor = text(message.parent_tool_use_id) || 'root';
      if (event.type === 'message_start') {
        const activeResponse = text(event.message?.id) || 'stream-' + record.seq;
        activeResponses.set(actor,activeResponse);
        responses.set(activeResponse, {id: activeResponse, message: event.message, blocks: new Map(), frames: [message], state: 'streaming'});
        mergeUsage(activeResponse, event.message?.usage);
      } else {
        const response = responses.get(activeResponses.get(actor) ?? '');
        if (!response) continue;
        response.frames.push(message);
        if (event.type === 'content_block_start') response.blocks.set(event.index, {...event.content_block});
        if (event.type === 'content_block_delta') {
          const block = {...response.blocks.get(event.index)}, delta = obj(event.delta);
          if (delta.type === 'text_delta') {block.type ??= 'text';block.text = text(block.text) + text(delta.text);}
          else if (delta.type === 'thinking_delta') {block.type ??= 'thinking';block.thinking = text(block.thinking) + text(delta.thinking);}
          else if (delta.type === 'input_json_delta') block.partialInput = text(block.partialInput) + text(delta.partial_json);
          response.blocks.set(event.index, block);
        }
        if (event.type === 'message_delta') {mergeUsage(response.id, event.usage);if (event.delta?.stop_reason) response.state = event.delta.stop_reason;}
        if (event.type === 'message_stop' && response.state === 'streaming') response.state = 'response ended';
        render(response);
      }
      continue;
    }
    if (message.type === 'assistant') {
      const native = obj(message.message), id = text(native.id) || text(message.uuid) || 'message-' + record.seq;
      let response = responses.get(id);
      const streamed = !!response;
      if (!response) response = {id, message: native, blocks: new Map(), frames: [], state: 'reported'};
      response.message = native;response.frames.push(message);response.state = message.error ? 'error' : text(native.stop_reason) || 'reported';
      for (const [index, block] of list(native.content).entries()) {
        const match = [...response.blocks].find(([, existing]) => block.id ? existing.id === block.id :
          existing.type === block.type && (contentText([existing]) === contentText([block]) ||
            contentText([block]).startsWith(contentText([existing]))));
        const target = match?.[0] ?? (streamed ? Math.max(-1, ...response.blocks.keys()) + 1 : index);
        response.blocks.set(target, {...block});
      }
      responses.set(id, response);mergeUsage(id, native.usage);render(response);continue;
    }
    if (message.type === 'user') {
      const native = obj(message.message), content = native.content ?? message.content;
      const value = contentText(content), uuid = text(message.uuid);
      const containsToolResult = list(content).some(b => b.type === 'tool_result');
      if (!containsToolResult) {
        const echo = pending.find(p => !p.consumed && (p.key === 'local:' + uuid || p.text === value));
        if (echo) {echo.consumed = true;rows.set(echo.key, {...userRow(echo.key,value,message),nativeId:uuid || undefined,state:'reported'});continue;}
      }
      const key = uuid || 'user-' + record.seq;
      for (const [index, block] of (typeof content === 'string' ? [{type:'text',text:content}] : list(content)).entries()) {
        const tool = block.type === 'tool_result', id = 'claude-user:' + key + ':' + index;
        rows.set(id, {id,nativeId:text(block.tool_use_id)||uuid||undefined,role:tool?'tool':'user',kind:tool?'tool':block.type==='text'?'message':'unknown',
          title:tool?(block.is_error?'Tool error':'Tool result'):'You',text:tool?contentText(block.content):contentText([block]),
          state:tool?(block.is_error?'error':'returned'):'reported',raw:message,source:'live'});
      }
      continue;
    }
    if (message.type === 'result') {
      const key = text(message.uuid) || 'result-' + record.seq;
      if (!resultSeen.has(key)) {resultSeen.add(key);resultUsage.push(message.usage);}
      if (number(message.total_cost_usd) !== undefined) cost = Math.max(cost ?? 0,message.total_cost_usd);
      for (const [model, value] of Object.entries(obj(message.modelUsage))) {
        const cumulative = {...modelUsage.get(model)};
        for (const [field, amount] of Object.entries(obj(value))) if (number(amount)!==undefined)
          cumulative[field] = Math.max(cumulative[field]??0,amount as number);
        modelUsage.set(model,cumulative);
      }
      if (message.is_error) {
        const interrupted = currentCommand && requestedCancellations.has(currentCommand);
        rows.set(key,{id:key,role:'system',kind:'unknown',title:interrupted?'Submitted command interrupted':'Model request failed',
          text:interrupted?'Native cancellation followed the explicit interrupt request. Error details remain in the source record.':list(message.errors).join('\n')||text(message.result)||text(message.subtype),
          state:interrupted?'cancelled':'error',raw:message,source:'live'});
      }
      continue;
    }
    if (message.type === 'system' && ['init','status','task_started','task_progress','task_notification'].includes(message.subtype)) continue;
    if (message.type === 'tool_progress' || message.type === 'tool_use_summary' || message.type === 'rate_limit_event') continue;
    const key = 'unknown:' + record.seq;
    rows.set(key,{id:key,role:'system',kind:'unknown',title:text(message.type)||'Unknown SDK message',text:json(message),raw:message,source:'live'});
  }
  const measured = modelUsage.size ? [...modelUsage.values()] : resultUsage.length ? resultUsage : [...responseUsage.values()];
  const sum = (key: string): number | undefined => {
    const values = measured.map(v=>number(v?.[key])).filter((v):v is number=>v!==undefined);
    return values.length ? values.reduce((a,b)=>a+b,0) : undefined;
  };
  const cumulative = modelUsage.size>0;
  return {items:[...rows.values()],usage:{input:sum(cumulative?'inputTokens':'input_tokens'),cached:sum(cumulative?'cacheReadInputTokens':'cache_read_input_tokens'),
    inputBasis:sum(cumulative?'inputTokens':'input_tokens')===undefined?undefined:'uncached',
    cacheCreated:sum(cumulative?'cacheCreationInputTokens':'cache_creation_input_tokens'),output:sum(cumulative?'outputTokens':'output_tokens'),costUsd:cost,
    contextWindow:modelUsage.size===1?number([...modelUsage.values()][0]?.contextWindow):undefined,
    basis:cumulative?'Last cumulative SDK model usage/cost, counted once per model. Context occupancy is not inferred.':
      resultUsage.length?'Per-result usage deduplicated by result UUID; cumulative cost counted once. Context occupancy unknown.':'Partial native response usage, deduplicated by response ID; context and final cost unknown.'},
    notes:['Claude response stop reason is not a Codex final/commentary phase or proof that the SDK query has ended.',
      'Streamed blocks are replaced by their assistant records; tool-use and tool-result remain separate records.',
      'Claude input, cache read and cache creation are separate quantities. A reported context-window capacity is not occupancy.']};
}

export function projectLive(provider: Provider, records: WireRecord[]): Projection {
  return provider === 'codex' ? projectCodex(records) : projectClaude(records);
}

export function compareProjections(live: Projection, history: Projection) {
  const summary = (p: Projection) => ({items:p.items.length,messages:p.items.filter(i=>i.kind==='message').length,
    tools:p.items.filter(i=>i.kind==='tool').length,reasoning:p.items.filter(i=>i.kind==='reasoning').length,
    unknown:p.items.filter(i=>i.kind==='unknown').length,usage:p.usage});
  const a = new Set(live.items.flatMap(i=>i.nativeId?[i.nativeId]:[]));
  const b = new Set(history.items.flatMap(i=>i.nativeId?[i.nativeId]:[]));
  return {live:summary(live),history:summary(history),sharedNativeIds:[...a].filter(id=>b.has(id)).length,
    onlyLiveNativeIds:[...a].filter(id=>!b.has(id)).length,onlyHistoryNativeIds:[...b].filter(id=>!a.has(id)).length,
    measurementRows:(['input','cached','cacheCreated','output','context','contextWindow','costUsd'] as const).map(name=>({name,live:live.usage[name]??null,history:history.usage[name]??null})),
    notes:['Counts describe rendered blocks, not billed requests. Different provider projections can split or combine blocks.',
      'Native ID overlap is diagnostic, not proof of complete/equal transcripts; response IDs and wrapper UUIDs have different scopes.',
      'Missing history measurements are not zero, and stream receipt time is not historical event time.']};
}
