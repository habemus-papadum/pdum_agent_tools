import { AgentRuntime, type Tool } from '../../039-hp-agent-runtime/src/runtime.ts';
import type { ModelConnector } from '../../038-hp-sdk-fit/src/connector.ts';

export const LIVE_SUFFIX = '\n\n# Work integration qualification\nFollow the user task exactly. When asked for both read_left and read_right, emit both function calls in ONE response because neither depends on the other. After starting background work, answer JOB_STARTED immediately; do not wait or poll. On a subsequent explicit request, use read_job to read its completed result. Keep final answers to the requested marker or number.\n';
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const definition = (name: string, description: string, properties = {}, required: string[] = []): Tool['definition'] => ({
  type: 'function', name, description, strict: true, parameters: { type: 'object', properties, required, additionalProperties: false },
});

/** Same live application code runs under Node and in a browser Worker. */
export async function runWorkLive(connector: ModelConnector, instructions: string, signal: AbortSignal) {
  const intervals: { name: string; start: number; end?: number }[] = [];
  let release!: () => void;
  const both = new Promise<void>(r => { release = r; });
  let backgroundId = '';
  const tools: Tool[] = ['left', 'right'].map((side, index) => ({
    definition: definition(`read_${side}`, 'Read an independent application value. Both reads may run concurrently.'),
    supportsParallel: true,
    async execute() {
      const row: { name: string; start: number; end?: number } = { name: side, start: performance.now() }; intervals.push(row);
      if (new Set(intervals.map(x => x.name)).size === 2) release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([both, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Model did not submit both reads together')), 5000); })]);
        return String(index === 0 ? 19 : 22);
      } finally { clearTimeout(timer); row.end = performance.now(); }
    },
  }));
  tools.push({
    definition: definition('start_background', 'Start an application job that awaits structured host input. Return its ID immediately.'),
    async execute(_text, { runtime, threadId }) {
      check(!backgroundId, 'Probe allows one background job');
      const job = runtime.startJob(threadId, { name: 'host-input calculation', acceptsInput: true, run: async ctx => {
        ctx.output({ stage: 'awaiting-input' }); const input = await ctx.nextInput(); ctx.progress(1); return input;
      } });
      backgroundId = job.id; return JSON.stringify({ jobId: job.id });
    },
  }, {
    definition: definition('read_job', 'Read a job status and its result without starting or waiting for work.', { jobId: { type: 'string' } }, ['jobId']),
    supportsParallel: true,
    async execute(text, { runtime }) { return JSON.stringify(runtime.jobs.inspect(JSON.parse(text).jobId)); },
  });
  const runtime = new AgentRuntime({ connector, instructions, tools });
  const abort = () => {
    for (const thread of runtime.list()) {
      const turn = runtime.read(thread.id).turns.at(-1);
      if (turn?.status === 'inProgress') runtime.interrupt(thread.id, turn.id);
    }
    runtime.jobs.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  const answer = (threadId: string) => runtime.read(threadId).turns.at(-1)!.items.filter(x => x.type === 'agentMessage').map(x => x.text).join('\n');
  const cases: { name: string; answer: string }[] = [];
  let failure: string | undefined;
  try {
    signal.throwIfAborted();
    const parallel = runtime.create();
    runtime.start(parallel.id, 'Call read_left AND read_right together in one response, then add their values and reply with only the sum.');
    check((await runtime.wait(parallel.id))?.status === 'completed', 'Parallel turn did not complete');
    check(intervals.length === 2 && Math.max(...intervals.map(x => x.start)) <= Math.min(...intervals.map(x => x.end!)), 'Read executions did not overlap');
    check(answer(parallel.id).trim() === '41', 'Incorrect read sum');
    cases.push({ name: 'Model-selected parallel application reads', answer: answer(parallel.id) });
    const background = runtime.create();
    runtime.start(background.id, 'Call start_background exactly once, then reply JOB_STARTED immediately without reading or waiting for its result.');
    check((await runtime.wait(background.id))?.status === 'completed', 'Job-start turn did not finish');
    check(backgroundId && runtime.jobs.inspect(backgroundId).status === 'running', 'Job did not outlive initiating turn');
    check(answer(background.id).includes('JOB_STARTED'), 'Missing start acknowledgement');
    runtime.jobs.send(backgroundId, { total: 73 });
    await runtime.jobs.wait(backgroundId, { signal });
    await new Promise(resolve => setTimeout(resolve, 0));
    check(runtime.read(background.id).turns.length === 1, 'Completion automatically restarted model');
    check(runtime.inspectInputs(background.id).some(i => i.jobId === backgroundId && i.state === 'queued'), 'Idle completion notice not queued');
    runtime.start(background.id, 'Read the completed background job using read_job, then reply with only its total.');
    check((await runtime.wait(background.id))?.status === 'completed', 'Job-reading turn failed');
    check(answer(background.id).trim() === '73', 'Model did not read the completed job result');
    cases.push({ name: 'Job outlives turn; explicit new turn reads retained result', answer: answer(background.id) });
  } catch (error) { failure = String(error); }
  finally {
    signal.removeEventListener('abort', abort); abort();
    // These probe jobs cooperate with cancellation. Bound cleanup observation;
    // timeout must retain the actual cancelling state rather than claim a stop.
    await Promise.all(runtime.jobs.list().map(job => runtime.jobs.wait(job.id, { timeoutMs: 1000 })));
  }
  return { passed: !failure, failure, cases, intervals, journal: runtime.journal, jobs: runtime.jobs.list(), events: runtime.jobs.events(), usages: runtime.usages };
}
