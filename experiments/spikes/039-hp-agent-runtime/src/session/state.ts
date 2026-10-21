import type { ModelEvent, ModelRun, NativeItem } from '../../../038-hp-sdk-fit/src/connector.ts';
import type { AgentRuntime, Item, Json, RuntimeOptions, SavedThread, Tool, Turn } from '../runtime.ts';
import type { TurnInputQueue, InputRecord } from './input-queue.ts';
export type ToolCall = Extract<ModelEvent, { type: 'toolCall' }>;
export interface CallState { call: ToolCall; status: 'pending' | 'running' | 'completed' | 'interrupted'; executionStarted?: boolean; item?: Item }
export interface ActiveTurn {
  turn: Turn; controller: AbortController; run?: ModelRun; ready: boolean;
  phase: 'preparing' | 'opening' | 'model' | 'tools' | 'finishing';
  mailboxMode: 'current' | 'next';
  input: TurnInputQueue; calls: Map<string, CallState>;
  included: { record: InputRecord; item: NativeItem }[];
  done: Promise<Turn>; resolve: (turn: Turn) => void;
}
export interface SessionServices {
  owner: AgentRuntime; options: RuntimeOptions; tools: Map<string, Tool>;
  record(kind: string, data: Json): void;
  emit(method: string, params: Json): void;
  checkpoint(saved: SavedThread): void;
  drain(saved: SavedThread, active: ActiveTurn): void;
  hasPending(threadId: string, active: ActiveTurn): boolean;
  ready(saved: SavedThread, active: ActiveTurn): Promise<void>;
  inputCommitted(active: ActiveTurn, item: NativeItem, receiptId?: string): void;
  inclusionCommitted(active: ActiveTurn): void;
  inclusionFailed(saved: SavedThread, active: ActiveTurn): void;
  steeringEvent(active: ActiveTurn, event: Extract<ModelEvent, { type: 'steering' }>): void;
  answerBoundary(saved: SavedThread, active: ActiveTurn): void;
  finish(saved: SavedThread, active: ActiveTurn, started: number): void;
  usage(threadId: string, turnId: string, event: Extract<ModelEvent, { type: 'usage' }>): void;
}
