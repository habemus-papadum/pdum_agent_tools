import type { ModelConnector, ModelEvent, ModelRun, ModelRunArgs, ModelRunStatus, NativeItem, ResponsesConnection, ResponsesConnectionFactory, SteeringReceipt } from './connector.js';

type ThreadConnection = {
  connection: ResponsesConnection;
  iterator: AsyncIterator<NativeItem>;
  knownInput: NativeItem[];
  previousId?: string;
  activeResponseId?: string;
  receipts: SteeringReceipt[];
  createdIds: Set<string>;
  terminalIds: Map<string, string>;
  steeringEvents: Set<string>;
  finalItems: Map<string, string>;
};
const record = (value: unknown): NativeItem => value && typeof value === 'object' ? value as NativeItem : {};
const pending = (receipt: SteeringReceipt) => ['sent', 'accepted', 'pending'].includes(receipt.state);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  return item;
});
const itemKey = (item: NativeItem): string | undefined => typeof item.id === 'string' ? `id:${item.id}`
  : typeof item.call_id === 'string' ? `${String(item.type)}:${item.call_id}` : undefined;
const isTool = (item: NativeItem) => item.type === 'function_call' || item.type === 'custom_tool_call';
const isFinal = (item: NativeItem) => item.status !== 'in_progress' && item.status !== 'incomplete';

/** Small portable model-round adapter. Runtime owns tool execution, repair and history. */
export class DirectResponsesConnector implements ModelConnector {
  private readonly threads = new Map<string, ThreadConnection>();
  private readonly activeRuns = new Map<string, AbortController>();
  private closed = false;
  constructor(private readonly factory: ResponsesConnectionFactory, private readonly requestOptions: NativeItem = {}) {}

