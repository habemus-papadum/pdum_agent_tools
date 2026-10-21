import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import { JobRegistry, type JobContext } from '../../039-hp-agent-runtime/src/jobs/registry.ts';

export interface ExecArgs {
  cmd: string; workdir?: string; shell?: string; login?: boolean; tty?: boolean;
  yield_time_ms?: number; max_output_tokens?: number;
}
export interface StdinArgs { session_id: number; chars?: string; yield_time_ms?: number; max_output_tokens?: number }
export interface ExecResult {
  chunk_id: string; wall_time_seconds: number; output: string;
  session_id?: number; exit_code?: number; termination_signal?: string;
  output_budget_note?: string;
}
interface Session {
  id: number; child: ChildProcessWithoutNullStreams; pending: string; running: boolean;
  exitCode: number; signal?: string; error?: Error; done: Promise<void>;
  bytes: number; jobId: string; context?: JobContext; cleanup?: Promise<void>; waiters: Set<() => void>;
}
const interruptible = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
};
const wait = async (session: Session, milliseconds: number, signal: AbortSignal) => {
  signal.throwIfAborted(); if (!session.running) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake!: () => void;
  try {
    await interruptible(new Promise<void>((resolve) => {
      wake = resolve; session.waiters.add(wake); timer = setTimeout(resolve, milliseconds);
    }), signal);
  } finally { clearTimeout(timer); session.waiters.delete(wake); }
};
const duration = (value: number | undefined, fallback: number, minimum: number, maximum: number) => {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('yield_time_ms must be nonnegative');
  return Math.max(minimum, Math.min(maximum, value ?? fallback));
};

