import { createHash, randomUUID } from "node:crypto";

export type Frame = Record<string, unknown>;
export type WorkerPort = {
  send(frame: Frame): void;
  stop(): Promise<void>;
  onFrame(callback: (frame: Frame) => void): () => void;
  onExit(callback: (reason: string) => void): () => void;
};
export type Event = {
  sequence: number;
  workerId: string;
  kind: "frame" | "exit";
  frame: Frame;
};
export type Receipt = { inputId: string; state: "written" | "duplicate"; execution: "unknown" };
type Peer = {
  id: string;
  owner: string;
  role: "controller" | "observer";
  deliver: (event: Event) => Promise<void> | void;
  disconnected: (reason: string) => void;
  queue: Event[];
  draining: boolean;
  closed: boolean;
  maxPending: number;
};

/** Transport-neutral ownership and replay experiment; not a production server. */
export class SessionCore {
  readonly workerId = randomUUID();
  readonly history: Event[] = [];
  readonly pendingCallbacks = new Map<string, Frame>();
  readonly inputReceipts = new Map<string, { hash: string; receipt: Receipt }>();
  readonly peers = new Map<string, Peer>();
  readonly controls = new Map<string, { owner: string; requestId: unknown }>();
  private controllerOwner: string | undefined;
  private initialized = false;
  private busy = false;
  private exited = false;
  private stopping = false;
  private removers: Array<() => void>;

  constructor(readonly profileId: string, readonly conversationId: string, private worker: WorkerPort) {
    this.removers = [worker.onFrame(frame => this.ingest(frame)), worker.onExit(reason => {
      this.exited = true;
      this.busy = false;
      const lostCallbacks = [...this.pendingCallbacks.keys()];
      this.pendingCallbacks.clear();
      this.controls.clear();
      this.publish("exit", { reason, lostCallbacks, acceptedInputExecution: "unknown" });
    })];
  }

