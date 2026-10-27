/** Disposable view contracts. Native records stay attached; these are not SDK types. */
export type Provider = 'codex' | 'claude';
export interface HistoryRef {
  provider: Provider; sessionId: string; cwd: string; title: string;
  profileDirectory: string; updatedAt?: string | number; native?: any;
}
export interface BranchPoint {id: string; kind: 'turn' | 'message'; label: string;}
export interface HistoryChoice {reference: HistoryRef; document: HistoryDocument; branchPoints: BranchPoint[];}
export interface Continuation {kind: 'resume' | 'fork'; sourceSessionId: string; pointId?: string; pointKind?: 'turn' | 'message';}
export interface LaunchRequest {provider: Provider; cwd: string; qualification?: boolean; continuation?: Continuation;}
export interface Run {
  id: string; provider: Provider; cwd: string; model: string; profileDirectory: string;
  websocketUrl: string; threadId?: string; workerId?: string; state?: string;
  continuation?: Continuation; owned?: boolean; runtime?: any;
}
export interface WireRecord {
  seq: number; provider: Provider; receivedAt: string;
  direction: 'in' | 'out' | 'local'; message: any;
}
export interface DisplayItem {
  id: string; role: 'user' | 'assistant' | 'tool' | 'system';
  kind: 'message' | 'tool' | 'reasoning' | 'unknown'; title: string; text: string;
  state?: string; nativeId?: string; phase?: string; raw: any;
  source: 'live' | 'history';
}
export interface Usage {
  input?: number; cached?: number; cacheCreated?: number; output?: number;
  inputBasis?: 'includes-cache' | 'uncached';
  context?: number; contextWindow?: number; costUsd?: number; basis: string;
}
export interface Projection {items: DisplayItem[]; usage: Usage; notes: string[];}
export interface HistoryDocument {
  version: number; key: string; provider: Provider; sessionId: string; title: string;
  source: Record<string, any>; payload: any;
}
export interface LiveState {
  phase: 'idle' | 'launching' | 'ready' | 'working' | 'disconnected' | 'ending' | 'ended' | 'error';
  run: Run | null; records: WireRecord[]; history: HistoryDocument | null;
  baseline?: HistoryDocument | null;
  historyLoading: boolean; error: string | null; notice: string;
}
export interface Configuration {
  defaultCwd: string;
  providers: {provider: Provider; model: string; profileDirectory: string; authAvailable: boolean; authDescription: string}[];
}
export interface Controller {
  state(): LiveState;
  subscribe(listener: (state: LiveState) => void): () => void;
  launch(options: LaunchRequest): Promise<void>;
  continueSession(options: {source: HistoryRef; kind: 'resume' | 'fork'; point?: BranchPoint; qualification?: boolean}): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  disconnect(): Promise<void>;
  loadHistory(): Promise<void>;
  end(): Promise<void>;
}
