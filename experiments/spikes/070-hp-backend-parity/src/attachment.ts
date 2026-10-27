import type { AgentRuntime, Notification } from '../../039-hp-agent-runtime/src/runtime.ts';
import type { Port } from '../../039-hp-agent-runtime/src/protocol.ts';

export type FeedEvent =
  | { kind: 'replay-start'; ownerId: string; highWater: number; notifications: number }
  | { kind: 'notification'; ownerId: string; seq: number; event: Notification }
  | { kind: 'replay-end'; ownerId: string; highWater: number };

/** Experimental notification feed, separate from RPC and storage. One execution owner.
 * Journal sequence scopes ordering to that owner; skipped snapshot records are normal.
 * Reads queued journal entries on each notification wake, not by event-content equality.
 */
export class ReplayFeed {
  private cursor = 0;
  private readonly history: Extract<FeedEvent, { kind: 'notification' }>[] = [];
  private readonly clients = new Set<Port>();
  private readonly unsubscribe: () => void;
  constructor(private readonly runtime: AgentRuntime) {
    this.unsubscribe = runtime.subscribe(() => this.collect());
    this.collect();
  }
  private collect(): void {
    const entries = this.runtime.journal.slice(this.cursor);
    this.cursor += entries.length;
    for (const entry of entries) {
      if (entry.kind !== 'notification') continue;
      const message: Extract<FeedEvent, { kind: 'notification' }> = {
        kind: 'notification', ownerId: this.runtime.runId, seq: entry.seq,
        event: structuredClone(entry.data) as unknown as Notification,
      };
      this.history.push(message);
      for (const client of this.clients) client.postMessage(structuredClone(message));
    }
  }
  attach(port: Port): () => void {
    // Synchronous collection/snapshot/subscription prevents a replay/live gap.
    this.collect();
    const highWater = this.cursor;
    port.postMessage({ kind: 'replay-start', ownerId: this.runtime.runId, highWater, notifications: this.history.length } satisfies FeedEvent);
    for (const event of this.history) port.postMessage(structuredClone(event));
    port.postMessage({ kind: 'replay-end', ownerId: this.runtime.runId, highWater } satisfies FeedEvent);
    this.clients.add(port);
    return () => { this.clients.delete(port); };
  }
  close(): void { this.collect(); this.unsubscribe(); this.clients.clear(); }
}

/** Passive reconstruction: never sends RPCs or executes callbacks from replay. */
export class FeedReader {
  readonly events: FeedEvent[] = [];
  readonly notifications: Extract<FeedEvent, { kind: 'notification' }>[] = [];
  replaying = true;
  private readonly listener: (event: MessageEvent<FeedEvent>) => void;
  constructor(private readonly port: Port) {
    this.listener = ({ data }) => {
      this.events.push(data);
      if (data.kind === 'replay-start') this.replaying = true;
      else if (data.kind === 'replay-end') this.replaying = false;
      else this.notifications.push(data);
    };
    port.addEventListener('message', this.listener);
    port.start?.();
  }
  close(): void { this.port.removeEventListener('message', this.listener); }
}
