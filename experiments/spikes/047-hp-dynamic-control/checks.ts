/** Portable, deterministic race checks. Imported unchanged by Node and the browser qualification. */
import { AgentRuntime, type Tool } from '../039-hp-agent-runtime/src/runtime.ts';
import { agentTools } from '../039-hp-agent-runtime/src/tools/agent-tools.ts';
import { browserConnectionFactory } from '../039-hp-agent-runtime/src/browser-connection.ts';
import type { ModelConnector, ModelEvent, ModelRunArgs, ModelRunStatus } from '../038-hp-sdk-fit/src/connector.ts';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Aborted')); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
const created = (): ModelEvent => ({ type: 'raw', event: { type: 'response.created', response: { id: crypto.randomUUID() } } });
const completed = (): ModelEvent => ({ type: 'completed', responseId: crypto.randomUUID() });
function answer(text: string, phase: string | null = 'final_answer'): ModelEvent {
  return { type: 'outputItem', item: { type: 'message', id: crypto.randomUUID(), role: 'assistant', phase, content: [{ type: 'output_text', text }] } };
}
function toolCall(name: string, args: unknown): ModelEvent[] {
  const id = crypto.randomUUID(); const argumentsText = JSON.stringify(args);
  return [{ type: 'outputItem', item: { type: 'function_call', call_id: id, name, arguments: argumentsText } }, { type: 'toolCall', id, name, arguments: argumentsText, kind: 'function' }];
}
interface Script { args: ModelRunArgs; step: number; steers: string[] }
function connector(script: (run: Script) => AsyncGenerator<ModelEvent>): ModelConnector & { calls: ModelRunArgs[]; discarded: string[] } {
  const counts = new Map<string, number>(); const calls: ModelRunArgs[] = []; const discarded: string[] = [];
  return { calls, discarded, discardThread(id) { discarded.push(id); return []; }, run(args) {
    const step = (counts.get(args.threadId) ?? 0) + 1; counts.set(args.threadId, step); calls.push(structuredClone({ ...args, signal: undefined }) as unknown as ModelRunArgs);
    const steers: string[] = []; let status: ModelRunStatus = 'opening';
    return { get status() { return status; }, steer: async (text) => { if (status !== 'running') throw new Error('Not running'); steers.push(text); },
      events: (async function* () { for await (const event of script({ args, step, steers })) {
        if (event.type === 'raw' && event.event.type === 'response.created') status = 'running';
        if (event.type === 'completed') status = 'completed'; yield event;
      } })() };
  } };
}
const simple = () => connector(async function* () { yield created(); yield answer('Done'); yield completed(); });
function onEvent(runtime: AgentRuntime, predicate: (method: string, params: Record<string, unknown>) => boolean): Promise<void> {
  return new Promise((resolve) => { const off = runtime.subscribe((event) => { if (predicate(event.method, event.params)) { off(); resolve(); } }); });
}
const waitBounds = { minMs: 0, maxMs: 1000, defaultMs: 20 };