  private async openConnection(signal: AbortSignal): Promise<ResponsesConnection> {
    signal.throwIfAborted();
    const opening = Promise.resolve().then(() => this.factory(signal));
    // A host factory can finish after cancellation. Retire that eventual socket
    // without delaying the interrupted run or stealing a subsequent run's socket.
    void opening.then((connection) => { if (signal.aborted || this.closed) connection.close(); }, () => {});
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await Promise.race([opening, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  /** A local abort is not proof that previously dispatched steering was rejected. */
  discardThread(threadId: string): readonly SteeringReceipt[] {
    this.activeRuns.get(threadId)?.abort(new Error('Thread connection discarded'));
    const state = this.threads.get(threadId);
    if (!state) return [];
    for (const receipt of state.receipts) if (pending(receipt)) receipt.state = 'unknown';
    state.connection.close();
    this.threads.delete(threadId);
    return structuredClone(state.receipts);
  }

  run(args: ModelRunArgs): ModelRun {
    const connector = this;
    let current: ThreadConnection | undefined;
    let responseId: string | undefined;
    let status: ModelRunStatus = 'opening';
    return {
      get status() { return status; },
      get steeringReceipts() { return structuredClone(current?.receipts ?? []); },
      async steer(input) {
        if (typeof input !== 'string' || input.length === 0) throw new Error('Steering input must be nonempty');
        if (status !== 'running' || !current || !responseId || args.signal.aborted || connector.closed || connector.threads.get(args.threadId) !== current || connector.activeRuns.get(args.threadId)?.signal.aborted) throw new Error('No active response is available to steer');
        const receipt: SteeringReceipt = { receiptId: crypto.randomUUID(), input, responseId, state: 'sent' };
        current.receipts.push(receipt);
        try { current.connection.send({ type: 'response.steer', previous_response_id: responseId, input }); }
        catch (error) {
          receipt.state = 'unknown';
          connector.discardThread(args.threadId);
          throw Object.assign(new Error('Steering dispatch failed; commitment outcome unknown', { cause: error }), { receipt: structuredClone(receipt) });
        }
        return structuredClone(receipt);
      },
      events: (async function* (): AsyncGenerator<ModelEvent> {
        if (args.signal.aborted) { status = 'failed'; args.signal.throwIfAborted(); }
        if (connector.closed) { status = 'failed'; throw new Error('Responses connector is closed'); }
        if (connector.activeRuns.has(args.threadId)) { status = 'failed'; throw new Error('One active model round per thread; children use separate thread IDs'); }
        const controller = new AbortController();
        connector.activeRuns.set(args.threadId, controller);
        const signal = AbortSignal.any([args.signal, controller.signal]);
        let completedRound = false;
        let terminalSeen = false;
        let hasTools = false;
        let terminalFailure: Error | undefined;
        let removeAbort = () => {};
        try {
          current = connector.threads.get(args.threadId);
          if (current && canonical(args.input.slice(0, current.knownInput.length)) !== canonical(current.knownInput)) {
            if (current.receipts.some(pending)) throw new Error('Cannot replace context while steering outcome remains pending');
            current.connection.close(); connector.threads.delete(args.threadId); current = undefined;
          }
          if (!current) {
            const connection = await connector.openConnection(signal);
            if (signal.aborted || connector.closed) { connection.close(); signal.throwIfAborted(); throw new Error('Responses connector is closed'); }
            current = { connection, iterator: connection.events[Symbol.asyncIterator](), knownInput: [], receipts: [], createdIds: new Set(), terminalIds: new Map(), steeringEvents: new Set(), finalItems: new Map() };
            connector.threads.set(args.threadId, current);
          }
          const state = current;
          const onAbort = () => state.connection.close();
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbort = () => signal.removeEventListener('abort', onAbort);
          signal.throwIfAborted();
          // Accepted steering is prepended by the provider to this explicit tail.
          // Its canonical placement is at the old prefix boundary, not at the end.
          let creation = { parentId: state.previousId, insertionIndex: state.knownInput.length };
          const input = args.input.slice(state.knownInput.length);
          state.knownInput = structuredClone(args.input);
          function* finalItem(item: NativeItem): Generator<ModelEvent> {
            if (!isFinal(item)) return;
            const key = itemKey(item);
            if (key && state.finalItems.has(key)) {
              if (state.finalItems.get(key) !== canonical(item)) throw new Error(`Conflicting final item ${key}`);
              return;
            }
            if (key) state.finalItems.set(key, canonical(item));
            state.knownInput.push(structuredClone(item));
            yield { type: 'outputItem', item };
            if (isTool(item)) {
              hasTools = true;
              yield { type: 'toolCall', id: String(item.call_id), name: String(item.name), arguments: String(item.arguments ?? item.input ?? ''), kind: item.type === 'function_call' ? 'function' : 'custom' };
            }
          }
          state.connection.send({ include: ['reasoning.encrypted_content'], ...connector.requestOptions, type: 'response.create', model: args.model, instructions: args.instructions, tools: args.tools, input, ...(state.previousId ? { previous_response_id: state.previousId } : {}), store: false });
          for (;;) {
            const next = await state.iterator.next();
            signal.throwIfAborted();
            if (next.done) throw new Error('Connection ended before a complete model round');
            const event = next.value;
            const eventType = String(event.type);
            const response = record(event.response);
            const terminal = ['response.completed', 'response.incomplete', 'response.failed'].includes(eventType);
            const id = typeof response.id === 'string' ? response.id : undefined;
            const createdDuplicate = eventType === 'response.created' && !!id && state.createdIds.has(id);
            const priorTerminal = terminal && !!id && state.terminalIds.has(id);
            const terminalDuplicate = priorTerminal && state.terminalIds.get(id!) === canonical(response);
            const steerTarget = record(event.steer).previous_response_id;
            const steeringKey = eventType.startsWith('response.steer.') && typeof event.sequence_number === 'number' && typeof steerTarget === 'string'
              ? `${steerTarget}:${eventType}:${event.sequence_number}` : undefined;
            const steeringDuplicate = !!steeringKey && state.steeringEvents.has(steeringKey);
            const finalKey = eventType === 'response.output_item.done' ? itemKey(record(event.item)) : undefined;
            const itemDuplicate = !!finalKey && state.finalItems.get(finalKey) === canonical(record(event.item));
            // Publish readiness before the raw event: startup observers may send a steer.
            if (eventType === 'response.created' && !createdDuplicate) {
              if (!id) throw new Error('response.created omitted its response ID');
              responseId = id; state.activeResponseId = id; status = 'running';
            }
            if (terminal && !priorTerminal) {
              const terminalHasTools = hasTools || (Array.isArray(response.output) && response.output.some((item) => isTool(record(item)) && isFinal(record(item))));
              status = eventType === 'response.failed' ? 'failed' : terminalHasTools ? 'waitingForTools'
                : state.receipts.some(pending) ? 'waitingForSuccessor' : 'completed';
            }
            yield { type: 'raw', event, ...((createdDuplicate || terminalDuplicate || itemDuplicate || steeringDuplicate) ? { duplicate: true } : {}) };
            if (priorTerminal && !terminalDuplicate) throw new Error('Conflicting terminal response snapshot');
            if (createdDuplicate || terminalDuplicate || steeringDuplicate) continue;
            if (steeringKey) state.steeringEvents.add(steeringKey);
            if (eventType === 'error' || eventType === 'response.error') throw new Error(`Responses error: ${JSON.stringify(event.error ?? event)}`);
            if (eventType === 'response.created') {
              state.createdIds.add(id!); terminalSeen = false; terminalFailure = undefined; hasTools = false;
              const parentId = Object.hasOwn(response, 'previous_response_id') ? response.previous_response_id : creation.parentId;
              if (parentId != null && creation.parentId != null && parentId !== creation.parentId) throw new Error('Unexpected response parent; cannot place committed input');
              const committed = state.receipts.filter((receipt) => ['accepted', 'pending'].includes(receipt.state) && receipt.responseId === parentId);
              for (const [offset, receipt] of committed.entries()) {
                const item = { role: 'user', content: receipt.input };
                const index = creation.insertionIndex + offset;
                state.knownInput.splice(index, 0, item); receipt.state = 'committed';
                yield { type: 'inputItem', item, index, receiptId: receipt.receiptId };
                yield { type: 'steering', state: 'committed', responseId: id!, receiptId: receipt.receiptId, ...(receipt.steerId ? { steerId: receipt.steerId } : {}) };
              }
            }
            if (['response.steer.accepted', 'response.steer.pending', 'response.steer.failed'].includes(eventType)) {
              const detail = record(event.steer);
              const receipt = state.receipts.find((value) => typeof detail.id === 'string' && value.steerId === detail.id)
                ?? state.receipts.find((value) => value.state === 'sent' && value.responseId === detail.previous_response_id && (detail.input === undefined || detail.input === value.input));
              if (!receipt) throw new Error('Cannot correlate provider steering event with a dispatched receipt');
              const nextState = eventType.split('.').at(-1) as 'accepted' | 'pending' | 'failed';
              if (receipt.state === 'committed' || receipt.state === 'failed') {
                if (receipt.state === 'committed' && nextState === 'failed') throw new Error('Provider failed steering after observed commitment');
                continue;
              }
              if (typeof detail.id === 'string') receipt.steerId = detail.id;
              const repeated = receipt.state === nextState || (receipt.state === 'pending' && nextState === 'accepted');
              if (!repeated) {
                receipt.state = nextState;
                yield { type: 'steering', state: nextState, responseId: receipt.responseId, receiptId: receipt.receiptId, ...(receipt.steerId ? { steerId: receipt.steerId } : {}), detail: event };
              }
              if (terminalSeen && !state.receipts.some(pending)) {
                if (terminalFailure) throw terminalFailure;
                completedRound = true; status = hasTools ? 'waitingForTools' : 'completed';
                yield { type: 'completed', responseId: state.previousId! }; return;
              }
            }
            if (eventType === 'response.output_text.delta') yield { type: 'textDelta', itemId: String(event.item_id), delta: String(event.delta) };
            if (eventType === 'response.output_item.done') yield* finalItem(record(event.item));
            if (terminal) {
              if (!id) throw new Error('Terminal event omitted its response ID');
              state.terminalIds.set(id, canonical(response));
              if (state.activeResponseId && id !== state.activeResponseId) throw new Error('Terminal event belongs to a different active response');
              if (Array.isArray(response.output)) for (const item of response.output) yield* finalItem(record(item));
              state.previousId = id; terminalSeen = true;
              const usage = record(response.usage);
              if (typeof usage.input_tokens === 'number') {
                const details = record(usage.input_tokens_details), reasoning = record(usage.output_tokens_details).reasoning_tokens;
                yield { type: 'usage', responseId: id, model: String(response.model), inputTokens: usage.input_tokens, cachedInputTokens: Number(details.cached_tokens ?? 0), cacheWriteTokens: Number(details.cache_write_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0), ...(typeof reasoning === 'number' ? { reasoningOutputTokens: reasoning } : {}) };
              }
              if (eventType === 'response.failed') throw new Error(`Response failed: ${JSON.stringify(response.error)}`);
              if (eventType === 'response.incomplete' && record(response.incomplete_details).reason !== 'steered') {
                terminalFailure = new Error(`Response incomplete: ${JSON.stringify(response.incomplete_details)}`);
                if (!state.receipts.some(pending)) throw terminalFailure;
              }
              if (hasTools || (eventType === 'response.completed' && !state.receipts.some(pending))) {
                completedRound = true; status = hasTools ? 'waitingForTools' : 'completed';
                yield { type: 'completed', responseId: id }; return;
              }
              status = 'waitingForSuccessor';
              creation = { parentId: id, insertionIndex: state.knownInput.length };
            }
          }
        } catch (error) {
          status = 'failed';
          const unknown = current?.receipts.some(pending) ?? false;
          connector.discardThread(args.threadId);
          if (unknown) throw new Error('Connection ended with pending steering; commitment outcome unknown', { cause: error });
          throw error;
        } finally {
          removeAbort();
          if (!completedRound || signal.aborted) { status = 'failed'; connector.discardThread(args.threadId); }
          if (connector.activeRuns.get(args.threadId) === controller) connector.activeRuns.delete(args.threadId);
        }
      })(),
    };
  }

  close(): void {
    this.closed = true;
    for (const threadId of new Set([...this.threads.keys(), ...this.activeRuns.keys()])) this.discardThread(threadId);
  }
}
