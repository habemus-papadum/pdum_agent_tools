import type { Item, SavedThread, Tool } from '../runtime.ts';
import type { ActiveTurn, CallState, SessionServices, ToolCall } from '../session/state.ts';
import { ParallelToolGate } from './parallel.ts';

function makeItem(call: ToolCall): Item {
  let args: unknown = call.arguments;
  if (call.kind === 'function') { try { args = JSON.parse(call.arguments); } catch { /* reported by tool */ } }
  return { type: 'dynamicToolCall', id: call.id, namespace: null, tool: call.name, arguments: args,
    status: 'inProgress', contentItems: null, success: null, durationMs: null };
}
function appendOutput(saved: SavedThread, state: CallState, output: string): void {
  saved.context.push({ type: state.call.kind === 'custom' ? 'custom_tool_call_output' : 'function_call_output', call_id: state.call.id, output });
}
function finish(services: SessionServices, saved: SavedThread, active: ActiveTurn, state: CallState, output: string, success: boolean, started: number) {
  const item = state.item!; item.success = success; item.status = success ? 'completed' : 'failed';
  item.contentItems = [{ type: 'inputText', text: output }]; item.durationMs = Date.now() - started;
  services.emit('item/completed', { threadId: saved.thread.id, turnId: active.turn.id, item, completedAtMs: Date.now() });
}
export async function executeToolBatch(services: SessionServices, saved: SavedThread, active: ActiveTurn, calls: ToolCall[], tools: ReadonlyMap<string, Tool>): Promise<void> {
  active.phase = 'tools';
  const gate = new ParallelToolGate();
  // Native Codex gates parallel-eligible handlers with a shared lock and others exclusively.
  // Settle every wrapper before returning; an interrupted callback may continue only as a late outcome.
  const results = await Promise.allSettled(calls.map(async (call) => {
    const tool = tools.get(call.name);
    const release = await gate.acquire(tool?.supportsParallel === true, active.controller.signal);
    try {
      active.controller.signal.throwIfAborted();
      const state = active.calls.get(call.id)!; state.item = makeItem(call);
      active.turn.items.push(state.item); const started = Date.now();
      services.emit('item/started', { threadId: saved.thread.id, turnId: active.turn.id, item: state.item, startedAtMs: started });
      let aborted = false;
      const work = Promise.resolve().then(() => {
        if (!tool) throw new Error(`Unknown tool ${call.name}`);
        active.controller.signal.throwIfAborted();
        state.executionStarted = true; state.status = 'running';
        return tool.execute(call.arguments, { runtime: services.owner, threadId: saved.thread.id, turnId: active.turn.id, signal: active.controller.signal });
      });
      void work.then((output) => {
        if (aborted && state.executionStarted) {
          const outcome = { threadId: saved.thread.id, turnId: active.turn.id, callId: call.id, status: 'completed-after-interrupt', output };
          services.record('lateToolOutcome', outcome); services.emit('hp/tool/lateOutcome', outcome);
        }
      }, (error) => {
        if (aborted && state.executionStarted) {
          const outcome = { threadId: saved.thread.id, turnId: active.turn.id, callId: call.id, status: 'failed-after-interrupt', error: String(error) };
          services.record('lateToolOutcome', outcome); services.emit('hp/tool/lateOutcome', outcome);
        }
      });
      let onAbort!: () => void;
      const cancellation = new Promise<never>((_, reject) => {
        onAbort = () => { aborted = true; reject(active.controller.signal.reason); };
        active.controller.signal.addEventListener('abort', onAbort, { once: true });
        if (active.controller.signal.aborted) onAbort();
      });
      try {
        const output = await Promise.race([work, cancellation]);
        active.controller.signal.throwIfAborted();
        state.status = 'completed'; finish(services, saved, active, state, output, true, started);
        return output;
      } catch (error) {
        if (active.controller.signal.aborted) { state.status = 'interrupted'; throw error; }
        const output = String(error);
        state.status = 'completed'; finish(services, saved, active, state, output, false, started);
        return output;
      } finally { active.controller.signal.removeEventListener('abort', onAbort); }
    } finally { release(); }
  }));
  // Completion notifications are prompt; model input remains in model-call order, including
  // successful siblings of an interrupted call. The turn's repair closes only missing pairs.
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const state = active.calls.get(calls[index]!.id)!;
    if (result.status === 'fulfilled') appendOutput(saved, state, result.value);
    else repairCall(services, saved, active, state);
  }
  active.controller.signal.throwIfAborted();
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

function repairCall(services: SessionServices, saved: SavedThread, active: ActiveTurn, state: CallState): void {
  const neverStarted = !state.executionStarted;
  const output = neverStarted ? 'NOT EXECUTED: turn ended before this tool started. No action was performed by this call.'
    : 'INTERRUPTED / OUTCOME UNKNOWN: tool execution started. Side effects may have occurred. Do not replay automatically; inspect application state first.';
  if (!state.item) {
    state.item = makeItem(state.call); active.turn.items.push(state.item);
    services.emit('item/started', { threadId: saved.thread.id, turnId: active.turn.id, item: state.item, startedAtMs: Date.now() });
  }
  state.status = 'interrupted'; appendOutput(saved, state, output); finish(services, saved, active, state, output, false, Date.now());
  services.record('toolContextRepair', { threadId: saved.thread.id, turnId: active.turn.id, callId: state.call.id, outcome: neverStarted ? 'not-executed' : 'unknown' });
}

/** Close recorded call/output pairs without executing a missing action or claiming it had no side effects. */
export function repairInterruptedCalls(services: SessionServices, saved: SavedThread, active: ActiveTurn): void {
  const outputs = new Set(saved.context.filter((item) => item.type === 'function_call_output' || item.type === 'custom_tool_call_output').map((item) => item.call_id));
  for (const state of active.calls.values()) {
    if (outputs.has(state.call.id)) continue;
    repairCall(services, saved, active, state);
  }
}