/** Owns only processes it spawned. No timeout or output quota is imposed on command lifetime. */
export class ExecSessions {
  private nextId = 1;
  private readonly active = new Map<number, Session>();
  private readonly groups = new Set<Session>();
  private readonly jobIds = new Set<string>();
  readonly jobs: JobRegistry;
  readonly ownerId: string;
  private closed = false;
  constructor(readonly cwd: string, options: { jobs?: JobRegistry; ownerId?: string } = {}) {
    this.jobs = options.jobs ?? new JobRegistry(); this.ownerId = options.ownerId ?? crypto.randomUUID();
  }
  sessions() { return [...this.active.values()].map((s) => ({ session_id: s.id, job_id: s.jobId, pid: s.child.pid, running: s.running, captured_bytes: s.bytes })); }
  private groupAlive(session: Session): boolean {
    if (!session.child.pid) return false;
    try { process.kill(process.platform === 'win32' ? session.child.pid : -session.child.pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }
  private retire(session: Session): void {
    this.groups.delete(session);
  }
  private terminateGroup(session: Session): Promise<void> {
    if (session.cleanup) return session.cleanup;
    // A leader's close event does not establish that its process group is gone:
    // descendants can redirect their stdio and ignore TERM. Track the owned group
    // independently and discard its ID as soon as disappearance is observed.
    if (!this.groups.has(session) || !this.groupAlive(session)) { this.retire(session); return Promise.resolve(); }
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform === 'win32') session.child.kill(signal); else process.kill(-session.child.pid!, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') session.error = error as Error; }
    };
    kill('SIGTERM');
    session.cleanup = new Promise<void>((resolve) => {
      const escalation = setTimeout(() => {
        clearInterval(monitor);
        if (this.groups.has(session) && this.groupAlive(session)) kill('SIGKILL');
        this.retire(session); resolve();
      }, 250);
      const monitor = setInterval(() => {
        if (this.groupAlive(session)) return;
        clearTimeout(escalation); clearInterval(monitor); this.retire(session); resolve();
      }, 20);
    });
    return session.cleanup;
  }
  async exec(args: ExecArgs, signal: AbortSignal, provenance: { threadId?: string; turnId?: string } = {}): Promise<ExecResult> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('Exec owner is closed');
    if (typeof args.cmd !== 'string' || !args.cmd.trim()) throw new Error('cmd must be nonempty');
    if (args.tty) throw new Error('HP pipe executor does not implement tty:true; use an application PTY adapter');
    const milliseconds = duration(args.yield_time_ms, 10000, 250, 30000);
    const shell = args.shell ?? process.env.SHELL ?? '/bin/sh';
    let ready!: (session: Session) => void;
    const started = new Promise<Session>(resolve => { ready = resolve; });
    const job = this.jobs.start({ ownerId: this.ownerId, ...provenance, name: `exec: ${args.cmd}`, run: async (context) => {
      const child = spawn(shell, [args.login === false ? '-c' : '-lc', args.cmd], {
        cwd: resolve(this.cwd, args.workdir ?? '.'), env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      let completed!: () => void;
      const session: Session = { id: this.nextId++, child, pending: '', running: true, exitCode: -1,
        done: new Promise<void>((r) => { completed = r; }), bytes: 0, jobId: context.id, context, waiters: new Set() };
      this.active.set(session.id, session); this.groups.add(session);
      for (const [stream, channel] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) {
        const decoder = new StringDecoder('utf8');
        const append = (text: string) => {
          if (!text) return;
          session.pending += text; session.bytes += Buffer.byteLength(text); context.output({ channel, text });
        };
        stream.on('data', (chunk: Buffer) => append(decoder.write(chunk)));
        stream.on('end', () => append(decoder.end()));
      }
      child.on('error', (error) => { session.error = error; });
      child.stdin.on('error', () => { /* write() reports a closed-input failure to its caller */ });
      child.on('close', (code, termination) => {
        session.running = false; session.exitCode = code ?? -1;
        if (termination) session.signal = termination;
        if (!this.groupAlive(session)) this.retire(session);
        for (const wake of session.waiters) wake(); session.waiters.clear();
        completed();
      });
      const cancel = () => { void this.terminateGroup(session); };
      context.signal.addEventListener('abort', cancel, { once: true });
      if (context.signal.aborted || this.closed) cancel();
      ready(session);
      try {
        await session.done;
        if (context.signal.aborted) { await this.terminateGroup(session); throw context.signal.reason; }
        if (session.error) throw session.error;
        return { session_id: session.id, exit_code: session.exitCode, ...(session.signal ? { termination_signal: session.signal } : {}) };
      } finally { context.signal.removeEventListener('abort', cancel); }
    } });
    this.jobIds.add(job.id);
    // Cancellation before the execution callback begins creates no process. A
    // started process remains discoverable even if the first caller disappears.
    const session = await Promise.race([started, this.jobs.wait(job.id).then(({ job }) => {
      throw new Error(job.error ?? 'Exec job settled before process startup');
    })]);
    return this.collect(session, milliseconds, signal, args.max_output_tokens);
  }
  async write(args: StdinArgs, signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted();
    const session = this.active.get(args.session_id);
    if (!session) throw new Error(`Unknown or already collected session ${args.session_id}`);
    const chars = args.chars ?? '';
    if (typeof chars !== 'string') throw new Error('chars must be a string');
    const milliseconds = duration(args.yield_time_ms, chars ? 250 : 5000, chars ? 0 : 0, chars ? 30000 : 300000);
    if (chars) {
      if (!session.running || session.child.stdin.destroyed || !session.child.stdin.writable) throw new Error('Session stdin is closed');
      // Cancelling this wait cannot retract bytes already accepted by the pipe.
      await interruptible(new Promise<void>((resolve, reject) => session.child.stdin.write(chars, (error) => error ? reject(error) : resolve())), signal);
    }
    signal.throwIfAborted();
    return this.collect(session, milliseconds, signal, args.max_output_tokens);
  }
  /** Explicit process termination, distinct from cancelling exec/write waiting. */
  async terminate(sessionId: number): Promise<ExecResult> {
    const session = this.active.get(sessionId);
    if (!session) throw new Error(`Unknown or already collected session ${sessionId}`);
    this.jobs.cancel(session.jobId, 'Exec session explicitly terminated');
    await this.terminateGroup(session); await session.done;
    return this.collect(session, 0, new AbortController().signal);
  }
  private async collect(session: Session, milliseconds: number, signal: AbortSignal, maxOutputTokens?: number): Promise<ExecResult> {
    const started = performance.now(); await wait(session, milliseconds, signal);
    signal.throwIfAborted();
    if (session.error) { await this.terminateGroup(session); await session.done; this.active.delete(session.id); throw session.error; }
    const output = session.pending; session.pending = '';
    const result: ExecResult = { chunk_id: crypto.randomUUID(), wall_time_seconds: (performance.now() - started) / 1000, output,
      ...(session.running ? { session_id: session.id } : { exit_code: session.exitCode }),
      ...(session.signal ? { termination_signal: session.signal } : {}),
      ...(maxOutputTokens !== undefined ? { output_budget_note: 'HP returns full captured output; max_output_tokens is advisory in this spike.' } : {}),
    };
    if (!session.running) this.active.delete(session.id);
    return result;
  }
  async close(): Promise<void> {
    this.closed = true;
    const sessions = [...new Set([...this.active.values(), ...this.groups])];
    for (const jobId of this.jobIds) this.jobs.cancel(jobId, 'Exec owner closed');
    await Promise.all(sessions.map((session) => this.terminateGroup(session)));
    await Promise.all(sessions.map((session) => session.done));
    // All stream data has drained by close. Registry events retain it even when
    // no caller remains to consume a final exec result.
    this.active.clear();
  }
}
