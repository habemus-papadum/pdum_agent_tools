import { AgentRuntime, type Tool } from '../../039-hp-agent-runtime/src/runtime.ts';
import { PortClient, servePort, type Port } from '../../039-hp-agent-runtime/src/protocol.ts';
import { JobRegistry, type JobSnapshot, type JobWaitResult } from '../../039-hp-agent-runtime/src/jobs/registry.ts';
import type { ModelConnector, ModelEvent } from '../../038-hp-sdk-fit/src/connector.ts';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function gate() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() }; }
const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Integration check timed out')), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function* answer(): AsyncGenerator<ModelEvent> {
  yield { type: 'raw', event: { type: 'response.created', response: { id: crypto.randomUUID() } } };
  yield { type: 'outputItem', item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done' }] } };
  yield { type: 'completed', responseId: crypto.randomUUID() };
}

/** Host jobs, real MessagePorts and scripted model events; no provider calls here. */
export async function runWorkScenarios() {
  const cases: { name: string; passed: true }[] = [];
  {
    let calls = 0, jobId = ''; const entered = gate();
    const tool: Tool = {
      definition: { type: 'function', name: 'wait_job', parameters: { type: 'object', properties: {} } },
      async execute(_text, { runtime, threadId, signal }) {
        const job = runtime.startJob(threadId, { acceptsInput: true, run: async ctx => {
          ctx.output('STARTED'); const input = await ctx.nextInput(); ctx.progress(1); return input;
        } });
        jobId = job.id; entered.resolve();
        return JSON.stringify(await runtime.jobs.wait(job.id, { signal }));
      },
    };
    const connector: ModelConnector = { run() { return { steer: async () => {}, events: (async function* () {
      if (++calls > 1) { yield* answer(); return; }
      const item = { type: 'function_call', call_id: 'wait-call', name: 'wait_job', arguments: '{}' };
      yield { type: 'outputItem', item };
      yield { type: 'toolCall', id: item.call_id, name: item.name, arguments: item.arguments, kind: 'function' };
      yield { type: 'completed', responseId: 'wait-response' };
    })() }; } };
    const runtime = new AgentRuntime({ connector, tools: [tool] }); const thread = runtime.create();
    const turn = runtime.start(thread.id, 'Start work and wait');
    await bounded(entered.promise); runtime.interrupt(thread.id, turn.id);
    check((await bounded(runtime.wait(thread.id)))?.status === 'interrupted', 'Turn did not interrupt');
    check(runtime.jobs.inspect(jobId).status === 'running', 'Turn interruption killed independently owned job');
    runtime.jobs.send(jobId, { answer: 41 });
    const result = await bounded(runtime.jobs.wait(jobId)); await tick();
    check(result.job.status === 'completed' && (result.job.result as { answer: number }).answer === 41, 'Background work lost its result');
    check(calls === 1 && runtime.read(thread.id).turns.length === 1, 'Job completion restarted idle agent');
    check(runtime.inspectInputs(thread.id).some(i => i.kind === 'jobCompletion' && i.jobId === jobId && i.state === 'queued'), 'Completion notice not retained');
    const fork = runtime.fork(thread.id);
    check(runtime.jobs.list({ threadId: fork.id }).length === 0, 'Fork cloned live work ownership');
    runtime.start(thread.id, 'Read the completed job');
    await bounded(runtime.wait(thread.id));
    check(runtime.inspectInputs(thread.id).some(i => i.kind === 'jobCompletion' && i.state === 'committed'), 'Next explicit turn lost completion');
    check(runtime.journal.some(e => e.kind === 'notification' && e.data.method === 'hp/job/event'), 'Job events missing from runtime journal');
    cases.push({ name: 'Turn interruption releases a waiter; job survives, completion stays queued, fork does not clone execution', passed: true });
  }
  {
    const runtime = new AgentRuntime({ connector: { run: () => ({ events: answer(), steer: async () => {} }) } });
    const detachedWait = gate();
    const wait = runtime.jobs.wait.bind(runtime.jobs);
    runtime.jobs.wait = async (id, options = {}) => {
      try { return await wait(id, options); }
      finally { if (String(options.signal?.reason).includes('Client detached')) detachedWait.resolve(); }
    };
    const thread = runtime.create();
    const job = runtime.startJob(thread.id, { acceptsInput: true, run: async ctx => {
      ctx.output({ text: 'partial' }); return await ctx.nextInput();
    } });
    const channels = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
    const clients = channels.map(c => new PortClient(c.port2 as unknown as Port));
    const stops = channels.map(c => servePort(runtime, c.port1 as unknown as Port));
    try {
      for (const client of clients) await client.request('initialize');
      const first = clients[0]!.request('hp/job/wait', { jobId: job.id, waitId: 'mine' }).then(() => 'unexpected', error => String(error));
      const second = clients[1]!.request<JobWaitResult>('hp/job/wait', { jobId: job.id, waitId: 'mine' });
      check((await clients[0]!.request('hp/job/cancelWait', { waitId: 'mine' })).requested, 'Wait cancel missed registered request');
      check((await bounded(first)).includes('cancelled its job wait'), 'Wait cancellation did not settle caller');
      check(runtime.jobs.inspect(job.id).status === 'running', 'Cancelling wait stopped producer');
      const detached = clients[2]!.request('hp/job/wait', { jobId: job.id, waitId: 'detach' }).catch(error => String(error));
      await clients[2]!.request('hp/job/read', { jobId: job.id }); // ordered admission before detach
      clients[2]!.close(); await detached; await bounded(detachedWait.promise);
      check(runtime.jobs.inspect(job.id).status === 'running', 'Client detach stopped producer');
      await clients[1]!.request('hp/job/send', { jobId: job.id, input: { value: 42 } });
      const completed = await bounded(second);
      check(completed.job.status === 'completed', 'Other client wait was cancelled');
      const read = await clients[1]!.request<{ job: JobSnapshot }>('hp/job/read', { jobId: job.id });
      check((read.job.result as { value: number }).value === 42, 'Completed history read lost result');
      const history = await clients[1]!.request<{ events: { seq: number; kind: string }[] }>('hp/job/events', { jobId: job.id });
      check(history.events.some(e => e.kind === 'output') && history.events.some(e => e.kind === 'completed'), 'Replay missing output or completion');
      const cursor = history.events.at(-1)!.seq;
      check((await clients[1]!.request<{ events: unknown[] }>('hp/job/events', { jobId: job.id, afterSeq: cursor })).events.length === 0, 'Event cursor repeated data');
      cases.push({ name: 'Multiple real MessagePort clients independently wait, cancel and detach; completed output remains readable', passed: true });
    } finally { clients.forEach(c => c.close()); stops.forEach(stop => stop()); channels.forEach(c => { c.port1.close(); c.port2.close(); }); runtime.jobs.close(); }
  }
  {
    const jobs = new JobRegistry();
    const runtime = new AgentRuntime({ jobs, connector: { run: () => ({ events: answer(), steer: async () => {} }) } });
    const thread = runtime.create();
    const own = runtime.startJob(thread.id, { acceptsInput: true, run: ctx => ctx.nextInput() });
    const external = jobs.start({ ownerId: 'application', threadId: thread.id, acceptsInput: true, run: ctx => ctx.nextInput() });
    await tick(); runtime.dispose();
    const journalLength = runtime.journal.length;
    check((await bounded(jobs.wait(own.id))).job.status === 'cancelled', 'Dispose did not request own job cancellation');
    check(jobs.inspect(external.id).status === 'running', 'Dispose cancelled external host ownership');
    jobs.send(external.id, 'EXTERNAL_FINISHED'); await jobs.wait(external.id); await tick();
    check(runtime.journal.length === journalLength, 'Disposed runtime retained shared registry subscription');
    let rejected = false;
    try { runtime.startJob(thread.id, { run: () => 1 }); } catch { rejected = true; }
    check(rejected, 'Disposed runtime admitted new work');
    jobs.close();
    cases.push({ name: 'Runtime disposal detaches shared registry and cancels only its owned jobs', passed: true });
  }
  {
    const atAnswer = gate(), finish = gate(); let calls = 0;
    const runtime = new AgentRuntime({ connector: { run: () => ({ steer: async () => {}, events: (async function* (): AsyncGenerator<ModelEvent> {
      calls++;
      yield { type: 'outputItem', item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done' }] } };
      atAnswer.resolve(); await finish.promise;
      yield { type: 'completed', responseId: 'disposed-answer' };
    })() }) } });
    const parent = runtime.create(), child = runtime.create({ parentThreadId: parent.id });
    runtime.start(child.id, 'First task'); await bounded(atAnswer.promise);
    runtime.followupTask(parent.id, child.id, 'Queued after answer');
    runtime.dispose(); finish.resolve();
    await bounded(runtime.wait(child.id)); await tick();
    check(calls === 1, 'Deferred follow-up restarted a disposed runtime');
    cases.push({ name: 'Runtime disposal suppresses an already-scheduled follow-up after the answer boundary', passed: true });
  }
  return { passed: true, cases, providerCalls: 0 };
}
