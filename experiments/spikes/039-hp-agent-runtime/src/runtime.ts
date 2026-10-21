import type { ModelConnector, ModelEvent, NativeItem } from '../../038-hp-sdk-fit/src/connector.ts';
import { AgentControl, type WaitBounds } from './agent/control.ts';
import { TurnInputQueue, type InputRecord } from './session/input-queue.ts';
import type { ActiveTurn, SessionServices } from './session/state.ts';
import { executeTurn } from './session/turn.ts';
import { JobRegistry, type JobSpec, type JobSnapshot } from './jobs/registry.ts';

export type Json = Record<string, unknown>;
export interface Item extends Json { id: string; type: string }
export interface Turn extends Json {
  id: string; rootTurnId: string; items: Item[]; itemsView: 'full';
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
  error: Json | null; startedAt: number; completedAt: number | null; durationMs: number | null;
}
export interface Thread extends Json {
  id: string; sessionId: string; parentThreadId: string | null; forkedFromId: string | null;
  model: string; cwd: string; turns: Turn[]; preview: string; createdAt: number; updatedAt: number;
}
export interface Notification { method: string; params: Json }
export interface Tool {
  definition: NativeItem;
  /** Opt in to shared batch admission. Omitted/false handlers run exclusively. */
  supportsParallel?: boolean;
  execute(argumentsText: string, context: { runtime: AgentRuntime; threadId: string; turnId: string; signal: AbortSignal }): Promise<string>;
}
export interface SavedThread {
  thread: Thread; context: NativeItem[]; inheritedTurnIds: string[];
  inputRecords?: InputRecord[];
  contextCheckpoints: { afterTurnId: string | null; reason: string; input: NativeItem[]; ts: string }[];
}
export interface JournalEntry { seq: number; ts: string; kind: string; data: Json }
export interface UsageRecord { threadId: string; turnId: string; ts: string; usage: Extract<ModelEvent, { type: 'usage' }> }
export interface RuntimeOptions {
  connector: ModelConnector; model?: string; instructions?: string; tools?: Tool[];
  /** Application-owned jobs may also be shared with native host adapters. */
  jobs?: JobRegistry;
  waitBounds?: WaitBounds;
  /** Request preparation hook, awaited deliberately; prompt composition can attach a snapshot here. Not an observer hook. */
  beforeModel?: (args: { threadId: string; turnId: string; input: NativeItem[]; instructions: string; tools: NativeItem[]; model: string }) => void | Promise<void>;
}
const copy = <T>(value: T): T => structuredClone(value);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const newId = () => crypto.randomUUID();
export const textInput = (text: string): NativeItem => ({ role: 'user', content: [{ type: 'input_text', text }] });

