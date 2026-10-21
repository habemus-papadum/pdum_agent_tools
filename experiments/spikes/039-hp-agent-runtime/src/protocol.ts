import { AgentRuntime, type Json, type Notification, type Thread } from './runtime.ts';

export type RpcId = string | number;
export type Envelope = { id: RpcId; method: string; params?: Json } | Notification | { id: RpcId; result: unknown } | { id: RpcId; error: { code: number; message: string } };
export interface Port {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start?(): void;
}
function inputText(input: unknown): string {
  if (!Array.isArray(input) || !input.length) throw new Error('Nonempty input array required');
  return input.map((part) => {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') throw new Error('Prototype supports text input only');
    return part.text;
  }).join('\n');
}
function threadResponse(thread: Thread) {
  return { thread, model: thread.model, modelProvider: 'openai', serviceTier: null, disabledPluginIds: [], cwd: thread.cwd,
    runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: 'explicitRequestOnly' };
}
const allowed: Record<string, string[]> = {
  'thread/start': ['model', 'cwd'], 'thread/read': ['threadId', 'includeTurns'], 'thread/list': [],
  'thread/fork': ['threadId'], 'turn/start': ['threadId', 'input'],
  'turn/steer': ['threadId', 'expectedTurnId', 'input'], 'turn/interrupt': ['threadId', 'turnId'],
};

/** Native envelopes and selected native method shapes; hp/* methods are explicit prototype extensions. */
export function servePort(runtime: AgentRuntime, port: Port): () => void {
  let initialized = false;
  let detached = false;
  const jobWaits = new Map<string, AbortController>();
  const reply = (value: unknown) => { if (!detached) port.postMessage(value); };
  const unsubscribe = runtime.subscribe((event) => { if (initialized) port.postMessage(event); });
  const detach = () => {
    detached = true; unsubscribe(); port.removeEventListener('message', listener);
    for (const controller of jobWaits.values()) controller.abort(new Error('Client detached from job wait'));
    jobWaits.clear();
  };
  const listener = (event: MessageEvent) => { void handle(event.data); };
  const handle = async (message: Envelope) => {
    if (!message || !('method' in message)) return;
    if (!('id' in message)) {
      if (message.method === 'hp/client/detach') detach();
      return; // initialized notification is accepted without a response.
    }
    const p = message.params ?? {};
    try {
      let result: unknown;
      if (message.method === 'initialize') {
        if (initialized) throw new Error('Already initialized'); initialized = true;
        result = { userAgent: 'hp-agent-spike-039', codexHome: '/', platformFamily: 'web', platformOs: 'portable' };
      } else {
        if (!initialized) throw new Error('Initialize first');
        const accepted = allowed[message.method];
        if (accepted && Object.keys(p).some((key) => !accepted.includes(key))) throw new Error(`Unsupported prototype parameters for ${message.method}`);
        switch (message.method) {
          case 'thread/start': result = threadResponse(runtime.create({ ...(typeof p.model === 'string' ? { model: p.model } : {}), ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}) })); break;
          case 'thread/read': result = { thread: runtime.read(String(p.threadId), p.includeTurns === true), readState: null }; break;
          case 'thread/list':
            if (Object.keys(p).length) throw new Error('Prototype does not implement list filters or pagination');
            result = { data: runtime.list(), readStates: null, nextCursor: null, backwardsCursor: null }; break;
          case 'thread/fork': result = threadResponse(runtime.fork(String(p.threadId))); break;
          case 'turn/start': result = { turn: runtime.start(String(p.threadId), inputText(p.input)) }; break;
          case 'turn/steer': result = await runtime.steer(String(p.threadId), String(p.expectedTurnId), inputText(p.input)); break;
          case 'turn/interrupt': runtime.interrupt(String(p.threadId), String(p.turnId)); result = {}; break;
          case 'hp/agent/spawn': result = runtime.spawn(String(p.parentThreadId), String(p.prompt)); break;
          case 'hp/agent/message': result = await runtime.message(String(p.threadId), String(p.text)); break;
          case 'hp/agent/sendMessage': result = runtime.sendMessage(String(p.senderThreadId), String(p.target), String(p.text)); break;
          case 'hp/agent/followupTask': result = runtime.followupTask(String(p.senderThreadId), String(p.target), String(p.text)); break;
          case 'hp/agent/waitAgent': result = await runtime.waitAgent(String(p.threadId), { ...(typeof p.timeoutMs === 'number' ? { timeoutMs: p.timeoutMs } : {}) }); break;
          case 'hp/agent/interrupt':
            if (p.scope !== undefined && p.scope !== 'thread' && p.scope !== 'subtree') throw new Error('Expected thread or subtree scope');
            result = runtime.interrupt(String(p.threadId), String(p.turnId), { ...(p.scope ? { scope: p.scope } : {}) }); break;
          case 'hp/inputs/read': result = { inputs: runtime.inspectInputs(String(p.threadId)) }; break;
          case 'hp/job/list': result = { jobs: runtime.jobs.list({
            ...(typeof p.ownerId === 'string' ? { ownerId: p.ownerId } : {}),
            ...(typeof p.threadId === 'string' ? { threadId: p.threadId } : {}),
          }) }; break;
          case 'hp/job/read': result = { job: runtime.jobs.inspect(String(p.jobId)) }; break;
          case 'hp/job/events': result = { events: runtime.jobs.events({
            ...(typeof p.jobId === 'string' ? { jobId: p.jobId } : {}),
            ...(typeof p.afterSeq === 'number' ? { afterSeq: p.afterSeq } : {}),
          }) }; break;
          case 'hp/job/send': result = { job: runtime.jobs.send(String(p.jobId), p.input) }; break;
          case 'hp/job/cancel': result = { job: runtime.jobs.cancel(String(p.jobId), typeof p.reason === 'string' ? p.reason : undefined) }; break;
          case 'hp/job/wait': {
            if (typeof p.waitId !== 'string' || !p.waitId || jobWaits.has(p.waitId)) throw new Error('Unique nonempty waitId required for this connection');
            const controller = new AbortController(); jobWaits.set(p.waitId, controller);
            try { result = await runtime.jobs.wait(String(p.jobId), { signal: controller.signal,
              ...(typeof p.timeoutMs === 'number' ? { timeoutMs: p.timeoutMs } : {}) }); }
            finally { jobWaits.delete(p.waitId); }
            break;
          }
          case 'hp/job/cancelWait': {
            const controller = jobWaits.get(String(p.waitId));
            controller?.abort(new Error('Client cancelled its job wait'));
            result = { requested: Boolean(controller) }; break;
          }
          case 'hp/agent/wait': result = { turn: await runtime.wait(String(p.threadId)) }; break;
          case 'hp/context/read': result = { input: runtime.context(String(p.threadId)) }; break;
          case 'hp/context/replace':
            if (!Array.isArray(p.input)) throw new Error('input must be an array');
            runtime.replaceContext(String(p.threadId), p.input, String(p.reason)); result = {}; break;
          case 'hp/recording/read': result = { journal: runtime.journal, usages: runtime.usages, threads: runtime.snapshots() }; break;
          default: reply({ id: message.id, error: { code: -32601, message: `Unsupported prototype method ${message.method}` } }); return;
        }
      }
      reply({ id: message.id, result });
    } catch (error) { reply({ id: message.id, error: { code: -32602, message: String(error) } }); }
  };
  port.addEventListener('message', listener); port.start?.();
  // Detaching a UI is distinct from cancelling runtime work.
  return detach;
}

