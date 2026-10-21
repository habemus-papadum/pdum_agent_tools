import type { AgentRuntime, Tool } from '../039-hp-agent-runtime/src/runtime.ts';
import { agentTools } from '../039-hp-agent-runtime/src/fixture.ts';

export interface StockRow { item: string; units: number }
export const STOCK_ROWS: StockRow[] = [{ item: 'Oak kits', units: 9 }, { item: 'Birch kits', units: 12 }, { item: 'Maple kits', units: 20 }];
export const APPLICATION_SUFFIX = '\n\n# Host application\nYou are embedded in an inventory dashboard. Its tools are your only application surface; there is no shell. spawn_agent starts an independent child using its message argument and returns threadId. wait takes that ID in its id argument and returns the completed child turn. A child can read application rows using read_rows. annotate_total updates the dashboard. Finish this small task concisely.\n';
export const DELEGATION_PROMPT = 'Update this dashboard using model-selected delegation. Call spawn_agent exactly once with a message instructing the child to call read_rows, calculate the sum of the units column, and report only the total; the child must not spawn another agent or annotate the dashboard. Do not read or calculate the rows yourself. Use wait with the child threadId returned by spawn_agent. After reading the completed child result, call annotate_total exactly once with the childThreadId and the total it reported. Finish with a short confirmation. Do not guess the stock total.';
export interface Annotation { total: number; childThreadId: string; authorThreadId: string }
export interface ApplicationCall { name: string; threadId: string; turnId: string; arguments: unknown; result: unknown }

/** Application tools share actual mutable dashboard state across independently running agent threads. */
export function createStockApplication(rows: StockRow[] = STOCK_ROWS, onChange?: (annotation: Annotation) => void) {
  const initialRows = structuredClone(rows);
  const calls: ApplicationCall[] = [];
  let annotation: Annotation | null = null;
  const readRows: Tool = {
    definition: { type: 'function', name: 'read_rows', description: 'Read the current inventory dashboard rows. Each row has an item name and units count.', strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    async execute(text, context) {
      const args = JSON.parse(text); const result = { table: 'inventory', revision: 1, rows: structuredClone(initialRows) };
      calls.push({ name: 'read_rows', threadId: context.threadId, turnId: context.turnId, arguments: args, result });
      return JSON.stringify(result);
    },
  };
  const annotateTotal: Tool = {
    definition: { type: 'function', name: 'annotate_total', description: 'Set the dashboard total annotation using the completed child calculation and its thread ID.', strict: true,
      parameters: { type: 'object', properties: { total: { type: 'integer' }, childThreadId: { type: 'string' } }, required: ['total', 'childThreadId'], additionalProperties: false } },
    async execute(text, context) {
      const args = JSON.parse(text);
      if (!Number.isSafeInteger(args.total) || typeof args.childThreadId !== 'string') throw new Error('Expected integer total and childThreadId');
      annotation = { total: args.total, childThreadId: args.childThreadId, authorThreadId: context.threadId };
      const result = { updated: true, annotation: structuredClone(annotation) };
      calls.push({ name: 'annotate_total', threadId: context.threadId, turnId: context.turnId, arguments: args, result });
      onChange?.(structuredClone(annotation));
      return JSON.stringify(result);
    },
  };
  return { tools: [...agentTools, readRows, annotateTotal], rows: initialRows, calls, get annotation() { return annotation; } };
}
export type StockApplication = ReturnType<typeof createStockApplication>;

/** Acceptance depends on actual tool execution/lineage, not a convincing model answer. */
export function validateDelegation(runtime: AgentRuntime, app: StockApplication, rootThreadId: string) {
  const check = (condition: unknown, description: string) => { if (!condition) throw new Error(`Delegation check failed: ${description}`); };
  const saved = runtime.snapshots(); const root = saved.find((s) => s.thread.id === rootThreadId);
  check(root, 'root exists');
  const children = saved.filter((s) => s.thread.parentThreadId === rootThreadId);
  check(saved.length === 2 && children.length === 1, 'exactly one separately addressable child');
  const child = children[0]!;
  check(root!.thread.turns.at(-1)?.status === 'completed', 'parent completed');
  check(child.thread.turns.at(-1)?.status === 'completed', 'child completed');
  const parentItems = root!.thread.turns.flatMap((turn) => turn.items);
  const childItems = child.thread.turns.flatMap((turn) => turn.items);
  const successful = (items: typeof parentItems, name: string) => items.filter((item) => item.type === 'dynamicToolCall' && item.tool === name && item.success === true);
  check(successful(parentItems, 'spawn_agent').length === 1, 'parent model invoked spawn_agent exactly once');
  check(successful(parentItems, 'wait').length >= 1, 'parent waited for its child');
  check(successful(childItems, 'read_rows').length >= 1, 'child called real application read_rows');
  check(successful(parentItems, 'annotate_total').length === 1, 'parent annotated application');
  check(app.calls.filter((call) => call.name === 'read_rows').every((call) => call.threadId === child.thread.id), 'row reads belong to child');
  check(app.calls.filter((call) => call.name === 'annotate_total').length === 1, 'one application annotation');
  const expected = app.rows.reduce((sum, row) => sum + row.units, 0);
  check(app.annotation?.total === expected, 'annotation equals independent sum');
  check(app.annotation?.childThreadId === child.thread.id && app.annotation.authorThreadId === rootThreadId, 'annotation has child provenance and parent author');
  return { rootThreadId, childThreadId: child.thread.id, parentStatus: 'completed', childStatus: 'completed',
    modelSelectedSpawn: true, hostSelectedSpawn: false, childReadRows: true, parentWaited: true,
    annotation: structuredClone(app.annotation), expectedTotal: expected, threads: saved.length,
    toolCalls: saved.reduce((count, s) => count + s.thread.turns.reduce((n, turn) => n + turn.items.filter((i) => i.type === 'dynamicToolCall').length, 0), 0),
    toolSchemas: 'prototype agentTools plus host application functions; not full Codex tool parity' };
}
