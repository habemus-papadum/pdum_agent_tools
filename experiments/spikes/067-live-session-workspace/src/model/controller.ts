import type {Configuration, Controller, HistoryChoice, HistoryDocument, HistoryRef, LiveState, Provider, Run, WireRecord} from './types';
import {claudeCommandOutcome} from './command-state';

const base = '/__session-lab';
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base + path, {method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal});
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error || value.detail || `HTTP ${response.status}`);
  return value;
}
export const getConfiguration = () => api<Configuration>('/config');
export const getHistoryCatalogue = (provider: Provider, signal?: AbortSignal) =>
  api<{sessions: HistoryRef[]; scope: string}>(`/history?provider=${provider}`, undefined, signal);
export const getHistoryChoice = (reference: HistoryRef, signal?: AbortSignal) =>
  api<HistoryChoice>(`/history/${reference.provider}/${encodeURIComponent(reference.sessionId)}?cwd=${encodeURIComponent(reference.cwd)}`, undefined, signal);
export const getOwnedRuns = (signal?: AbortSignal) => api<Run[]>('/sessions', undefined, signal);
export const endOwnedRun = (id: string) => api<Run>(`/sessions/${encodeURIComponent(id)}/end`, {});
export const endAllOwnedRuns = () => api<{targetIds: string[]; results: Run[]}>('/sessions/end-all', {});

class InputQueue {
  private values: any[] = [];
  private waiting?: (value: IteratorResult<any>) => void;
  private closed = false;
  push(text: string, id: string) {
    if (this.closed) throw new Error('SDK prompt stream is closed');
    const value = {type: 'user', message: {role: 'user', content: text}, parent_tool_use_id: null, session_id: '', uuid: id};
    if (this.waiting) { const accept = this.waiting; this.waiting = undefined; accept({done: false, value}); }
    else this.values.push(value);
  }
  close() { this.closed = true; this.waiting?.({done: true, value: undefined}); this.waiting = undefined; }
  [Symbol.asyncIterator]() {return {next: async (): Promise<IteratorResult<any>> => {
    if (this.values.length) return {done: false, value: this.values.shift()};
    if (this.closed) return {done: true, value: undefined};
    return new Promise(accept => {this.waiting = accept;});
  }};}
}

class RpcError extends Error {constructor(message: string, readonly code?: number) {super(message);}}
class RpcSocket {
  private socket: WebSocket;
  private pending = new Map<string, {accept: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private sequence = 0;
  private intentional = false;
  private ready: Promise<void>;
  constructor(url: string, private record: (direction: 'in' | 'out', message: any) => void,
    private notification: (message: any) => void, private lost: (message: string) => void) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((accept, reject) => {
      const timer = setTimeout(() => {reject(new Error('Codex connection timed out')); this.socket.close();}, 15000);
      this.socket.addEventListener('open', () => {clearTimeout(timer); accept();}, {once: true});
      this.socket.addEventListener('error', () => {clearTimeout(timer); reject(new Error('Codex connection failed'));}, {once: true});
      this.socket.addEventListener('close', () => {clearTimeout(timer); reject(new Error('Codex connection closed before ready'));}, {once: true});
    });
    this.socket.addEventListener('message', event => {
      let message: any;
      try {message = JSON.parse(String(event.data));} catch {this.lost('Codex sent an unreadable protocol frame'); return;}
      this.record('in', message);
      if (message.id != null && !message.method) {
        const key = String(message.id), pending = this.pending.get(key);
        if (pending) {
          this.pending.delete(key); clearTimeout(pending.timer);
          if (message.error) pending.reject(new RpcError(message.error.message || 'Native request failed', message.error.code));
          else pending.accept(message.result);
        }
      } else if (message.id != null && message.method) {
        // This first slice has no approval/user-question form. Never claim a
        // callback was approved or silently keep the native request hanging.
        this.send({id: message.id, error: {code: -32601, message: 'This live study has no handler for ' + message.method}});
        this.notification({method: 'study/unsupportedRequest', params: {method: message.method}});
      } else this.notification(message);
    });
    this.socket.addEventListener('close', () => {
      for (const p of this.pending.values()) {clearTimeout(p.timer); p.reject(new Error('Connection closed; request outcome may be unknown'));}
      this.pending.clear();
      if (!this.intentional) this.lost('Codex connection closed. The last observed state is retained; no prompt was replayed.');
    });
  }
  private send(message: any) {this.record('out', message); this.socket.send(JSON.stringify(message));}
  async notify(method: string) {await this.ready; this.send({method});}
  async request(method: string, params: Record<string, any> = {}): Promise<any> {
    await this.ready;
    const id = `study-${++this.sequence}`;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(new Error(`${method} timed out; outcome may be unknown`));}, 45000);
      this.pending.set(id, {accept, reject, timer});
      try {this.send({id, method, params});} catch (error) {clearTimeout(timer); this.pending.delete(id); reject(error);}
    });
  }
  close() {this.intentional = true; this.socket.close(1000, 'Study client ended');}
}

