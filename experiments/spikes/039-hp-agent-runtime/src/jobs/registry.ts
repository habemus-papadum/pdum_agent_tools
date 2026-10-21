/** Portable execution ownership. No process, framework, provider or UI dependency. */
export type JobStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export interface JobProvenance { ownerId: string; threadId?: string; turnId?: string }
export interface JobSnapshot extends JobProvenance {
  id: string; name: string; status: JobStatus; acceptsInput: boolean;
  executionStarted: boolean;
  createdAt: string; completedAt: string | null; cancellationRequested: boolean;
  pendingInputs: number; result?: unknown; error?: string;
}
export type JobEventKind = 'accepted' | 'started' | 'output' | 'progress' | 'inputAccepted' | 'inputDelivered'
  | 'cancellationRequested' | 'completed' | 'failed' | 'cancelled' | 'observerFailure';
export interface JobEvent extends JobProvenance {
  seq: number; ts: string; jobId: string; kind: JobEventKind; data: Record<string, unknown>;
}
export interface JobContext {
  id: string; signal: AbortSignal;
  output(value: unknown): void;
  progress(value: unknown): void;
  /** Structured input is FIFO; it exists only when the job advertises acceptsInput. */
  nextInput(): Promise<unknown>;
}
export interface JobSpec extends JobProvenance {
  name?: string; acceptsInput?: boolean;
  run(context: JobContext): unknown | Promise<unknown>;
}
export interface JobWaitResult { status: 'settled' | 'timeout'; job: JobSnapshot }
interface Entry {
  snapshot: JobSnapshot; controller: AbortController; input: unknown[];
  readers: { resolve(value: unknown): void; reject(reason: unknown): void }[];
  settled: Set<() => void>;
}
const copy = <T>(value: T): T => structuredClone(value);
const terminal = (status: JobStatus) => status === 'completed' || status === 'failed' || status === 'cancelled';

/**
 * Registry lifetime is independent of any turn or waiter. Cancellation is a
 * request: an uncooperative task stays cancelling until its actual settlement.
 * Values must be structured-cloneable so the same contract can cross a Worker.
 */
