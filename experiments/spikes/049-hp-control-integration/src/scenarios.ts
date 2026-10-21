import { AgentRuntime, type Tool } from '../../039-hp-agent-runtime/src/runtime.ts';
import { agentTools } from '../../039-hp-agent-runtime/src/tools/agent-tools.ts';
import type { ModelConnector, ModelEvent, ModelRunArgs, NativeItem } from '../../038-hp-sdk-fit/src/connector.ts';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function gate() { let release!: () => void; return { promise: new Promise<void>(r => { release = r; }), release: () => release() }; }
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), 1500); })]); }
  finally { clearTimeout(timer); }
}
function connector(generate: (args: ModelRunArgs) => AsyncGenerator<ModelEvent>): ModelConnector {
  return { run(args) { return { events: generate(args), steer: async () => { throw Error('This case steers only while tools are waiting'); } }; } };
}
async function* answer(id: string, text = 'ACK'): AsyncGenerator<ModelEvent> {
  yield { type: 'raw', event: { type: 'response.created', response: { id } } };
  yield { type: 'outputItem', item: { id: `m-${id}`, type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } };
  yield { type: 'completed', responseId: id };
}
async function* call(name: string, args: NativeItem): AsyncGenerator<ModelEvent> {
  const item = { type: 'function_call', call_id: crypto.randomUUID(), name, arguments: JSON.stringify(args) };
  yield { type: 'raw', event: { type: 'response.created', response: { id: `r-${item.call_id}` } } };
  yield { type: 'outputItem', item };
  yield { type: 'toolCall', id: item.call_id, name, arguments: item.arguments, kind: 'function' };
  yield { type: 'completed', responseId: `r-${item.call_id}` };
}
function toolStarted(runtime: AgentRuntime, threadId: string, name: string) {
  let stop = () => {};
  const promise = new Promise<void>(resolve => { stop = runtime.subscribe(event => {
    if (event.method === 'item/started' && event.params.threadId === threadId && (event.params.item as { tool?: string }).tool === name) { stop(); resolve(); }
  }); });
  return { promise, stop: () => stop() };
}