export const controlChecks: Record<string, () => Promise<void>> = {
  async 'startup steer queues until the response exists'() {
    const opening = deferred(); const release = deferred(); const model = connector(async function* ({ args, steers }) {
      opening.resolve(); await abortable(release.promise, args.signal); yield created();
      for (const text of steers) yield { type: 'inputItem', item: { role: 'user', content: text } };
      yield answer('Started with queued input'); yield completed();
    });
    const runtime = new AgentRuntime({ connector: model }); const thread = runtime.create(); const turn = runtime.start(thread.id, 'Start');
    await opening.promise; await runtime.steer(thread.id, turn.id, 'STARTUP_NOTE');
    check(runtime.inspectInputs(thread.id)[0]?.state === 'queued', 'Opening input must remain queued');
    release.resolve(); await runtime.wait(thread.id);
    check(runtime.inspectInputs(thread.id)[0]?.state === 'committed', 'Provider input event commits steering');
    check(runtime.context(thread.id).filter((item) => item.content === 'STARTUP_NOTE').length === 1, 'Steer inserted exactly once');
  },
  async 'queue-only notes stay idle; followup starts and consumes them'() {
    const model = simple(); const runtime = new AgentRuntime({ connector: model, waitBounds });
    const root = runtime.create({ cwd: '/workspace' }); const child = runtime.create({ parentThreadId: root.id });
    runtime.sendMessage(root.id, child.id, 'QUEUED_NOTE');
    const wake = await runtime.waitAgent(child.id, { timeoutMs: 0 });
    check(wake.reason === 'mailbox' && model.calls.length === 0, 'Already queued note wakes wait without inference');
    check(runtime.read(child.id).turns.length === 0, 'send_message does not create a turn');
    runtime.followupTask(root.id, child.id, 'DO_TASK'); await runtime.wait(child.id);
    check(runtime.read(child.id).cwd === '/workspace', 'Child inherits cwd');
    check(JSON.stringify(model.calls[0]?.input).includes('QUEUED_NOTE'), 'Queued note reaches next model context');
    check(runtime.inspectInputs(child.id).every((input) => input.state === 'committed'), 'Delivered notes have outcomes');
    runtime.sendMessage(child.id, '/root', 'UPWARD_NOTE');
    check(runtime.read(root.id).turns.length === 0, 'Child can leave a note for idle root');
    let rejected = false; try { runtime.followupTask(child.id, '/root', 'wake root'); } catch { rejected = true; }
    check(rejected, 'Native-style followup cannot wake root');
  },
  async 'wait timeout clamp and abort are explicit'() {
    const runtime = new AgentRuntime({ connector: simple(), waitBounds: { minMs: 1, maxMs: 10, defaultMs: 2 } }); const thread = runtime.create();
    const timed = await runtime.waitAgent(thread.id, { timeoutMs: 0 }); check(timed.timed_out && timed.warning, 'Minimum clamp is visible');
    let rejected = false; try { await runtime.waitAgent(thread.id, { timeoutMs: 11 }); } catch { rejected = true; } check(rejected, 'Too-large wait errors');
    const abort = new AbortController(); const waiting = runtime.waitAgent(thread.id, { signal: abort.signal }); abort.abort(new Error('operator cancel'));
    let cancelled = false; try { await waiting; } catch { cancelled = true; } check(cancelled, 'Signal cancels wait');
  },
  async 'parent wait cancellation leaves child running and late completion queued'() {
    const childGate = deferred(); const model = connector(async function* ({ args, step }) {
      yield created();
      if (JSON.stringify(args.input[0]).includes('CHILD_HOLD')) { await abortable(childGate.promise, args.signal); yield answer('CHILD_RESULT'); }
      else if (step === 1) yield* toolCall('wait', { id: childId });
      else yield answer('Parent done');
      yield completed();
    });
    const runtime = new AgentRuntime({ connector: model, tools: agentTools, waitBounds }); const parent = runtime.create();
    const child = runtime.spawn(parent.id, 'CHILD_HOLD'); const childId = child.threadId;
    const waiting = onEvent(runtime, (method, params) => method === 'item/started' && (params.item as { tool?: string })?.tool === 'wait');
    const turn = runtime.start(parent.id, 'PARENT_WAIT'); await waiting; runtime.interrupt(parent.id, turn.id);
    check((await runtime.wait(parent.id))?.status === 'interrupted', 'Parent wait is cancellable');
    check(runtime.read(childId).turns.at(-1)?.status === 'inProgress', 'Parent interrupt does not kill child');
    childGate.resolve(); await runtime.wait(childId);
    check(runtime.read(parent.id).turns.length === 1, 'Late child completion does not start idle parent');
    check(runtime.inspectInputs(parent.id).some((input) => input.kind === 'completion' && input.state === 'queued'), 'Late result retained');
  },
  async 'steering wakes a waiting parent without cancelling its child'() {
    const childGate = deferred(); let childId = '';
    const model = connector(async function* ({ args, step }) {
      yield created();
      if (JSON.stringify(args.input[0]).includes('CHILD_HOLD')) { await abortable(childGate.promise, args.signal); yield answer('Child done'); }
      else if (step === 1) yield* toolCall('wait', { id: childId });
      else { check(JSON.stringify(args.input).includes('CHANGE_PLAN'), 'Steering delivered after wait result'); yield answer('Changed plan'); }
      yield completed();
    });
    const runtime = new AgentRuntime({ connector: model, tools: agentTools, waitBounds }); const parent = runtime.create();
    childId = runtime.spawn(parent.id, 'CHILD_HOLD').threadId;
    const waiting = onEvent(runtime, (method, params) => method === 'item/started' && (params.item as { tool?: string })?.tool === 'wait');
    const turn = runtime.start(parent.id, 'PARENT_WAIT'); await waiting; await runtime.steer(parent.id, turn.id, 'CHANGE_PLAN');
    check((await runtime.wait(parent.id))?.status === 'completed', 'Parent continues after steer wake');
    check(runtime.read(childId).turns.at(-1)?.status === 'inProgress', 'Child is independent');
    childGate.resolve(); await runtime.wait(childId);
  },
  async 'explicit subtree interrupt differs from thread-only interruption'() {
    const never = deferred(); const model = connector(async function* ({ args }) { yield created(); await abortable(never.promise, args.signal); yield completed(); });
    const runtime = new AgentRuntime({ connector: model }); const root = runtime.create(); const first = runtime.start(root.id, 'Root');
    const child = runtime.spawn(root.id, 'Child'); const grandchild = runtime.spawn(child.threadId, 'Grandchild');
    runtime.interrupt(root.id, first.id); await runtime.wait(root.id);
    check(runtime.read(child.threadId).turns.at(-1)?.status === 'inProgress', 'Default affects only named thread');
    const second = runtime.start(root.id, 'Root again'); const request = runtime.interrupt(root.id, second.id, { scope: 'subtree' });
    check(request.affected.length === 3, 'Explicit subtree names all descendants');
    const turns = await Promise.all([runtime.wait(root.id), runtime.wait(child.threadId), runtime.wait(grandchild.threadId)]);
    check(turns.every((turn) => turn?.status === 'interrupted'), 'All selected descendants interrupted');
  },
  async 'interrupted tool batch repairs context and reports late side effects'() {
    const started = deferred(); const finish = deferred<string>(); let skipped = 0;
    const tools: Tool[] = [
      { definition: { type: 'function', name: 'slow' }, async execute() { started.resolve(); return finish.promise; } },
      { definition: { type: 'function', name: 'skipped' }, async execute() { skipped++; return 'BAD'; } },
    ];
    const model = connector(async function* ({ step }) { yield created(); if (step === 1) { yield* toolCall('slow', {}); yield* toolCall('skipped', {}); } else yield answer('After interruption'); yield completed(); });
    const runtime = new AgentRuntime({ connector: model, tools }); const thread = runtime.create(); const turn = runtime.start(thread.id, 'Run tools');
    await started.promise; runtime.interrupt(thread.id, turn.id); await runtime.wait(thread.id);
    const outputs = runtime.context(thread.id).filter((item) => item.type === 'function_call_output');
    check(outputs.length === 2 && String(outputs[0]?.output).includes('OUTCOME UNKNOWN') && String(outputs[1]?.output).includes('NOT EXECUTED'), 'Interrupted and never-started outcomes differ');
    check(skipped === 0 && model.discarded.includes(thread.id), 'No skipped side effect; connector state discarded');
    finish.resolve('LATE_SIDE_EFFECT_RESULT'); await finish.promise; await Promise.resolve(); await Promise.resolve();
    check(runtime.journal.some((entry) => entry.kind === 'lateToolOutcome'), 'Late outcome visible in journal');
    runtime.start(thread.id, 'Continue safely'); await runtime.wait(thread.id);
    check(skipped === 0 && runtime.context(thread.id).filter((item) => item.type === 'function_call_output').length === 2, 'No tool auto-replay or duplicate output');
  },
  async 'mailbox injection waits for the complete tool batch'() {
    const entered = deferred(); const release = deferred(); let secondRan = false;
    const tools: Tool[] = [
      { definition: { type: 'function', name: 'first' }, async execute() { entered.resolve(); await release.promise; return 'FIRST_RESULT'; } },
      { definition: { type: 'function', name: 'second' }, async execute() { secondRan = true; return 'SECOND_RESULT'; } },
    ];
    const model = connector(async function* ({ args, step }) { yield created(); if (step === 1) { yield* toolCall('first', {}); yield* toolCall('second', {}); } else {
      const text = JSON.stringify(args.input); check(secondRan && text.indexOf('SECOND_RESULT') < text.indexOf('MID_BATCH_NOTE'), 'Both selected outputs precede queued input'); yield answer('Done');
    } yield completed(); });
    const runtime = new AgentRuntime({ connector: model, tools }); const root = runtime.create(); const child = runtime.spawn(root.id, 'Do work');
    await entered.promise; runtime.followupTask(root.id, child.threadId, 'MID_BATCH_NOTE'); release.resolve();
    check((await runtime.wait(child.threadId))?.status === 'completed', 'Child consumed queued followup');
  },
  async 'final-answer boundary defers later followup to a new turn'() {
    const atAnswer = deferred(); const release = deferred();
    const model = connector(async function* ({ args, step }) { yield created(); yield answer(step === 1 ? 'First answer' : 'Followup answer');
      if (step === 1) { atAnswer.resolve(); await abortable(release.promise, args.signal); } yield completed();
    });
    const runtime = new AgentRuntime({ connector: model }); const root = runtime.create(); const child = runtime.spawn(root.id, 'First task');
    await atAnswer.promise; runtime.followupTask(root.id, child.threadId, 'AFTER_ANSWER'); release.resolve(); await runtime.wait(child.threadId);
    await Promise.resolve(); await runtime.wait(child.threadId);
    check(runtime.read(child.threadId).turns.length === 2, 'Trigger after final answer starts another turn');
    check(runtime.inspectInputs(child.threadId).find((input) => input.text === 'AFTER_ANSWER')?.turnId !== child.turnId, 'Delivery belongs to new turn');
  },
  async 'failed preparation removes included-but-unconfirmed input'() {
    let requests = 0; const runtime = new AgentRuntime({ connector: simple(), beforeModel() { if (++requests === 1) throw new Error('prepare failed'); } });
    const thread = runtime.create(); const turn = runtime.start(thread.id, 'Original'); await runtime.steer(thread.id, turn.id, 'UNCONFIRMED_NOTE');
    check((await runtime.wait(thread.id))?.status === 'failed', 'Preparation failed honestly');
    check(runtime.inspectInputs(thread.id)[0]?.state === 'uncommitted', 'Input was never provider-committed');
    check(!JSON.stringify(runtime.context(thread.id)).includes('UNCONFIRMED_NOTE'), 'Unconfirmed local inclusion removed');
    runtime.start(thread.id, 'Fresh task'); await runtime.wait(thread.id);
    check(!JSON.stringify(runtime.context(thread.id)).includes('UNCONFIRMED_NOTE'), 'No next-turn silent replay');
  },
  async 'explicit work before the answer boundary stays in-turn; queue-only notes defer'() {
    for (const trigger of [true, false]) {
      const ready = deferred(); const release = deferred();
      const model = connector(async function* ({ args, step }) {
        yield created(); if (step === 1) { ready.resolve(); await abortable(release.promise, args.signal); }
        yield answer('Visible answer', null); yield completed();
      });
      const runtime = new AgentRuntime({ connector: model }); const root = runtime.create(); const child = runtime.spawn(root.id, 'First task');
      await ready.promise;
      if (trigger) runtime.followupTask(root.id, child.threadId, 'BEFORE_ANSWER');
      else runtime.sendMessage(root.id, child.threadId, 'BEFORE_ANSWER');
      release.resolve(); await runtime.wait(child.threadId);
      check(runtime.read(child.threadId).turns.length === 1, 'No spurious extra turn');
      check(model.calls.length === (trigger ? 2 : 1), 'Only explicit same-turn work extends the turn');
      check(runtime.inspectInputs(child.threadId)[0]?.state === (trigger ? 'committed' : 'queued'), 'Queue-only mail remains available for next turn');
    }
  },
  async 'factory failure and startup interrupt do not replay queued input'() {
    const failing: ModelConnector = { run() { throw new Error('Factory failed'); } };
    const runtime = new AgentRuntime({ connector: failing }); const thread = runtime.create(); const turn = runtime.start(thread.id, 'Start');
    await runtime.steer(thread.id, turn.id, 'BEFORE_FACTORY'); await runtime.wait(thread.id);
    check(runtime.inspectInputs(thread.id)[0]?.state === 'uncommitted', 'Factory failure leaves input uncommitted');
    check(!JSON.stringify(runtime.context(thread.id)).includes('BEFORE_FACTORY'), 'Factory failure removes included context');
    const opening = deferred(); const never = deferred();
    const model = connector(async function* ({ args }) { opening.resolve(); await abortable(never.promise, args.signal); yield completed(); });
    const active = new AgentRuntime({ connector: model }); const target = active.create(); const running = active.start(target.id, 'Start');
    await opening.promise; await active.steer(target.id, running.id, 'BEFORE_CREATED'); active.interrupt(target.id, running.id); await active.wait(target.id);
    check(active.inspectInputs(target.id)[0]?.state === 'uncommitted', 'Interrupted opening input is visible but uncommitted');
    check(!JSON.stringify(active.context(target.id)).includes('BEFORE_CREATED'), 'Interrupted queued input never enters replayable context');
  },
  async 'provider rejection stays failed while lost accepted steer stays uncommitted'() {
    for (const failure of [true, false]) {
      const ready = deferred(); const release = deferred(); let sent = '';
      const model: ModelConnector = { run: () => ({ steer: async (text) => { sent = text; return { receiptId: 'receipt', input: text, responseId: 'response', state: 'sent' }; },
        events: (async function* (): AsyncGenerator<ModelEvent> { yield created(); ready.resolve(); await release.promise;
          yield { type: 'steering', receiptId: 'receipt', state: failure ? 'failed' : 'accepted', responseId: 'response' };
          if (!failure) throw new Error('Socket lost'); yield completed();
        })() }), discardThread: () => [] };
      const runtime = new AgentRuntime({ connector: model }); const thread = runtime.create(); const turn = runtime.start(thread.id, 'Hello');
      await ready.promise; await runtime.steer(thread.id, turn.id, 'PROVIDER_NOTE'); release.resolve(); await runtime.wait(thread.id);
      check(sent === 'PROVIDER_NOTE', 'Steer dispatched');
      check(runtime.inspectInputs(thread.id)[0]?.state === (failure ? 'failed' : 'uncommitted'), 'Known rejected differs from lost acknowledgement');
      check(!JSON.stringify(runtime.context(thread.id)).includes('PROVIDER_NOTE'), 'No uncommitted replay');
    }
  },
  async 'interrupted active followup is not silently consumed by a later task'() {
    const started = deferred(); const never = deferred();
    const model = connector(async function* ({ args, step }) { yield created(); if (step === 1) { started.resolve(); await abortable(never.promise, args.signal); } else yield answer('Fresh result'); yield completed(); });
    const runtime = new AgentRuntime({ connector: model }); const root = runtime.create(); const child = runtime.spawn(root.id, 'First task');
    await started.promise; runtime.followupTask(root.id, child.threadId, 'INTERRUPTED_FOLLOWUP'); runtime.interrupt(child.threadId, child.turnId); await runtime.wait(child.threadId);
    check(runtime.inspectInputs(child.threadId)[0]?.state === 'uncommitted', 'Pending task input is explicitly uncommitted');
    runtime.start(child.threadId, 'Fresh task'); await runtime.wait(child.threadId);
    check(!JSON.stringify(runtime.context(child.threadId)).includes('INTERRUPTED_FOLLOWUP'), 'Later task did not silently apply interrupted input');
  },
  async 'interrupt before callback invocation records not-executed without a false late outcome'() {
    let invocations = 0;
    const tool: Tool = { definition: { type: 'function', name: 'never_started' }, async execute() { invocations++; return 'Should not execute'; } };
    const model = connector(async function* () { yield created(); yield* toolCall('never_started', {}); yield completed(); });
    const runtime = new AgentRuntime({ connector: model, tools: [tool] }); const thread = runtime.create();
    runtime.subscribe((event) => {
      if (event.method === 'item/started' && (event.params.item as { tool?: string })?.tool === 'never_started') runtime.interrupt(thread.id, String(event.params.turnId));
    });
    runtime.start(thread.id, 'Exercise invocation boundary'); await runtime.wait(thread.id); await Promise.resolve();
    check(invocations === 0, 'Cancellation happened before host callback invocation');
    const outputs = runtime.context(thread.id).filter((item) => item.type === 'function_call_output');
    check(outputs.length === 1 && String(outputs[0]?.output).includes('NOT EXECUTED'), 'Never-invoked call does not claim unknown side effects');
    check(!runtime.journal.some((entry) => entry.kind === 'lateToolOutcome'), 'Wrapper rejection is not a late host result');
  },
  async 'interrupt releases an unresolved preparation hook and suppresses late dispatch'() {
    const entered = deferred(); const late = deferred(); let preparations = 0;
    const model = simple();
    const runtime = new AgentRuntime({ connector: model, beforeModel() {
      if (++preparations === 1) { entered.resolve(); return late.promise; }
    } });
    const thread = runtime.create(); const first = runtime.start(thread.id, 'First turn'); await entered.promise;
    runtime.interrupt(thread.id, first.id);
    check((await runtime.wait(thread.id))?.status === 'interrupted', 'Preparation cannot hold the active turn after interruption');
    check(model.calls.length === 0, 'Interrupted preparation has not dispatched a model request');
    runtime.start(thread.id, 'Second turn'); check((await runtime.wait(thread.id))?.status === 'completed', 'Same thread can start another turn');
    late.resolve(); await late.promise; await Promise.resolve(); await Promise.resolve();
    check(Number(model.calls.length) === 1, 'Late preparation completion cannot dispatch the old request');
    check(runtime.journal.some((entry) => entry.kind === 'lateRequestPreparation' && entry.data.turnId === first.id && entry.data.dispatched === false), 'Late preparation is attributed to its original turn');
  },
  async 'browser factory opening cancellation does not bind later socket lifetime'() {
    class Socket extends EventTarget {
      closes = 0; sent: string[] = []; send(value: string) { this.sent.push(value); }
      close() { this.closes++; this.dispatchEvent(new Event('close')); }
    }
    const socket = new Socket(); const first = new AbortController();
    const factory = browserConnectionFactory('ws://fixture', () => socket as unknown as WebSocket);
    const opening = factory(first.signal); socket.dispatchEvent(new Event('open')); const connection = await opening;
    first.abort(); check(socket.closes === 0, 'Finished turn signal does not close reused socket'); connection.close();
    const connecting = new Socket(); const abort = new AbortController();
    const pending = browserConnectionFactory('ws://fixture', () => connecting as unknown as WebSocket)(abort.signal);
    abort.abort(new Error('Opening cancelled')); let rejected = false; try { await pending; } catch { rejected = true; }
    check(rejected && connecting.closes === 1, 'Opening abort closes and rejects');
    let constructed = false; const already = new AbortController(); already.abort();
    try { await browserConnectionFactory('ws://fixture', () => { constructed = true; return new Socket() as unknown as WebSocket; })(already.signal); } catch {}
    check(!constructed, 'Already aborted signal constructs no socket');
  },
};

export async function runControlChecks() {
  const passed: string[] = [];
  for (const [name, run] of Object.entries(controlChecks)) { await run(); passed.push(name); }
  return { providerRequests: 0, checks: passed, count: passed.length, environment: 'portable JavaScript; same suite for browser and Node' };
}