export class JobRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly journal: JobEvent[] = [];
  private readonly listeners = new Set<(event: JobEvent) => void | Promise<void>>();
  private readonly closedOwners = new Set<string>();
  private closed = false;
  constructor(options: { onEvent?: (event: JobEvent) => void | Promise<void> } = {}) {
    if (options.onEvent) this.listeners.add(options.onEvent);
  }
  subscribe(listener: (event: JobEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private entry(id: string): Entry {
    const entry = this.entries.get(id); if (!entry) throw new Error(`Unknown job ${id}`); return entry;
  }
  private event(entry: Entry, kind: JobEventKind, data: Record<string, unknown>, notify = true): void {
    const { ownerId, threadId, turnId, id } = entry.snapshot;
    const event: JobEvent = {
      seq: this.journal.length + 1, ts: new Date().toISOString(), jobId: id, ownerId, kind, data: copy(data),
      ...(threadId === undefined ? {} : { threadId }), ...(turnId === undefined ? {} : { turnId }),
    };
    this.journal.push(event);
    if (!notify) return;
    // Observers never delay execution. Observer failures are recorded but not
    // re-broadcast, avoiding an infinite failure-reporting loop.
    for (const listener of this.listeners) queueMicrotask(() => {
      if (!this.listeners.has(listener)) return;
      try { void Promise.resolve(listener(copy(event))).catch(error => {
        this.event(entry, 'observerFailure', { eventSeq: event.seq, error: String(error) }, false);
      }); } catch (error) { this.event(entry, 'observerFailure', { eventSeq: event.seq, error: String(error) }, false); }
    });
  }
  inspect(id: string): JobSnapshot {
    const entry = this.entry(id); return copy({ ...entry.snapshot, pendingInputs: entry.input.length });
  }
  list(filter: { ownerId?: string; threadId?: string } = {}): JobSnapshot[] {
    return [...this.entries.values()].filter(({ snapshot }) =>
      (filter.ownerId === undefined || snapshot.ownerId === filter.ownerId)
      && (filter.threadId === undefined || snapshot.threadId === filter.threadId)).map(({ snapshot }) => this.inspect(snapshot.id));
  }
  events(filter: { jobId?: string; afterSeq?: number } = {}): JobEvent[] {
    return copy(this.journal.filter(event => (filter.jobId === undefined || event.jobId === filter.jobId)
      && event.seq > (filter.afterSeq ?? 0)));
  }
  start(spec: JobSpec): JobSnapshot {
    if (this.closed || this.closedOwners.has(spec.ownerId)) throw new Error(`Job owner is closed: ${spec.ownerId}`);
    if (!spec.ownerId) throw new Error('ownerId must be nonempty');
    const id = crypto.randomUUID();
    const snapshot: JobSnapshot = {
      id, ownerId: spec.ownerId, ...(spec.threadId === undefined ? {} : { threadId: spec.threadId }),
      ...(spec.turnId === undefined ? {} : { turnId: spec.turnId }), name: spec.name ?? 'async task',
      status: 'running', acceptsInput: spec.acceptsInput ?? false, createdAt: new Date().toISOString(),
      executionStarted: false, completedAt: null, cancellationRequested: false, pendingInputs: 0,
    };
    const entry: Entry = { snapshot, controller: new AbortController(), input: [], readers: [], settled: new Set() };
    this.entries.set(id, entry); this.event(entry, 'accepted', { job: snapshot });
    const context: JobContext = {
      id, signal: entry.controller.signal,
      output: value => this.event(entry, 'output', { value, afterCancellation: entry.controller.signal.aborted, afterSettlement: terminal(snapshot.status) }),
      progress: value => this.event(entry, 'progress', { value, afterCancellation: entry.controller.signal.aborted, afterSettlement: terminal(snapshot.status) }),
      nextInput: async () => {
        if (!snapshot.acceptsInput) throw new Error('Job does not accept structured input');
        entry.controller.signal.throwIfAborted();
        if (terminal(snapshot.status)) throw new Error('Job has settled');
        if (entry.input.length) {
          const value = entry.input.shift(); this.event(entry, 'inputDelivered', { value }); return copy(value);
        }
        return new Promise<unknown>((resolve, reject) => { entry.readers.push({ resolve, reject }); });
      },
    };
    // Starting is an acknowledgement; execution and even synchronous errors are
    // delivered through the registry rather than thrown after partial admission.
    void Promise.resolve().then(async () => {
      try {
        context.signal.throwIfAborted();
        snapshot.executionStarted = true; this.event(entry, 'started', {});
        snapshot.result = copy(await spec.run(context));
        snapshot.status = 'completed';
        this.event(entry, 'completed', { result: snapshot.result, afterCancellation: context.signal.aborted });
      } catch (error) {
        snapshot.status = context.signal.aborted && error === context.signal.reason ? 'cancelled' : 'failed';
        snapshot.error = String(error);
        this.event(entry, snapshot.status, { error: snapshot.error, afterCancellation: context.signal.aborted });
      } finally {
        snapshot.completedAt = new Date().toISOString();
        for (const reader of entry.readers.splice(0)) reader.reject(new Error('Job has settled'));
        for (const resolve of entry.settled) resolve();
        entry.settled.clear();
      }
    });
    return this.inspect(id);
  }
  send(id: string, value: unknown): JobSnapshot {
    const entry = this.entry(id); const { snapshot } = entry;
    if (!snapshot.acceptsInput) throw new Error('Job does not accept structured input');
    if (snapshot.status !== 'running') throw new Error(`Job does not accept input while ${snapshot.status}`);
    const input = copy(value); this.event(entry, 'inputAccepted', { value: input });
    const reader = entry.readers.shift();
    if (reader) { this.event(entry, 'inputDelivered', { value: input }); reader.resolve(input); }
    else entry.input.push(input);
    return this.inspect(id);
  }
  cancel(id: string, reason = 'Job cancellation requested'): JobSnapshot {
    const entry = this.entry(id); const { snapshot } = entry;
    if (terminal(snapshot.status) || snapshot.cancellationRequested) return this.inspect(id);
    snapshot.cancellationRequested = true; snapshot.status = 'cancelling';
    this.event(entry, 'cancellationRequested', { reason });
    entry.controller.abort(new Error(reason));
    for (const reader of entry.readers.splice(0)) reader.reject(entry.controller.signal.reason);
    return this.inspect(id);
  }
  async wait(id: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JobWaitResult> {
    const entry = this.entry(id); const { signal, timeoutMs } = options;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new Error('timeoutMs must be finite and nonnegative');
    signal?.throwIfAborted();
    if (terminal(entry.snapshot.status)) return { status: 'settled', job: this.inspect(id) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let settled: (() => void) | undefined;
    try {
      const status = await new Promise<'settled' | 'timeout'>((resolve, reject) => {
        settled = () => resolve('settled'); entry.settled.add(settled);
        if (timeoutMs !== undefined) timer = setTimeout(() => resolve('timeout'), timeoutMs);
        if (signal) { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
      });
      return { status, job: this.inspect(id) };
    } finally {
      clearTimeout(timer); if (signal && abort) signal.removeEventListener('abort', abort);
      if (settled) entry.settled.delete(settled);
    }
  }
  /** Prevent new work and request cancellation. Uncooperative jobs remain inspectable. */
  closeOwner(ownerId: string): JobSnapshot[] {
    this.closedOwners.add(ownerId);
    return this.list({ ownerId }).map(job => this.cancel(job.id, `Job owner closed: ${ownerId}`));
  }
  close(): JobSnapshot[] {
    this.closed = true; return this.list().map(job => this.cancel(job.id, 'Job registry closed'));
  }
}
