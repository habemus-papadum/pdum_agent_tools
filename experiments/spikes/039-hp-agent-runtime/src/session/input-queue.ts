/** Session input acceptance and wakeups, separate from provider steering transport. */
export type InputKind = 'steer' | 'message' | 'followup' | 'completion' | 'jobCompletion';
export interface InputRecord {
  id: string; kind: InputKind; text: string; threadId: string; turnId: string | null;
  senderId: string | null; state: 'queued' | 'included' | 'sent' | 'committed' | 'failed' | 'uncommitted';
  receiptId?: string; providerState?: string; detail?: string;
  jobId?: string;
}
export type Activity = 'steer' | 'mailbox';
export class InputActivity {
  private listeners = new Set<(kind: Activity) => void>();
  notify(kind: Activity): void { for (const listener of this.listeners) listener(kind); }
  subscribe(listener: (kind: Activity) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  wait(pending: () => Activity | null, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Activity | 'timeout'> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (kind: Activity | 'timeout') => { cleanup(); resolve(kind); };
      const abort = () => { cleanup(); reject(options.signal?.reason ?? new Error('Wait interrupted')); };
      const unsubscribe = this.subscribe(finish);
      const cleanup = () => { unsubscribe(); clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      // Subscribe before checking retained input, avoiding the message-before-wait race.
      const kind = pending(); if (kind) { finish(kind); return; }
      if (options.timeoutMs !== undefined) timer = setTimeout(() => finish('timeout'), options.timeoutMs);
    });
  }
}
export class TurnInputQueue {
  readonly records: InputRecord[] = [];
  constructor(readonly activity: InputActivity) {}
  accept(threadId: string, turnId: string, text: string): InputRecord {
    const input: InputRecord = { id: crypto.randomUUID(), kind: 'steer', text, threadId, turnId, senderId: null, state: 'queued' };
    this.records.push(input); this.activity.notify('steer'); return input;
  }
  pending(): InputRecord[] { return this.records.filter((input) => input.state === 'queued'); }
  abandon(): InputRecord[] {
    const changed: InputRecord[] = [];
    for (const input of this.records) if (input.state === 'queued' || input.state === 'included' || input.state === 'sent') {
      input.state = 'uncommitted'; input.detail = 'Turn ended before confirmed application; never automatically replayed';
      changed.push(input);
    }
    return changed;
  }
}
