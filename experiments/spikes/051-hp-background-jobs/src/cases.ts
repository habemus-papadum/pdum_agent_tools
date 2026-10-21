import { JobRegistry } from '../../039-hp-agent-runtime/src/jobs/registry.ts';

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const errorOf = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return String(error); } throw new Error('Expected rejection'); };

/** Identical real async work in Node and a browser Worker; no provider responses. */
export const jobCases: Record<string, () => Promise<void>> = {
  async 'structured progress, output, input and immutable sequenced history'() {
    const jobs = new JobRegistry();
    const job = jobs.start({ ownerId: 'owner', threadId: 'thread', turnId: 'turn', name: 'double', acceptsInput: true,
      run: async context => { context.progress({ fraction: 0 }); const value = await context.nextInput() as { n: number }; context.output({ n: value.n * 2 }); return value.n * 2; } });
    const input = { n: 21 }; jobs.send(job.id, input); input.n = 1;
    const result = await jobs.wait(job.id); check(result.job.result === 42, 'input must be captured, not referenced');
    const events = jobs.events(); check(events.every((event, index) => event.seq === index + 1), 'global event sequence');
    check(events.some(event => event.kind === 'progress') && events.some(event => event.kind === 'output'), 'structured emissions');
    check(events.every(event => event.threadId === 'thread' && event.turnId === 'turn'), 'execution provenance');
    events[0]!.data.changed = true; check(jobs.events()[0]!.data.changed === undefined, 'history is immutable to readers');
    check(jobs.events({ afterSeq: 1 }).length === events.length - 1, 'event cursor');
    check(jobs.list({ threadId: 'other' }).length === 0, 'thread filter');
  },
  async 'cancelling one waiter leaves another observer and the job running'() {
    const jobs = new JobRegistry(); const finish = deferred<string>(); const controller = new AbortController();
    const job = jobs.start({ ownerId: 'owner', run: () => finish.promise });
    const first = jobs.wait(job.id, { signal: controller.signal }); const second = jobs.wait(job.id);
    controller.abort(new Error('wait abandoned')); check((await errorOf(first)).includes('wait abandoned'), 'wait cancelled');
    check(jobs.inspect(job.id).status === 'running', 'job survived waiter'); finish.resolve('done');
    check((await second).job.result === 'done', 'second observer receives result');
  },
  async 'timeout is polling, with no execution deadline'() {
    const jobs = new JobRegistry(); const finish = deferred<number>(); const job = jobs.start({ ownerId: 'owner', run: () => finish.promise });
    for (let index = 0; index < 20; index++) check((await jobs.wait(job.id, { timeoutMs: 0 })).status === 'timeout', 'poll times out');
    check(jobs.inspect(job.id).status === 'running', 'timeout never cancels job'); finish.resolve(7);
    check((await jobs.wait(job.id)).job.result === 7, 'job completes after timed-out waits');
  },
  async 'explicit cooperative cancellation aborts input waiting'() {
    const jobs = new JobRegistry(); const job = jobs.start({ ownerId: 'owner', acceptsInput: true, run: context => context.nextInput() });
    await tick(); check(jobs.cancel(job.id).status === 'cancelling', 'cancel is initially only a request');
    check((await jobs.wait(job.id)).job.status === 'cancelled', 'task acknowledged cancellation');
    check(jobs.events({ jobId: job.id }).filter(event => event.kind === 'cancelled').length === 1, 'one terminal event');
  },
  async 'uncooperative task remains cancelling and late completion stays truthful'() {
    const jobs = new JobRegistry(); const finish = deferred<string>();
    const job = jobs.start({ ownerId: 'owner', run: async context => { const result = await finish.promise; context.output('late output'); return result; } });
    await tick(); jobs.cancel(job.id); check((await jobs.wait(job.id, { timeoutMs: 0 })).job.status === 'cancelling', 'not falsely stopped');
    finish.resolve('late result'); const result = (await jobs.wait(job.id)).job;
    check(result.status === 'completed' && result.cancellationRequested && result.result === 'late result', 'actual late outcome retained');
    check(jobs.events({ jobId: job.id }).some(event => event.kind === 'output' && event.data.afterCancellation === true), 'late output labelled');
  },
  async 'failure after cancellation is not misreported as successful cancellation'() {
    const jobs = new JobRegistry(); const finish = deferred<void>();
    const job = jobs.start({ ownerId: 'owner', run: async () => { await finish.promise; throw new Error('independent failure'); } });
    await tick(); jobs.cancel(job.id); finish.resolve();
    const result = (await jobs.wait(job.id)).job; check(result.status === 'failed' && result.error?.includes('independent failure'), 'failure preserved');
  },
  async 'owner close requests cancellation without affecting another owner'() {
    const jobs = new JobRegistry(); const finish = deferred<string>();
    const a = jobs.start({ ownerId: 'a', acceptsInput: true, run: context => context.nextInput() });
    const b = jobs.start({ ownerId: 'b', run: () => finish.promise }); await tick();
    jobs.closeOwner('a'); check((await jobs.wait(a.id)).job.status === 'cancelled', 'owner a cancelled');
    check(jobs.inspect(b.id).status === 'running', 'owner b unaffected');
    let refused = false; try { jobs.start({ ownerId: 'a', run: () => 'wrong' }); } catch { refused = true; }
    check(refused, 'closed owner cannot admit work'); finish.resolve('other'); await jobs.wait(b.id);
  },
  async 'observer failure is recorded without awaiting slow observers'() {
    const never = new Promise<void>(() => {}); const jobs = new JobRegistry();
    jobs.subscribe(() => never); jobs.subscribe(async () => { throw new Error('observer rejected'); });
    const job = jobs.start({ ownerId: 'owner', run: () => 3 }); check((await jobs.wait(job.id)).job.result === 3, 'slow listener did not block');
    await tick(); check(jobs.events().some(event => event.kind === 'observerFailure'), 'failure journaled');
    const count = jobs.events().length; await tick(); check(jobs.events().length === count, 'failures are not recursively broadcast');
  },
  async 'cancel before execution admits no side effects and emits one terminal event'() {
    let ran = false; const jobs = new JobRegistry(); const job = jobs.start({ ownerId: 'owner', run: () => { ran = true; } });
    jobs.cancel(job.id); jobs.cancel(job.id); await jobs.wait(job.id);
    check(!ran, 'execution must not begin after pre-start cancellation');
    check(!jobs.inspect(job.id).executionStarted && !jobs.events().some(event => event.kind === 'started'), 'admission is distinct from execution');
    check(jobs.events()[0]!.kind === 'accepted', 'acceptance was recorded');
    check(jobs.events().filter(event => event.kind === 'cancellationRequested').length === 1, 'cancel idempotent');
  },
  async 'structured input is explicitly advertised and cannot target settled work'() {
    const jobs = new JobRegistry(); const job = jobs.start({ ownerId: 'owner', run: () => 1 });
    let rejected = false; try { jobs.send(job.id, {}); } catch { rejected = true; } check(rejected, 'input capability enforced'); await jobs.wait(job.id);
    const second = jobs.start({ ownerId: 'owner', acceptsInput: true, run: () => 2 }); await jobs.wait(second.id);
    rejected = false; try { jobs.send(second.id, {}); } catch { rejected = true; } check(rejected, 'settled input rejected');
  },
};

export async function runJobCases() {
  const results: { name: string; passed: boolean; error?: string }[] = [];
  for (const [name, run] of Object.entries(jobCases)) {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error) }); }
  }
  return results;
}
