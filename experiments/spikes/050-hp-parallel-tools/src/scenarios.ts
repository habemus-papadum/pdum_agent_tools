import { AgentRuntime, type Tool } from '../../039-hp-agent-runtime/src/runtime.ts';
import { ParallelToolGate } from '../../039-hp-agent-runtime/src/tools/parallel.ts';
import type { ModelConnector, ModelEvent, ModelRunArgs, NativeItem } from '../../038-hp-sdk-fit/src/connector.ts';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function equal(actual: unknown, expected: unknown, message: string) { check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`); }
function gate() { let release!: () => void; return { promise: new Promise<void>(r => { release = r; }), release: () => release() }; }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), 2000); })]); }
  finally { clearTimeout(timer); }
}
type Call = { id: string; name: string; kind?: 'function' | 'custom'; arguments?: string };
function makeTool(name: string, execute: Tool['execute'], supportsParallel?: boolean): Tool {
  return { definition: { type: 'function', name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false } }, execute, ...(supportsParallel === undefined ? {} : { supportsParallel }) };
}
async function* response(id: string, calls: Call[] = []): AsyncGenerator<ModelEvent> {
  yield { type: 'raw', event: { type: 'response.created', response: { id } } };
  for (const call of calls) {
    const kind = call.kind ?? 'function'; const args = call.arguments ?? '{}';
    yield { type: 'outputItem', item: { type: kind === 'custom' ? 'custom_tool_call' : 'function_call', call_id: call.id, name: call.name, [kind === 'custom' ? 'input' : 'arguments']: args } };
    yield { type: 'toolCall', id: call.id, name: call.name, arguments: args, kind };
  }
  if (!calls.length) yield { type: 'outputItem', item: { type: 'message', id: `m-${id}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'DONE' }] } };
  yield { type: 'completed', responseId: id };
}
function fixture(batches: Call[][], tools: Tool[], beforeModel?: ConstructorParameters<typeof AgentRuntime>[0]['beforeModel']) {
  const requests: { input: NativeItem[]; tools: NativeItem[] }[] = [];
  const connector: ModelConnector = { run(args: ModelRunArgs) {
    const index = requests.length; requests.push(structuredClone({ input: args.input, tools: args.tools }));
    return { events: response(`r-${index}`, batches[index] ?? []), steer: async () => { throw Error('Fixture steers only while tools execute'); } };
  } };
  const runtime = new AgentRuntime({ tools, connector, ...(beforeModel ? { beforeModel } : {}) });
  const thread = runtime.create();
  return { runtime, thread, requests, start: () => runtime.start(thread.id, 'fixture'), wait: () => bounded(runtime.wait(thread.id), 'turn completion') };
}
function outputs(runtime: AgentRuntime, threadId: string) { return runtime.context(threadId).filter(x => x.type === 'function_call_output' || x.type === 'custom_tool_call_output'); }