/** Identical code executes under Node and in a real browser Worker. Provider events here are scripted. */
export async function runControlScenarios() {
  const cases: { name: string; passed: true }[] = [];
  {
    const requests: ModelRunArgs[] = [];
    const runtime = new AgentRuntime({ connector: connector(async function* (args) { requests.push(structuredClone({ ...args, signal: undefined }) as unknown as ModelRunArgs); yield* answer(crypto.randomUUID()); }), waitBounds: { minMs: 0, maxMs: 1000, defaultMs: 20 } });
    const parent = runtime.create({ cwd: '/workspace' }); const child = runtime.create({ parentThreadId: parent.id });
    runtime.sendMessage(parent.id, child.id, 'NOTE_BEFORE_WAIT');
    check(requests.length === 0, 'Queue-only message started inference');
    check((await runtime.waitAgent(child.id, { timeoutMs: 20 })).reason === 'mailbox', 'Message-before-wait lost its wakeup');
    const followup = runtime.followupTask(parent.id, child.id, 'FOLLOWUP_TASK');
    check(followup.state === 'started', 'Idle follow-up did not start a turn');
    check((await bounded(runtime.wait(child.id), 'follow-up'))?.status === 'completed', 'Follow-up failed');
    const input = JSON.stringify(requests[0]!.input);
    check(input.indexOf('NOTE_BEFORE_WAIT') < input.indexOf('FOLLOWUP_TASK'), 'Mailbox arrival order changed');
    check(Number(requests.length) === 1, 'Completion started an idle parent');
    check(runtime.inspectInputs(parent.id).some(x => x.kind === 'completion' && x.state === 'queued'), 'Completion was not retained for parent');
    check(runtime.read(child.id).cwd === parent.cwd, 'Child lost inherited cwd');
    cases.push({ name: 'queue-only mail, message-before-wait, ordered follow-up and idle completion', passed: true });
    const empty = runtime.create();
    check((await runtime.waitAgent(empty.id, { timeoutMs: 5 })).timed_out, 'Timed wait did not time out');
    cases.push({ name: 'timed mailbox wait', passed: true });
  }
  for (const mode of ['steer', 'interrupt', 'subtree'] as const) {
    const childGate = gate(); let parentId = '', childId = '', parentCalls = 0;
    const runtime = new AgentRuntime({ tools: agentTools, connector: connector(async function* (args) {
      if (args.threadId === childId) { await childGate.promise; yield* answer('child'); return; }
      if (++parentCalls === 1) yield* call('wait', { id: childId });
      else { check(JSON.stringify(args.input).includes('CHANGE_DIRECTION'), 'Steering was not in next model input'); yield* answer('parent-after-steer'); }
    }) });
    const parent = runtime.create(); parentId = parent.id; childId = runtime.create({ parentThreadId: parentId }).id;
    const started = toolStarted(runtime, parentId, 'wait');
    runtime.start(childId, 'child'); const turn = runtime.start(parentId, 'wait for child');
    try {
      await bounded(started.promise, 'wait tool start');
      if (mode === 'steer') await runtime.steer(parentId, turn.id, 'CHANGE_DIRECTION');
      else runtime.interrupt(parentId, turn.id, { scope: mode === 'subtree' ? 'subtree' : 'thread' });
      const parentResult = await bounded(runtime.wait(parentId), `${mode} while waiting`);
      check(parentResult?.status === (mode === 'steer' ? 'completed' : 'interrupted'), 'Parent did not settle correctly');
      if (mode !== 'subtree') check(runtime.read(childId).turns.at(-1)!.status === 'inProgress', 'Independent child was cancelled');
      else check(runtime.read(childId).turns.at(-1)!.status !== 'completed', 'Subtree child unexpectedly completed');
      if (mode !== 'steer') {
        const context = runtime.context(parentId);
        check(context.some(item => item.type === 'function_call_output' && String(item.output).includes('INTERRUPTED')), 'Interrupted tool pair was not closed truthfully');
      }
      cases.push({ name: `${mode} wakes parent wait with explicit child lifetime`, passed: true });
    } finally { started.stop(); childGate.release(); await bounded(runtime.wait(childId), 'child cleanup'); }
  }
  {
    const work = gate(); let effect = 0;
    const tool: Tool = { definition: { type: 'function', name: 'slow', parameters: { type: 'object', properties: {} } }, async execute() { await work.promise; effect++; return 'LATE_RESULT'; } };
    const runtime = new AgentRuntime({ tools: [tool], connector: connector(async function* () { yield* call('slow', {}); }) });
    const parent = runtime.create(); const started = toolStarted(runtime, parent.id, 'slow');
    const turn = runtime.start(parent.id, 'wait for slow tool');
    try {
      await bounded(started.promise, 'slow tool start');
      runtime.interrupt(parent.id, turn.id);
      check((await bounded(runtime.wait(parent.id), 'noncooperative tool interruption'))?.status === 'interrupted', 'Noncooperative tool blocked interruption');
      work.release(); await new Promise(resolve => setTimeout(resolve, 0));
      check(effect === 1, 'Controlled late side effect did not occur');
      check(runtime.journal.some(e => e.kind === 'lateToolOutcome'), 'Late tool outcome disappeared');
      check(!JSON.stringify(runtime.context(parent.id)).includes('LATE_RESULT'), 'Late result changed already-settled context');
      cases.push({ name: 'late noncooperative tool outcome stays observable without contaminating context', passed: true });
    } finally { started.stop(); work.release(); }
  }
  return { passed: true, cases, providerCalls: 0, evidence: 'Runtime control mechanics with scripted model events; not provider qualification' };
}