  attach(options: {
    id?: string;
    owner?: string;
    role: "controller" | "observer";
    cursor?: number;
    deliver: Peer["deliver"];
    disconnected?: Peer["disconnected"];
    maxPending?: number;
  }): { id: string; send: (frame: Frame) => Receipt | void; detach: () => void; pending: Frame[] } {
    const id = options.id ?? randomUUID();
    const owner = options.owner ?? id;
    if (this.peers.has(id)) throw new Error("connection ID already attached");
    const cursor = options.cursor ?? this.history.length;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.history.length) throw new Error("invalid cursor");
    if (options.role === "controller") {
      if ([...this.peers.values()].some(peer => peer.role === "controller")) throw new Error("controller already attached");
      // A disconnected SDK owns callback functions that cannot be serialized/recreated by a new client.
      if (this.controllerOwner && owner !== this.controllerOwner) throw new Error("controller handoff unsupported");
      this.controllerOwner = owner;
    }
    const peer: Peer = {
      id, owner, role: options.role, deliver: options.deliver,
      disconnected: options.disconnected ?? (() => {}), queue: [], draining: false, closed: false,
      maxPending: options.maxPending ?? Infinity,
    };
    this.peers.set(id, peer);
    for (const event of this.history.slice(cursor)) this.enqueue(peer, event);
    return {
      id,
      send: frame => this.receive(peer, frame),
      detach: () => this.detach(peer, "client detached"),
      pending: options.role === "controller" ? [...this.pendingCallbacks.values()] : [],
    };
  }

  private receive(peer: Peer, frame: Frame): Receipt | void {
    if (peer.closed || this.exited) throw new Error("connection or worker closed");
    if (peer.role !== "controller") throw new Error("observer cannot send frames");
    if (frame.type === "control_request") {
      const request = frame.request as Frame | undefined;
      if (request?.subtype === "initialize") {
        if (this.initialized) throw new Error("worker already initialized; reconnect through application API");
      }
      const key = `${peer.owner}:${String(frame.request_id)}`;
      if ([...this.controls.values()].some(x => x.owner === peer.owner && x.requestId === frame.request_id)) {
        throw new Error("duplicate outstanding control ID");
      }
      const wireId = `${key}:${randomUUID()}`;
      this.controls.set(wireId, { owner: peer.owner, requestId: frame.request_id });
      try {
        this.worker.send({ ...frame, request_id: wireId });
        if (request?.subtype === "initialize") this.initialized = true;
      }
      catch (error) { this.controls.delete(wireId); throw error; }
      return;
    }
    if (frame.type === "control_response") {
      const response = frame.response as Frame | undefined;
      const requestId = String(response?.request_id);
      if (!this.pendingCallbacks.has(requestId)) throw new Error("duplicate or stale callback decision");
      this.worker.send(frame);
      this.pendingCallbacks.delete(requestId);
      return;
    }
    if (frame.type === "user") {
      const inputId = typeof frame.uuid === "string" ? frame.uuid : randomUUID();
      const { uuid: _uuid, ...content } = frame;
      const hash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
      const previous = this.inputReceipts.get(inputId);
      if (previous) {
        if (previous.hash !== hash) throw new Error("input ID reused with different content");
        return { ...previous.receipt, state: "duplicate" };
      }
      if (this.busy) throw new Error("turn active; concurrent input/steering not qualified");
      this.worker.send({ ...frame, uuid: inputId });
      this.busy = true;
      const receipt: Receipt = { inputId, state: "written", execution: "unknown" };
      this.inputReceipts.set(inputId, { hash, receipt });
      return receipt;
    }
    // No schema allowlist: unknown SDK extensions remain visible and forwardable.
    this.worker.send(frame);
  }

  private ingest(frame: Frame): void {
    if (frame.type === "control_response") {
      const response = frame.response as Frame | undefined;
      const wireId = String(response?.request_id);
      const origin = this.controls.get(wireId);
      if (origin) {
        this.controls.delete(wireId);
        frame = { ...frame, response: { ...response, request_id: origin.requestId } };
      }
    }
    if (frame.type === "control_request" && typeof frame.request_id === "string") this.pendingCallbacks.set(frame.request_id, frame);
    if (frame.type === "control_cancel_request" && typeof frame.request_id === "string") this.pendingCallbacks.delete(frame.request_id);
    if (frame.type === "result") this.busy = false;
    this.publish("frame", frame);
  }

  private publish(kind: Event["kind"], frame: Frame): void {
    const event: Event = { sequence: this.history.length + 1, workerId: this.workerId, kind, frame };
    this.history.push(event);
    for (const peer of this.peers.values()) this.enqueue(peer, event);
  }

  private enqueue(peer: Peer, event: Event): void {
    if (peer.closed) return;
    if (peer.queue.length >= peer.maxPending) {
      this.detach(peer, "slow observer; reconnect with cursor");
      return;
    }
    peer.queue.push(event);
    if (!peer.draining) {
      peer.draining = true;
      setImmediate(() => { void this.drain(peer); });
    }
  }

  private async drain(peer: Peer): Promise<void> {
    try {
      while (peer.queue.length && !peer.closed) await peer.deliver(peer.queue.shift()!);
    } catch {
      this.detach(peer, "delivery failed; reconnect with cursor");
    } finally {
      peer.draining = false;
      if (this.stopping) this.detach(peer, "manager stopped");
    }
  }

  private detach(peer: Peer, reason: string): void {
    if (peer.closed) return;
    peer.closed = true;
    peer.queue.length = 0;
    this.peers.delete(peer.id);
    peer.disconnected(reason);
  }

  async stop(): Promise<void> {
    await this.worker.stop();
    this.stopping = true;
    for (const peer of this.peers.values()) if (!peer.draining) this.detach(peer, "manager stopped");
    for (const remove of this.removers) remove();
    this.removers = [];
  }
}