/** Deterministic scheduling/failure fixtures; same TypeScript runs under Node and in a browser Worker. */
export const parallelScenarios: { name: string; run(): Promise<void> }[] = [
  { name: 'parallel calls overlap, notify completion promptly, and commit results in call order', async run() {
    const a = gate(), b = gate(), both = gate(), bDone = gate(); const started: string[] = []; const completed: string[] = [];
    const tool = (name: string, pending: ReturnType<typeof gate>) => makeTool(name, async () => {
      started.push(name); if (started.length === 2) both.release(); await pending.promise; return `${name}-result`;
    }, true);
    const h = fixture([[{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]], [tool('a', a), tool('b', b)]);
    const stop = h.runtime.subscribe(event => { const item = event.params.item as { type?: string; id?: string } | undefined;
      if (event.method === 'item/completed' && item?.type === 'dynamicToolCall') { completed.push(item.id!); if (item.id === 'b') bDone.release(); }
    });
    h.start();
    try {
      await bounded(both.promise, 'both handlers starting'); equal(started, ['a', 'b'], 'Parallel tools did not overlap');
      b.release(); await bounded(bDone.promise, 'second completion'); equal(completed, ['b'], 'Fast completion was withheld');
      check(h.requests.length === 1, 'Next model request began before the batch settled');
      a.release(); check((await h.wait())?.status === 'completed', 'Turn failed');
      equal(completed, ['b', 'a'], 'Notifications did not reflect completion order');
      equal(outputs(h.runtime, h.thread.id).map(x => x.call_id), ['a', 'b'], 'Context changed model-call order');
    } finally { stop(); a.release(); b.release(); }
  } },
  { name: 'exclusive default forms a fair barrier between parallel groups', async run() {
    const gates = [gate(), gate(), gate(), gate()]; const reached = [gate(), gate(), gate(), gate()]; const started: number[] = [];
    const tools = gates.map((pending, i) => makeTool(`t${i}`, async () => { started.push(i); reached[i]!.release(); await pending.promise; return String(i); }, i === 2 ? undefined : true));
    const h = fixture([tools.map((_, i) => ({ id: `c${i}`, name: `t${i}` }))], tools); h.start();
    try {
      await bounded(reached[1]!.promise, 'first parallel group'); equal(started, [0, 1], 'Writer/read overtook initial readers');
      gates[1]!.release(); await tick(); equal(started, [0, 1], 'Exclusive began while a reader remained');
      gates[0]!.release(); await bounded(reached[2]!.promise, 'exclusive handler'); equal(started, [0, 1, 2], 'Later reader overtook writer');
      gates[2]!.release(); await bounded(reached[3]!.promise, 'second parallel group'); gates[3]!.release();
      check((await h.wait())?.status === 'completed', 'Barrier turn failed');
    } finally { gates.forEach(g => g.release()); }
  } },
  { name: 'ordinary failures and unknown tools preserve successful siblings and custom outputs', async run() {
    const h = fixture([[{ id: 'bad', name: 'bad' }, { id: 'ok', name: 'ok', kind: 'custom', arguments: 'raw text' }, { id: 'unknown', name: 'missing' }]], [
      makeTool('bad', () => { throw Error('INJECTED_FAILURE'); }, true),
      makeTool('ok', async args => { equal(args, 'raw text', 'Custom input changed'); return 'SUCCESS'; }, true),
    ]);
    h.start(); check((await h.wait())?.status === 'completed', 'Tool error incorrectly failed turn');
    const result = outputs(h.runtime, h.thread.id);
    equal(result.map(x => x.call_id), ['bad', 'ok', 'unknown'], 'Failure changed output order');
    check(String(result[0]!.output).includes('INJECTED_FAILURE'), 'Tool error missing');
    check(result[1]!.type === 'custom_tool_call_output' && result[1]!.output === 'SUCCESS', 'Custom sibling lost');
    check(String(result[2]!.output).includes('Unknown tool missing'), 'Unknown tool error missing');
  } },
  { name: 'interrupt repairs running and queued calls individually while retaining completed siblings', async run() {
    const pending = gate(), started = gate(), quickDone = gate(); const executed: string[] = [];
    const h = fixture([[{ id: 'slow', name: 'slow' }, { id: 'quick', name: 'quick' }, { id: 'exclusive', name: 'exclusive' }, { id: 'later', name: 'later' }]], [
      makeTool('slow', async () => { executed.push('slow'); started.release(); await pending.promise; return 'LATE_RESULT'; }, true),
      makeTool('quick', async () => { executed.push('quick'); return 'QUICK_RESULT'; }, true),
      makeTool('exclusive', async () => { executed.push('exclusive'); return 'WRONG'; }),
      makeTool('later', async () => { executed.push('later'); return 'WRONG'; }, true),
    ]);
    const stop = h.runtime.subscribe(event => { if (event.method === 'item/completed' && (event.params.item as { id?: string } | undefined)?.id === 'quick') quickDone.release(); });
    const turn = h.start();
    try {
      await bounded(Promise.all([started.promise, quickDone.promise]), 'running and completed siblings');
      h.runtime.interrupt(h.thread.id, turn.id); check((await h.wait())?.status === 'interrupted', 'Ignored abort blocked interruption');
      const result = outputs(h.runtime, h.thread.id);
      equal(result.map(x => x.call_id), ['slow', 'quick', 'exclusive', 'later'], 'Repair order changed');
      check(String(result[0]!.output).startsWith('INTERRUPTED / OUTCOME UNKNOWN'), 'Running outcome falsely known');
      check(result[1]!.output === 'QUICK_RESULT', 'Completed sibling was repaired as unknown');
      check(result.slice(2).every(x => String(x.output).startsWith('NOT EXECUTED')), 'Queued calls claimed execution');
      equal(executed, ['slow', 'quick'], 'Queued side effect ran after interrupt');
      h.start(); check((await h.wait())?.status === 'completed', 'New turn failed');
      const beforeLate = JSON.stringify(h.runtime.context(h.thread.id)); pending.release(); await tick();
      equal(JSON.stringify(h.runtime.context(h.thread.id)), beforeLate, 'Late tool changed a later turn context');
      check(h.runtime.journal.some(x => x.kind === 'lateToolOutcome' && x.data.callId === 'slow'), 'Late outcome was not journaled');
    } finally { stop(); pending.release(); }
  } },
  { name: 'interruption between started notification and handler invocation records not executed', async run() {
    let invoked = false; const h = fixture([[{ id: 'never', name: 'never' }]], [makeTool('never', async () => { invoked = true; return 'WRONG'; }, true)]);
    const stop = h.runtime.subscribe(event => { if (event.method === 'item/started' && (event.params.item as { id?: string } | undefined)?.id === 'never') h.runtime.interrupt(h.thread.id, String(event.params.turnId)); });
    try { h.start(); check((await h.wait())?.status === 'interrupted', 'Turn was not interrupted'); check(!invoked, 'Callback executed after abort'); check(String(outputs(h.runtime, h.thread.id)[0]!.output).startsWith('NOT EXECUTED'), 'Dispatch was confused with execution'); }
    finally { stop(); }
  } },
  { name: 'late handler rejection is observed without changing the settled tool output', async run() {
    const pending = gate(), started = gate();
    const h = fixture([[{ id: 'late-failure', name: 'late-failure' }]], [makeTool('late-failure', async () => {
      started.release(); await pending.promise; throw Error('LATE_REJECTION');
    }, true)]);
    const turn = h.start();
    try {
      await bounded(started.promise, 'late failure handler'); h.runtime.interrupt(h.thread.id, turn.id);
      check((await h.wait())?.status === 'interrupted', 'Late rejection blocked interruption');
      const settled = JSON.stringify(outputs(h.runtime, h.thread.id)); pending.release(); await tick();
      equal(JSON.stringify(outputs(h.runtime, h.thread.id)), settled, 'Late rejection rewrote settled result');
      check(h.runtime.journal.some(x => x.kind === 'lateToolOutcome' && x.data.status === 'failed-after-interrupt' && String(x.data.error).includes('LATE_REJECTION')), 'Late rejection was not observed');
    } finally { pending.release(); }
  } },
  { name: 'advertised schema, handler and parallel flag are snapshotted per model step', async run() {
    const pending = gate(), both = gate(); let oldStarts = 0, newStarts = 0, preparations = 0;
    const original = makeTool('changing', async () => { oldStarts++; if (oldStarts === 2) both.release(); await pending.promise; return 'OLD_HANDLER'; }, true);
    original.definition.description = 'OLD_SCHEMA';
    const h = fixture([[{ id: 'old-a', name: 'changing' }, { id: 'old-b', name: 'changing' }], [{ id: 'new', name: 'changing' }]], [original], () => {
      if (++preparations !== 1) return;
      original.definition.description = 'NEW_SCHEMA'; original.supportsParallel = false;
      original.execute = async () => { newStarts++; return 'NEW_HANDLER'; };
    });
    h.start();
    try {
      await bounded(both.promise, 'snapshotted parallel handlers'); equal([oldStarts, newStarts], [2, 0], 'Old step dispatched new handler/parallel policy');
      check(h.requests[0]!.tools[0]!.description === 'OLD_SCHEMA', 'Advertised schema changed during preparation');
      pending.release(); check((await h.wait())?.status === 'completed', 'Snapshot turn failed');
      check(h.requests[1]!.tools[0]!.description === 'NEW_SCHEMA' && newStarts === 1, 'Next step did not adopt changed tool');
      equal(outputs(h.runtime, h.thread.id).map(x => x.output), ['OLD_HANDLER', 'OLD_HANDLER', 'NEW_HANDLER'], 'Handler drift changed output');
    } finally { pending.release(); }
  } },
  { name: 'steering waits for the whole parallel batch and follows its ordered results', async run() {
    const a = gate(), b = gate(), both = gate(); let count = 0;
    const make = (name: string, pending: ReturnType<typeof gate>) => makeTool(name, async () => { if (++count === 2) both.release(); await pending.promise; return `${name}-result`; }, true);
    const h = fixture([[{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]], [make('a', a), make('b', b)]); const turn = h.start();
    try {
      await bounded(both.promise, 'parallel handlers'); await h.runtime.steer(h.thread.id, turn.id, 'CHANGE_DIRECTION');
      a.release(); await tick(); check(h.requests.length === 1, 'Steer bypassed running sibling');
      b.release(); check((await h.wait())?.status === 'completed', 'Steered turn failed');
      const input = h.requests[1]!.input; const steer = input.findIndex(x => JSON.stringify(x).includes('CHANGE_DIRECTION'));
      check(steer > input.findIndex(x => x.call_id === 'b' && x.type === 'function_call_output'), 'Queued steer preceded batch result');
      check(h.runtime.inspectInputs(h.thread.id).some(x => x.text === 'CHANGE_DIRECTION' && x.state === 'committed'), 'Steer commitment missing');
    } finally { a.release(); b.release(); }
  } },
  { name: 'cancelling a queued exclusive admission unblocks readers without stealing an active lease', async run() {
    const scheduler = new ParallelToolGate(); const reader = new AbortController(), writer = new AbortController(), later = new AbortController();
    const releaseFirst = await scheduler.acquire(true, reader.signal); let laterAdmitted = false;
    const queuedWriter = scheduler.acquire(false, writer.signal).then(() => { throw Error('Cancelled writer acquired gate'); }, error => error);
    const nextReader = scheduler.acquire(true, later.signal).then(release => { laterAdmitted = true; return release; });
    await tick(); check(!laterAdmitted, 'Reader overtook waiting writer');
    writer.abort(Error('REMOVE_QUEUED_WRITER')); check(String(await queuedWriter).includes('REMOVE_QUEUED_WRITER'), 'Queued abort reason lost');
    const releaseLater = await bounded(nextReader, 'reader after cancelled writer');
    releaseFirst(); releaseFirst(); releaseLater();
    const releaseFinal = await bounded(scheduler.acquire(false, new AbortController().signal), 'exclusive after idempotent release'); releaseFinal();
  } },
];

export async function runParallelScenarios() {
  const cases: { name: string; passed: true }[] = [];
  for (const scenario of parallelScenarios) { await scenario.run(); cases.push({ name: scenario.name, passed: true }); }
  return { passed: true, cases, providerCalls: 0, evidence: 'Runtime scheduler and cancellation mechanics with scripted model events; not provider qualification' };
}