export class PortClient {
  readonly diagnostics: { kind: 'observerFailure' | 'invalidEnvelope'; message: string }[] = [];
  private sequence = 0;
  private readonly pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(event: Notification) => void>();
  private closed = false;
  private readonly listener = (event: MessageEvent) => {
    const message = event.data as Envelope;
    if (!message || typeof message !== 'object') {
      this.diagnostics.push({ kind: 'invalidEnvelope', message: 'Expected a protocol object' }); return;
    }
    if ('id' in message && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id);
      if ('error' in message) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    } else if ('method' in message && !('id' in message)) for (const fn of this.listeners) queueMicrotask(() => {
      if (!this.listeners.has(fn)) return;
      try { void Promise.resolve(fn(message)).catch(error => {
        this.diagnostics.push({ kind: 'observerFailure', message: String(error) });
      }); }
      catch (error) { this.diagnostics.push({ kind: 'observerFailure', message: String(error) }); }
    });
  };
  constructor(readonly port: Port) { port.addEventListener('message', this.listener); port.start?.(); }
  request<T = Json>(method: string, params: Json = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Client closed'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try { this.port.postMessage({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  subscribe(listener: (event: Notification) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void {
    if (this.closed) return;
    // Graceful detach releases this connection's server waits. Transport loss
    // still requires the host to invoke servePort's returned disposer.
    try { this.port.postMessage({ method: 'hp/client/detach', params: {} }); } catch { /* transport already closed */ }
    this.closed = true; this.port.removeEventListener('message', this.listener);
    for (const pending of this.pending.values()) pending.reject(new Error('Client disconnected; request outcome unknown'));
    this.pending.clear(); this.listeners.clear();
  }
}
