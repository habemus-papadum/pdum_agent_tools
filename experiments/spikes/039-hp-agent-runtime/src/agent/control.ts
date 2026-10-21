import type { Thread, Turn } from '../runtime.ts';
import type { ActiveTurn } from '../session/state.ts';
import type { Activity, InputRecord } from '../session/input-queue.ts';
import { AgentMailboxes } from './mailbox.ts';

export interface WaitBounds { minMs: number; maxMs: number; defaultMs: number }
export interface WaitResult { message: string; timed_out: boolean; reason: Activity | 'timeout'; warning?: string }
export interface ControlHost {
  read(id: string): Thread; list(): Thread[]; active(id: string): ActiveTurn | undefined;
  isClosed?(): boolean;
  startMailbox(id: string): Turn; wait(id: string): Promise<Turn | null>;
  accepted(record: InputRecord): void;
  changed(record: InputRecord): void;
}
/** Tree routing and mailbox wake mode; it never owns a second model loop. */
export class AgentControl {
  readonly mailboxes = new AgentMailboxes();
  constructor(readonly host: ControlHost, readonly bounds: WaitBounds = { minMs: 10000, maxMs: 3600000, defaultMs: 30000 }) {
    if (![bounds.minMs, bounds.maxMs, bounds.defaultMs].every((v) => Number.isInteger(v) && v >= 0)
      || bounds.maxMs > 3600000 || bounds.minMs > bounds.maxMs || bounds.defaultMs < bounds.minMs || bounds.defaultMs > bounds.maxMs) throw new Error('Invalid wait bounds');
  }
  path(id: string): string {
    const thread = this.host.read(id);
    return thread.parentThreadId ? `${this.path(thread.parentThreadId)}/agent_${id.slice(0, 8)}` : '/root';
  }
  resolve(caller: string, target: string): string {
    this.host.read(caller);
    const direct = this.host.list().find((thread) => thread.id === target); if (direct) return direct.id;
    let root = this.host.read(caller); while (root.parentThreadId) root = this.host.read(root.parentThreadId);
    const family = (id: string): string => { const thread = this.host.read(id); return thread.parentThreadId ? family(thread.parentThreadId) : id; };
    const match = this.host.list().find((thread) => family(thread.id) === root.id && this.path(thread.id) === target);
    if (!match) throw new Error(`Unknown agent target ${target}`); return match.id;
  }
  send(sender: string, target: string, text: string, trigger: boolean) {
    if (!text.trim()) throw new Error('Agent message cannot be blank');
    const threadId = this.resolve(sender, target);
    if (trigger && !this.host.read(threadId).parentThreadId) throw new Error('followup_task cannot start the root agent');
    const active = this.host.active(threadId);
    const record = this.mailboxes.enqueue(sender, threadId, text, trigger ? 'followup' : 'message');
    if (active?.mailboxMode === 'current') record.turnId = active.turn.id;
    this.host.accepted(record);
    let turnId = active?.turn.id ?? null;
    let state: 'queued' | 'started' = 'queued';
    if (trigger && !active) { turnId = this.host.startMailbox(threadId).id; state = 'started'; }
    else if (trigger && (active?.phase === 'finishing' || active?.mailboxMode === 'next')) {
      // Input arriving beyond the answer boundary starts another turn after finalization.
      void active.done.then(() => { if (!this.host.isClosed?.() && !this.host.active(threadId) && this.mailboxes.pending(threadId).some((m) => m.kind === 'followup')) this.host.startMailbox(threadId); });
    }
    return { messageId: record.id, threadId, turnId, state };
  }
  complete(thread: Thread, turn: Turn): void {
    if (turn.status === 'interrupted' || turn.status === 'failed') {
      for (const record of this.mailboxes.pending(thread.id)) if (record.kind === 'followup' && record.turnId === turn.id) {
        record.state = 'uncommitted'; record.detail = 'Target turn ended before pending followup was included; never automatically replayed'; this.host.changed(record);
      }
    }
    if (!thread.parentThreadId) return;
    const answer = turn.items.filter((item) => item.type === 'agentMessage').map((item) => item.text).join('\n');
    const text = `Child turn ${turn.id} ${turn.status}.\n${answer || String(turn.error?.message ?? '')}`;
    const record = this.mailboxes.enqueue(thread.id, thread.parentThreadId, text, 'completion');
    this.host.accepted(record); // Queue-only even when the parent is idle.
  }
  pendingKind(caller: string): Activity | null {
    if (this.host.active(caller)?.input.pending().length) return 'steer';
    return this.mailboxes.pending(caller).length ? 'mailbox' : null;
  }
  async waitAgent(caller: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    this.host.read(caller);
    const requested = options.timeoutMs ?? this.bounds.defaultMs;
    if (!Number.isInteger(requested) || requested < 0 || requested > this.bounds.maxMs) throw new Error('wait_agent timeout exceeds configured bounds');
    const timeoutMs = Math.max(requested, this.bounds.minMs);
    const reason = await this.mailboxes.activity(caller).wait(() => this.pendingKind(caller), { ...options, timeoutMs });
    return { message: reason === 'mailbox' ? 'Wait completed.' : reason === 'steer' ? 'Wait interrupted by new input.' : 'Wait timed out.',
      timed_out: reason === 'timeout', reason, ...(timeoutMs !== requested ? { warning: `Requested ${requested}ms; clamped to configured minimum ${timeoutMs}ms` } : {}) };
  }
  async waitForChild(caller: string, child: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Turn | null | WaitResult> {
    options.signal?.throwIfAborted();
    this.host.read(caller); const target = this.resolve(caller, child);
    if (caller === target) throw new Error('An agent cannot wait for itself');
    if (!this.host.active(target)) return this.host.wait(target);
    const local = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
    const activity = this.mailboxes.activity(caller).wait(() => this.pendingKind(caller), { signal, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    try {
      return await Promise.race([this.host.wait(target), activity.then((reason) => ({ message: reason === 'timeout' ? 'Wait timed out.' : 'Wait interrupted by new input.', timed_out: reason === 'timeout', reason }))]);
    } finally { local.abort(new Error('Wait scope finished')); }
  }
  descendants(id: string): string[] {
    return this.host.list().filter((thread) => thread.parentThreadId === id).flatMap((child) => [child.id, ...this.descendants(child.id)]);
  }
}
