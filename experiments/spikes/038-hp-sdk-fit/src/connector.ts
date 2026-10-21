/** Experimental boundary shared with 039. Native items are deliberately retained. */
export type NativeItem = Record<string, unknown>;
export type ModelEvent =
  | { type: 'textDelta'; itemId: string; delta: string }
  | { type: 'outputItem'; item: NativeItem }
  | { type: 'inputItem'; item: NativeItem; index?: number; receiptId?: string }
  | { type: 'toolCall'; id: string; name: string; arguments: string; kind: 'function' | 'custom' }
  | { type: 'usage'; responseId: string; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; cacheWriteTokens: number; reasoningOutputTokens?: number }
  | { type: 'completed'; responseId: string }
  | { type: 'raw'; event: NativeItem; duplicate?: boolean }
  | { type: 'steering'; state: SteeringReceipt['state']; responseId: string; receiptId?: string; steerId?: string; detail?: NativeItem };

export interface ModelRunArgs {
  threadId: string;
  turnId: string;
  model: string;
  instructions: string;
  input: NativeItem[];
  tools: NativeItem[];
  signal: AbortSignal;
}

export interface SteeringReceipt {
  receiptId: string;
  input: string;
  responseId: string;
  steerId?: string;
  state: 'sent' | 'accepted' | 'pending' | 'committed' | 'failed' | 'unknown';
}
export type ModelRunStatus = 'opening' | 'running' | 'waitingForTools' | 'waitingForSuccessor' | 'completed' | 'failed';

export interface ModelRun {
  events: AsyncIterable<ModelEvent>;
  /** Dispatch acknowledgement only; follow steering events for provider acceptance/commit. */
  steer(input: string): Promise<SteeringReceipt | void>;
  readonly status?: ModelRunStatus;
  readonly steeringReceipts?: readonly SteeringReceipt[];
}

export interface ModelConnector {
  run(args: ModelRunArgs): ModelRun;
  /** Drop only this thread's transport; unresolved sends stay unknown, never replayed. */
  discardThread?(threadId: string): readonly SteeringReceipt[];
}

/** Host supplies credentials and WebSocket construction. No credential access in runtime. */
export interface ResponsesConnection {
  send(event: NativeItem): void;
  events: AsyncIterable<NativeItem>;
  close(): void;
}
export type ResponsesConnectionFactory = (signal: AbortSignal) => Promise<ResponsesConnection>;
