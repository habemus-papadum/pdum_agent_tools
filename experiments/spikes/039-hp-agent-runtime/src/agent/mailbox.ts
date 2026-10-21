import { InputActivity, type InputKind, type InputRecord } from '../session/input-queue.ts';

/** Queue-only mail survives idle turns; taking mail is owned by the session's safe boundary. */
export class AgentMailboxes {
  private records = new Map<string, InputRecord[]>();
  private activities = new Map<string, InputActivity>();
  activity(threadId: string): InputActivity {
    let activity = this.activities.get(threadId);
    if (!activity) { activity = new InputActivity(); this.activities.set(threadId, activity); }
    return activity;
  }
  all(threadId: string): InputRecord[] { return this.records.get(threadId) ?? []; }
  pending(threadId: string): InputRecord[] { return this.all(threadId).filter((record) => record.state === 'queued'); }
  enqueue(senderId: string | null, threadId: string, text: string, kind: Exclude<InputKind, 'steer'>): InputRecord {
    const record: InputRecord = { id: crypto.randomUUID(), kind, senderId, threadId, text, turnId: null, state: 'queued' };
    const records = this.all(threadId); records.push(record); this.records.set(threadId, records);
    this.activity(threadId).notify('mailbox'); return record;
  }
  take(threadId: string, turnId: string): InputRecord[] {
    const pending = this.pending(threadId);
    for (const record of pending) { record.state = 'included'; record.turnId = turnId; }
    return pending;
  }
}