/** Experimental execution owner; no network, credential, filesystem or UI imports. */
export class AgentRuntime {
  readonly runId = newId();
  readonly jobs: JobRegistry;
  readonly journal: JournalEntry[] = [];
  readonly usages: UsageRecord[] = [];
  private readonly threads = new Map<string, SavedThread>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly inputs = new Map<string, InputRecord[]>();
  private readonly control: AgentControl;
  private readonly listeners = new Set<(event: Notification) => void>();
  private readonly tools = new Map<string, Tool>();
  private readonly detachJobs: () => void;
  private disposed = false;
  constructor(readonly options: RuntimeOptions) {
    this.jobs = options.jobs ?? new JobRegistry();
    this.control = new AgentControl({ read: (id) => this.read(id), list: () => this.list(), active: (id) => this.active.get(id),
      isClosed: () => this.disposed,
      startMailbox: (id) => this.startInternal(id), wait: (id) => this.wait(id), accepted: (record) => {
        this.record('mailboxAccepted', { ...record }); this.emit('hp/agent/mailbox', { ...record }); this.checkpoint(this.saved(record.threadId));
      }, changed: (record) => { this.emit('hp/input/outcome', { ...record }); this.checkpoint(this.saved(record.threadId)); } }, options.waitBounds);
    for (const tool of options.tools ?? []) this.tools.set(String(tool.definition.name), tool);
    this.detachJobs = this.jobs.subscribe(event => {
      // A shared host registry can contain jobs belonging to another runtime.
      if (event.threadId && !this.threads.has(event.threadId)) return;
      this.emit('hp/job/event', { ...event });
      if (!event.threadId || !['completed', 'failed', 'cancelled'].includes(event.kind)) return;
      const text = `Job ${event.jobId} (${this.jobs.inspect(event.jobId).name}) ${event.kind}. Inspect the job for its result and output.`;
      const record = this.control.mailboxes.enqueue(null, event.threadId, text, 'jobCompletion');
      record.jobId = event.jobId;
      this.record('jobCompletionAccepted', { ...record });
      this.emit('hp/input/outcome', { ...record }); this.checkpoint(this.saved(event.threadId));
    });
    this.record('runtimeStarted', { runId: this.runId, runtime: 'hp-agent-spike-039' });
  }
  subscribe(listener: (event: Notification) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private record(kind: string, data: Json): void {
    this.journal.push({ seq: this.journal.length + 1, ts: new Date().toISOString(), kind, data: copy(data) });
  }
  private emit(method: string, params: Json): void {
    const event = { method, params: copy(params) };
    this.record('notification', event);
    for (const listener of this.listeners) queueMicrotask(() => {
      if (!this.listeners.has(listener)) return;
      try { void Promise.resolve(listener(copy(event))).catch(error => {
        this.record('observerFailure', { method, error: String(error) });
      }); }
      catch (error) { this.record('observerFailure', { method, error: String(error) }); }
    });
  }
  private saved(threadId: string): SavedThread {
    const saved = this.threads.get(threadId);
    if (!saved) throw new Error(`Unknown thread ${threadId}`);
    return saved;
  }
  private assertOpen(): void { if (this.disposed) throw new Error('Runtime is disposed'); }
  /** Stop runtime work, request cancellation of its own jobs, and detach shared-host observation. */
  dispose(): JobSnapshot[] {
    if (!this.disposed) {
      this.disposed = true;
      for (const [id, active] of this.active) {
        active.controller.abort(new Error('Runtime disposed'));
        this.options.connector.discardThread?.(id);
      }
      this.detachJobs(); this.listeners.clear();
      this.record('runtimeDisposed', { runId: this.runId });
    }
    // Host adapters with a different owner remain the host's explicit cleanup responsibility.
    return this.jobs.closeOwner(this.runId);
  }
  private checkpoint(saved: SavedThread): void { saved.inputRecords = this.inspectInputs(saved.thread.id); this.record('threadSnapshot', saved as unknown as Json); }
  create(options: { model?: string; cwd?: string; parentThreadId?: string } = {}): Thread {
    return this.createThread(options, true);
  }
  private createThread(options: { model?: string; cwd?: string; parentThreadId?: string }, notify: boolean): Thread {
    this.assertOpen();
    const id = newId(); const now = nowSeconds();
    const parent = options.parentThreadId ? this.saved(options.parentThreadId).thread : null;
    const thread: Thread = {
      id, sessionId: parent?.sessionId ?? id, parentThreadId: parent?.id ?? null, forkedFromId: null,
      model: options.model ?? parent?.model ?? this.options.model ?? 'gpt-6-luna', cwd: options.cwd ?? parent?.cwd ?? '/',
      turns: [], preview: '', createdAt: now, updatedAt: now, environments: null, extra: null,
      ephemeral: true, section: null, sectionEnteredAt: null, projectId: null, historyMode: 'legacy',
      modelProvider: 'openai', reasoningEffort: null, recencyAt: now, status: { type: 'idle' },
      path: null, cliVersion: 'hp-agent-spike-039', originator: 'hp-agent-spike', source: 'appServer',
      canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null,
      gitInfo: null, name: null, daybreakEnabled: null,
    };
    const saved = { thread, context: [], inheritedTurnIds: [], contextCheckpoints: [] };
    this.threads.set(id, saved);
    if (notify) { this.checkpoint(saved); this.emit('thread/started', { thread: this.read(id, false) }); }
    return copy(thread);
  }
  read(threadId: string, includeTurns = true): Thread {
    const thread = copy(this.saved(threadId).thread);
    if (!includeTurns) thread.turns = [];
    return thread;
  }
  list(): Thread[] { return [...this.threads.keys()].map((id) => this.read(id, false)); }
  context(threadId: string): NativeItem[] { return copy(this.saved(threadId).context); }
  snapshots(): SavedThread[] { return [...this.threads.values()].map((saved) => copy({ ...saved, inputRecords: this.inspectInputs(saved.thread.id) })); }
  inspectInputs(threadId: string): InputRecord[] { this.saved(threadId); return copy([...(this.inputs.get(threadId) ?? []), ...this.control.mailboxes.all(threadId)]); }
  /** Start an application computation; turn interruption only stops its waiter. */
  startJob(threadId: string, spec: Omit<JobSpec, 'ownerId' | 'threadId' | 'turnId'> & { turnId?: string }): JobSnapshot {
    this.assertOpen();
    this.saved(threadId);
    const turnId = spec.turnId ?? this.active.get(threadId)?.turn.id;
    return this.jobs.start({ ...spec, ownerId: this.runId, threadId, ...(turnId ? { turnId } : {}) });
  }
  agentPath(threadId: string): string { return this.control.path(threadId); }
  fork(threadId: string): Thread {
    if (this.active.has(threadId)) throw new Error('Prototype forks only at a completed turn boundary');
    const parent = this.saved(threadId);
    const child = this.createThread({ model: parent.thread.model, cwd: parent.thread.cwd }, false);
    const saved = this.saved(child.id);
    saved.thread.forkedFromId = threadId; saved.thread.sessionId = parent.thread.sessionId;
    saved.thread.turns = copy(parent.thread.turns); saved.thread.preview = parent.thread.preview;
    saved.context = copy(parent.context); saved.inheritedTurnIds = parent.thread.turns.map((turn) => turn.id);
    saved.contextCheckpoints = copy(parent.contextCheckpoints);
    this.checkpoint(saved); this.emit('thread/started', { thread: this.read(child.id, false) }); return this.read(child.id);
  }
  /** Explicit context replacement, not model-generated compaction. History remains intact. */
  replaceContext(threadId: string, input: NativeItem[], reason: string): void {
    this.assertOpen();
    if (this.active.has(threadId)) throw new Error('Context replacement requires an idle thread');
    const saved = this.saved(threadId);
    saved.contextCheckpoints.push({ afterTurnId: saved.thread.turns.at(-1)?.id ?? null, reason, input: copy(input), ts: new Date().toISOString() });
    saved.context = copy(input); this.checkpoint(saved);
  }
  private addUser(saved: SavedThread, turn: Turn, text: string): NativeItem {
    const item: Item = { id: newId(), type: 'userMessage', clientId: null, content: [{ type: 'text', text, text_elements: [] }] };
    turn.items.push(item); this.emit('item/started', { threadId: saved.thread.id, turnId: turn.id, item, startedAtMs: Date.now() });
    this.emit('item/completed', { threadId: saved.thread.id, turnId: turn.id, item, completedAtMs: Date.now() });
    return textInput(text);
  }
  start(threadId: string, text: string): Turn {
    return this.startInternal(threadId, text);
  }
  private startInternal(threadId: string, text?: string): Turn {
    this.assertOpen();
    const saved = this.saved(threadId);
    if (this.active.has(threadId)) throw new Error('Prototype requires explicit steer while a turn is active');
    const id = newId(); const started = Date.now();
    const turn: Turn = { id, rootTurnId: id, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: nowSeconds(), completedAt: null, durationMs: null };
    saved.thread.turns.push(turn); saved.thread.preview ||= text ?? ''; saved.thread.status = { type: 'active', activeFlags: [] };
    let resolve!: (turn: Turn) => void;
    const done = new Promise<Turn>((r) => { resolve = r; });
    const active: ActiveTurn = { turn, controller: new AbortController(), ready: false, phase: 'preparing', mailboxMode: 'current', calls: new Map(), included: [], input: new TurnInputQueue(this.control.mailboxes.activity(threadId)), done, resolve };
    this.active.set(threadId, active); this.emit('turn/started', { threadId, turn });
    if (text !== undefined) saved.context.push(this.addUser(saved, turn, text)); this.checkpoint(saved);
    // Let the RPC acknowledgement be sent independently of execution.
    setTimeout(() => { void executeTurn(this.sessionServices(), saved, active, started); }, 0);
    return copy(turn);
  }
  async steer(threadId: string, expectedTurnId: string, text: string): Promise<{ turnId: string }> {
    this.assertOpen();
    const active = this.active.get(threadId);
    if (!active || active.turn.id !== expectedTurnId) throw new Error('Active turn does not match expectedTurnId');
    if (active.controller.signal.aborted || active.phase === 'finishing') throw new Error('Turn no longer accepts steering');
    active.mailboxMode = 'current'; // Explicit same-turn input reopens mailbox delivery.
    const saved = this.saved(threadId); const record = active.input.accept(threadId, active.turn.id, text);
    const records = this.inputs.get(threadId) ?? []; records.push(record); this.inputs.set(threadId, records);
    this.record('inputAccepted', { ...record });
    if (active.run && active.ready && (!active.run.status || active.run.status === 'running')) {
      await this.dispatchSteer(active, record);
      this.addUser(saved, active.turn, text);
    } else {
      this.addUser(saved, active.turn, text); this.emit('hp/input/queued', { ...record });
    }
    this.checkpoint(saved); return { turnId: active.turn.id };
  }
  interrupt(threadId: string, turnId: string, options: { scope?: 'thread' | 'subtree' } = {}) {
    const active = this.active.get(threadId);
    if (!active || active.turn.id !== turnId) throw new Error('Active turn does not match turnId');
    const ids = [threadId, ...(options.scope === 'subtree' ? this.control.descendants(threadId) : [])];
    const affected = ids.map((id) => {
      const current = this.active.get(id); if (current) current.controller.abort(new Error('Interrupted by client'));
      return { threadId: id, turnId: current?.turn.id ?? null, status: current ? 'signalled' : 'idle' };
    });
    this.record('interruptRequested', { threadId, turnId, scope: options.scope ?? 'thread', affected });
    return { scope: options.scope ?? 'thread', affected };
  }
  async wait(threadId: string): Promise<Turn | null> {
    const active = this.active.get(threadId);
    return active ? copy(await active.done) : copy(this.saved(threadId).thread.turns.at(-1) ?? null);
  }
  spawn(parentThreadId: string, prompt: string): { threadId: string; turnId: string } {
    const child = this.create({ parentThreadId, model: this.saved(parentThreadId).thread.model });
    const turn = this.start(child.id, prompt); return { threadId: child.id, turnId: turn.id };
  }
  async message(threadId: string, text: string): Promise<{ turnId: string }> {
    const active = this.active.get(threadId);
    return active ? this.steer(threadId, active.turn.id, text) : { turnId: this.start(threadId, text).id };
  }
  sendMessage(senderId: string, target: string, text: string) { this.assertOpen(); return this.control.send(senderId, target, text, false); }
  followupTask(senderId: string, target: string, text: string) { this.assertOpen(); return this.control.send(senderId, target, text, true); }
  waitAgent(callerId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) { return this.control.waitAgent(callerId, options); }
  waitForChild(callerId: string, childId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) { return this.control.waitForChild(callerId, childId, options); }
  interruptAgent(callerId: string, target: string) {
    const id = this.control.resolve(callerId, target); const previous = this.read(id);
    if (!previous.parentThreadId) throw new Error('Root is not a spawned agent');
    if (id === callerId) throw new Error('An agent cannot interrupt itself');
    const active = this.active.get(id); if (active) this.interrupt(id, active.turn.id);
    return { threadId: id, previousStatus: previous.status, requested: Boolean(active) };
  }
  private async dispatchSteer(active: ActiveTurn, input: InputRecord): Promise<void> {
    if (!active.run) return;
    input.state = 'sent';
    try {
      const receipt = await active.run.steer(input.text);
      if (receipt) input.receiptId = receipt.receiptId;
    } catch (error) {
      const receipt = (error as { receipt?: { receiptId: string; state: string } })?.receipt;
      input.state = receipt?.state === 'unknown' ? 'uncommitted' : 'failed';
      if (receipt) input.receiptId = receipt.receiptId;
      input.detail = String(error); this.emit('hp/input/outcome', { ...input }); throw error;
    }
  }
  private sessionServices(): SessionServices {
    return { owner: this, options: this.options, tools: this.tools,
      record: (kind, data) => this.record(kind, data), emit: (method, params) => this.emit(method, params), checkpoint: (saved) => this.checkpoint(saved),
      drain: (saved, active) => {
        for (const input of active.input.pending()) {
          input.state = 'included'; const item = textInput(input.text); saved.context.push(item); active.included.push({ record: input, item });
          this.emit('hp/input/outcome', { ...input });
        }
        for (const mail of active.mailboxMode === 'current' ? this.control.mailboxes.take(saved.thread.id, active.turn.id) : []) {
          const text = mail.kind === 'jobCompletion' ? `[Background job completion]\n${mail.text}`
            : `[Agent ${mail.kind} from ${this.agentPath(mail.senderId!)}]\n${mail.text}`;
          const item = this.addUser(saved, active.turn, text); saved.context.push(item); active.included.push({ record: mail, item });
          this.emit('hp/input/outcome', { ...mail });
        }
      },
      hasPending: (id, active) => active.input.pending().length > 0 || (active.mailboxMode === 'current' && this.control.mailboxes.pending(id).length > 0),
      answerBoundary: (saved, active) => {
        const explicit = active.input.records.some((input) => input.state === 'queued' || input.state === 'sent')
          || this.control.mailboxes.pending(saved.thread.id).some((input) => input.kind === 'followup');
        if (!explicit) { active.mailboxMode = 'next'; this.record('mailboxBoundary', { threadId: saved.thread.id, turnId: active.turn.id, mode: 'next' }); }
      },
      ready: async (_saved, active) => { for (const input of active.input.pending()) {
        try { await this.dispatchSteer(active, input); } catch { /* explicit failure is recorded; no automatic retry */ }
      } },
      inputCommitted: (active, item, receiptId) => {
        const text = typeof item.content === 'string' ? item.content : Array.isArray(item.content) ? item.content.map((part) => part.text ?? '').join('') : '';
        const record = active.input.records.find((entry) => entry.state === 'sent' && (receiptId && entry.receiptId ? entry.receiptId === receiptId : entry.text === text));
        if (record) { record.state = 'committed'; this.emit('hp/input/outcome', { ...record }); }
      },
      inclusionCommitted: (active) => {
        for (const { record } of active.included.splice(0)) { record.state = 'committed'; this.emit('hp/input/outcome', { ...record }); }
      },
      inclusionFailed: (saved, active) => {
        for (const { record, item } of active.included.splice(0)) {
          const index = saved.context.indexOf(item); if (index !== -1) saved.context.splice(index, 1);
          record.state = 'uncommitted'; record.detail = 'Request never confirmed input inclusion; removed from future context'; this.emit('hp/input/outcome', { ...record });
        }
      },
      steeringEvent: (active, event) => {
        const record = event.receiptId ? active.input.records.find((input) => input.receiptId === event.receiptId)
          : active.input.records.find((input) => input.state === 'sent');
        if (!record) return;
        record.providerState = event.state;
        if (event.state === 'failed') { record.state = 'failed'; record.detail = JSON.stringify(event.detail ?? {}); }
        // Input insertion itself, not a lifecycle notification, marks committed context.
        this.emit('hp/input/outcome', { ...record });
      },
      usage: (threadId, turnId, usage) => this.usages.push({ threadId, turnId, usage, ts: new Date().toISOString() }),
      finish: (saved, active, started) => {
        active.turn.completedAt = nowSeconds(); active.turn.durationMs = Date.now() - started;
        saved.thread.updatedAt = nowSeconds(); saved.thread.status = { type: 'idle' }; this.active.delete(saved.thread.id);
        this.checkpoint(saved); this.emit('turn/completed', { threadId: saved.thread.id, turn: active.turn });
        this.control.complete(saved.thread, active.turn); active.resolve(copy(active.turn));
      },
    };
  }

}

/** Offline state reconstruction does not instantiate a runtime or connector. */
export function replay(entries: JournalEntry[]): SavedThread[] {
  const threads = new Map<string, SavedThread>();
  for (const entry of entries) if (entry.kind === 'threadSnapshot') {
    const saved = entry.data as unknown as SavedThread; threads.set(saved.thread.id, copy(saved));
  }
  return [...threads.values()];
}