/** One browser-owned control connection. No session is launched until launch(). */
export function createController(): Controller {
  let state: LiveState = {phase: 'idle', run: null, records: [], history: null, baseline: null, historyLoading: false, error: null, notice: 'Choose a provider and working directory.'};
  const listeners = new Set<(state: LiveState) => void>();
  let rpc: RpcSocket | undefined, sdk: any, input: InputQueue | undefined, pumping: Promise<void> | undefined;
  let activeTurn: string | undefined, activeSubmission: string | undefined, ending = false, generation = 0;
  const patch = (change: Partial<LiveState>) => {state = {...state, ...change}; for (const listener of listeners) listener(state);};
  const record = (direction: WireRecord['direction'], message: any) => {
    if (!state.run) return;
    patch({records: [...state.records, {seq: state.records.length + 1, provider: state.run.provider,
      receivedAt: new Date().toISOString(), direction, message}]});
  };
  const failed = (error: unknown) => patch({phase: 'error', error: String(error instanceof Error ? error.message : error),
    notice: 'Last observations are retained. No automatic reconnect or prompt replay.'});
  const capture = async () => {if (state.run) await api(`/sessions/${encodeURIComponent(state.run.id)}/capture`, {records: state.records});};
  const closeClient = () => {rpc?.close(); rpc = undefined; sdk?.close(); sdk = undefined; input?.close(); input = undefined;};
  const controller: Controller = {
    state: () => state,
    subscribe(listener) {listeners.add(listener); listener(state); return () => listeners.delete(listener);},
    async launch(options) {
      if (state.run && state.phase !== 'ended') throw new Error('End the current runtime before launching another.');
      const mine = ++generation; ending = false; activeTurn = undefined; activeSubmission = undefined;
      patch({phase: 'launching', run: null, records: [], history: null, baseline: null, historyLoading: false, error: null, notice: 'Launching the selected provider in its lab profile…'});
      try {
        const run = await api<Run>('/sessions', options); patch({run});
        if (options.continuation && !run.continuation)
          throw new Error('This backend does not support continuation yet. No conversation was started; open the updated study instance.');
        const receive = (message: any) => {
          if (mine !== generation) return;
          record('in', message);
        };
        if (run.provider === 'codex') {
          rpc = new RpcSocket(run.websocketUrl, (direction, message) => {if (mine === generation) record(direction, message);}, message => {
            if (mine !== generation) return;
            const params = message.params || {};
            if (message.method === 'thread/status/changed' && params.status?.type === 'active' && !ending)
              patch({phase: 'working', notice: 'Native runtime reports active work.'});
            if (message.method === 'turn/started') {activeTurn = params.turn?.id; if (!ending) patch({phase: 'working', notice: 'Turn running.'});}
            if (message.method === 'turn/completed') {
              activeTurn = undefined;
              if (!ending) patch({phase: 'ready', notice: `Turn ${params.turn?.status || 'finished'}.`,
                error: params.turn?.error?.message || null});
            }
            if (message.method === 'thread/closed' && !ending) failed('Native thread unloaded; this slice does not automatically resume it.');
            if (message.method === 'study/unsupportedRequest') patch({error: `Callback ${params.method} is not implemented in this study.`});
          }, message => {if (mine === generation && !ending) failed(message);});
          await rpc.request('initialize', {clientInfo: {name: 'pdum_live_study', title: 'HP live study', version: '0.0.0'}, capabilities: {experimentalApi: true}});
          await rpc.notify('initialized');
          const continuation = run.continuation;
          const result = continuation ? await rpc.request(continuation.kind === 'fork' ? 'thread/fork' : 'thread/resume', {
            threadId: continuation.sourceSessionId, excludeTurns: true,
            ...(continuation.kind === 'fork' && continuation.pointId ? {lastTurnId: continuation.pointId} : {}),
          }) : await rpc.request('thread/start', {cwd: run.cwd, model: run.model,
            approvalPolicy: 'never', sandbox: 'danger-full-access'});
          run.threadId = result.thread.id;
          if (typeof result.model === 'string') run.model = result.model;
          if (result.thread?.status?.type === 'active' && !ending)
            patch({phase: 'working', notice: 'Resumed runtime reports active work; no draft was submitted.'});
          await api(`/sessions/${encodeURIComponent(run.id)}/identity`, {threadId: run.threadId});
          patch({run: {...run}});
        } else {
          // The official browser SDK currently expects these benign process
          // fields. No host environment or credentials are exposed to the page.
          (globalThis as any).process ??= {env: {}, argv: [], platform: 'browser', cwd: () => '/', on() {}};
          const {query} = await import('@anthropic-ai/claude-agent-sdk/browser');
          input = new InputQueue();
          sdk = query({prompt: input, websocket: {url: run.websocketUrl}});
          const session = sdk;
          pumping = (async () => {
            try {
              for await (const message of session) {
                receive(message);
                if (['result', 'command_lifecycle'].includes(message.type) && !ending && mine === generation) {
                  const outcome = claudeCommandOutcome(state.records);
                  if (outcome.status === 'interrupted') patch({phase: 'ready', error: null,
                    notice: 'Submitted command cancelled after your interrupt request. Native error details remain inspectable.'});
                  else if (outcome.status !== 'working') patch({phase: 'ready',
                    notice: outcome.status === 'failed' ? 'Turn returned an error; see its native result.' : 'Turn completed.',
                    error: outcome.status === 'failed' ? (typeof outcome.result?.result === 'string' ? outcome.result.result : `Claude result: ${outcome.result?.subtype}`) : null});
                }
              }
              if (!ending && mine === generation) failed('Claude SDK connection ended. Its worker ends on disconnect.');
            } catch (error) {if (!ending && mine === generation) failed(error);}
          })();
          await sdk.initializationResult();
        }
        if (mine === generation) {
          const working = Boolean(activeTurn) || controller.state().phase === 'working';
          patch({phase: working ? 'working' : 'ready', notice: 'Connected. No prompt has been submitted by this client.'});
          if (run.continuation) {
            await controller.loadHistory();
            patch({baseline: state.history, notice: `${run.continuation.kind === 'fork' ? 'Fork opened' : 'Saved conversation resumed'}. Draft remains unsent; files and tools were not restored.`});
          }
        }
      } catch (error) {
        ending = true; closeClient();
        if (state.run) {
          try {await api(`/sessions/${encodeURIComponent(state.run.id)}/end`, {}); patch({run: null});}
          catch { /* Keep run identity so End can reconcile uncertain cleanup. */ }
        }
        ending = false; failed(error);
      }
    },
    async continueSession({source, kind, point, qualification}) {
      if (point && (source.provider === 'codex' ? point.kind !== 'turn' : point.kind !== 'message'))
        throw new Error('The selected boundary belongs to a different provider history format.');
      await controller.launch({provider: source.provider, cwd: source.cwd, qualification,
        continuation: {kind, sourceSessionId: source.sessionId,
          ...(kind === 'fork' && point ? {pointId: point.id, pointKind: point.kind} : {})}});
    },
    async send(text) {
      if (state.phase !== 'ready' || !state.run) throw new Error('Connect an idle session before sending.');
      if (!text.trim()) return;
      const id = crypto.randomUUID(); patch({phase: 'working', error: null, notice: 'Submitting a new turn…'});
      activeSubmission = id;
      record('local', {type: 'local/user', id, text});
      try {
        if (state.run.provider === 'codex') {
          const result = await rpc!.request('turn/start', {threadId: state.run.threadId,
            input: [{type: 'text', text, text_elements: []}]});
          if (controller.state().phase === 'working') activeTurn = result.turn?.id;
        } else input!.push(text, id);
      } catch (error) {
        if (error instanceof RpcError) patch({phase: 'ready', error: error.message, notice: 'Native request rejected; input was not automatically retried.'});
        else failed(error);
      }
    },
    async interrupt() {
      if (state.phase !== 'working' || !state.run) return;
      try {
        record('local', {type: 'local/interrupt', commandId: activeSubmission, turnId: activeTurn});
        if (state.run.provider === 'codex') {
          if (!activeTurn) throw new Error('Waiting for the native turn identity before interrupting.');
          await rpc!.request('turn/interrupt', {threadId: state.run.threadId, turnId: activeTurn});
        } else await sdk.interrupt();
        patch({notice: 'Interrupt acknowledged; waiting for native completion. This is not a promise that all background work stopped.'});
      } catch (error) {patch({error: String(error instanceof Error ? error.message : error)});}
    },
    async disconnect() {
      if (!state.run || ['idle', 'launching', 'ending', 'ended', 'disconnected'].includes(state.phase)) return;
      const wasWorking = state.phase === 'working';
      ending = true;
      closeClient();
      if (pumping) await Promise.race([pumping, new Promise(resolve => setTimeout(resolve, 3000))]);
      patch({phase: 'disconnected', error: null,
        notice: `${state.run.provider === 'codex' ? 'Client disconnected; the Codex runtime remains owned by this lab.' : 'SDK disconnected; its Claude worker is ending.'}${wasWorking ? ' The active turn outcome needs native inspection.' : ''} No input was replayed.`});
      try {await capture();} catch {patch({notice: state.notice + ' Debug capture was unavailable.'});}
    },
    async loadHistory() {
      if (!state.run || state.historyLoading) return;
      const id = state.run.id; patch({historyLoading: true, error: null});
      try {
        await capture();
        const history = await api<HistoryDocument>(`/sessions/${encodeURIComponent(id)}/history`);
        if (state.run?.id === id) patch({history, notice: 'Saved native history read without resume or fork.'});
      } catch (error) {patch({error: String(error instanceof Error ? error.message : error)});}
      finally {patch({historyLoading: false});}
    },
    async end() {
      if (!state.run || state.phase === 'ended' || state.phase === 'ending') return;
      ending = true; patch({phase: 'ending', error: null, notice: 'Saving an observation and ending the owned runtime…'});
      const id = state.run.id;
      await controller.loadHistory();
      const historyIssue = state.error;
      closeClient();
      try {
        const ended = await api<Run>(`/sessions/${encodeURIComponent(id)}/end`, {});
        if (pumping) await Promise.race([pumping, new Promise(resolve => setTimeout(resolve, 3000))]);
        let captureIssue = false;
        try {await capture();} catch {captureIssue = true;}
        patch({phase: 'ended', run: {...state.run!, ...ended}, error: null,
          notice: `Owned runtime ended.${state.history ? ' Saved history remains available.' : ' No saved history snapshot is available.'}${historyIssue ? ' History inspection: ' + historyIssue : ''}${captureIssue ? ' Debug capture was unavailable.' : ''}`});
      } catch (error) {failed(error);}
    },
  };
  return controller;
}
