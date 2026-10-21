import type { Item, SavedThread } from '../runtime.ts';
import { executeToolBatch, repairInterruptedCalls } from '../tools/execute.ts';
import { snapshotTools } from '../tools/parallel.ts';
import type { ActiveTurn, SessionServices, ToolCall } from './state.ts';

async function prepareRequest(services: SessionServices, active: ActiveTurn,
  args: Parameters<NonNullable<SessionServices['options']['beforeModel']>>[0]): Promise<void> {
  const prepare = services.options.beforeModel; if (!prepare) return;
  const signal = active.controller.signal;
  let aborted = false; let invocationStarted = false;
  const work = Promise.resolve().then(() => {
    signal.throwIfAborted(); invocationStarted = true; return prepare(structuredClone(args));
  });
  void work.then(() => {
    if (aborted && invocationStarted) services.record('lateRequestPreparation', { threadId: args.threadId, turnId: args.turnId, status: 'resolved-after-interrupt', dispatched: false });
  }, (error) => {
    if (aborted && invocationStarted) services.record('lateRequestPreparation', { threadId: args.threadId, turnId: args.turnId, status: 'rejected-after-interrupt', error: String(error), dispatched: false });
  });
  let onAbort!: () => void;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => { aborted = true; reject(signal.reason ?? new Error('Request preparation interrupted')); };
    signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
  });
  try { await Promise.race([work, cancellation]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** One session's sampling/tool continuation loop; platform tools and provider transport are injected. */
export async function executeTurn(services: SessionServices, saved: SavedThread, active: ActiveTurn, started: number): Promise<void> {
  const { thread } = saved; const { turn, controller } = active;
  try {
    for (;;) {
      controller.signal.throwIfAborted(); active.phase = 'preparing'; services.drain(saved, active);
      const stepTools = snapshotTools(services.tools);
      const args = { threadId: thread.id, turnId: turn.id, input: structuredClone(saved.context), instructions: services.options.instructions ?? 'You are a helpful agent.', tools: [...stepTools.values()].map((tool) => structuredClone(tool.definition)), model: thread.model };
      await prepareRequest(services, active, args); controller.signal.throwIfAborted();
      services.record('modelRequest', args); active.ready = false; active.phase = 'opening';
      const run = services.options.connector.run({ ...args, signal: controller.signal }); active.run = run;
      const calls: ToolCall[] = []; const messages = new Map<string, Item>(); let completedResponse = false;
      const message = (id: string): Item => {
        let item = messages.get(id);
        if (!item) {
          item = { id, type: 'agentMessage', text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
          messages.set(id, item); turn.items.push(item);
          services.emit('item/started', { threadId: thread.id, turnId: turn.id, item, startedAtMs: Date.now() });
        }
        return item;
      };
      for await (const event of run.events) {
        controller.signal.throwIfAborted(); services.record('modelEvent', { threadId: thread.id, turnId: turn.id, event });
        if (event.type === 'textDelta') {
          const item = message(event.itemId); item.text = String(item.text) + event.delta;
          services.emit('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: event.delta });
        } else if (event.type === 'outputItem' || event.type === 'inputItem') {
          if (event.type === 'inputItem') {
            saved.context.splice(event.index ?? saved.context.length, 0, structuredClone(event.item));
            services.inputCommitted(active, event.item, event.receiptId);
          } else {
            saved.context.push(structuredClone(event.item));
            if (event.item.type === 'function_call' || event.item.type === 'custom_tool_call') {
              const call: ToolCall = { type: 'toolCall', id: String(event.item.call_id), name: String(event.item.name), arguments: String(event.item.arguments ?? event.item.input ?? ''), kind: event.item.type === 'function_call' ? 'function' : 'custom' };
              active.calls.set(call.id, { call, status: 'pending' });
            }
            if (event.item.type === 'message' && event.item.role === 'assistant' && Array.isArray(event.item.content)) {
              const text = event.item.content.filter((part) => part.type === 'output_text').map((part) => String(part.text)).join('');
              const id = typeof event.item.id === 'string' ? event.item.id : [...messages.keys()].at(-1) ?? crypto.randomUUID();
              const item = message(id); item.text = text; item.phase = event.item.phase ?? null;
              if (text.trim() && (event.item.phase == null || event.item.phase === 'final_answer')) services.answerBoundary(saved, active);
            }
          }
        } else if (event.type === 'toolCall') {
          if (!active.calls.has(event.id)) active.calls.set(event.id, { call: event, status: 'pending' });
          calls.push(event);
        } else if (event.type === 'completed') { completedResponse = true; services.inclusionCommitted(active); }
        else if (event.type === 'usage') services.usage(thread.id, turn.id, event);
        else if (event.type === 'steering') { services.steeringEvent(active, event); services.emit('hp/model/steering', { threadId: thread.id, turnId: turn.id, ...event }); }
        else if (event.type === 'raw' && event.event.type === 'response.created' && !event.duplicate) {
          active.phase = 'model'; active.ready = true; services.inclusionCommitted(active); await services.ready(saved, active);
          services.emit('hp/model/started', { threadId: thread.id, turnId: turn.id, response: event.event.response });
        }
      }
      delete active.run; active.ready = false;
      if (!completedResponse) throw new Error('Model stream ended without a completed response');
      for (const item of messages.values()) services.emit('item/completed', { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() });
      await executeToolBatch(services, saved, active, calls, stepTools);
      if (calls.length) active.mailboxMode = 'current'; // Native model/tool continuation reopens delivery.
      services.checkpoint(saved);
      if (!calls.length && !services.hasPending(thread.id, active)) break;
    }
    controller.signal.throwIfAborted(); turn.status = 'completed';
  } catch (error) {
    turn.status = controller.signal.aborted ? 'interrupted' : 'failed';
    turn.error = { message: String(error), codexErrorInfo: null, additionalDetails: null, misalignment: null };
    repairInterruptedCalls(services, saved, active);
  } finally {
    active.phase = 'finishing'; delete active.run; active.ready = false;
    if (turn.status === 'interrupted' || turn.status === 'failed' || active.input.records.some((input) => input.state === 'queued' || input.state === 'sent')) {
      const receipts = services.options.connector.discardThread?.(thread.id);
      if (receipts?.length) services.record('steeringDiscarded', { threadId: thread.id, turnId: turn.id, receipts });
    }
    services.inclusionFailed(saved, active);
    for (const input of active.input.abandon()) services.emit('hp/input/outcome', { ...input });
    services.finish(saved, active, started);
  }
}
