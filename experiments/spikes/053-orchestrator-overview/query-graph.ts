/** The async boundary, injectable for headless causality/supersession checks. */
import { cell, type Scope } from '@habemus-papadum/aiui-viz';
import type { Agent, QueryResult } from './store';

export interface QueryEngine {
  setFilters(filters: { query: string }): unknown;
  setAgents(agents: Agent[]): Promise<unknown>;
  snapshotQuery(options: { group: string; sort: string }): Promise<unknown>;
}
export interface QueryInputs {
  scope: Scope;
  engine: () => Promise<QueryEngine>;
  agents: () => Agent[];
  search: () => string;
  group: () => string;
  sort: () => string;
  selectionRevision: () => number;
  schedule: (work: () => Promise<QueryResult>) => Promise<QueryResult>;
  accept: (result: QueryResult) => void;
}
export function buildQueryGraph(inputs: QueryInputs) {
  /** Initialize the durable engine without recreating it on graph edits. */
  const database = cell(() => ({}), async () => { await inputs.engine(); return { ready: true }; }, { scope: inputs.scope, name: 'database' });
  /** Explicit search writes only; categorical producers remain authoritative. */
  const scalarFilters = cell(() => ({ database: database(), query: inputs.search() }), async deps => {
    const engine = await inputs.engine(); await engine.setFilters({ query: deps.query });
    return { query: deps.query };
  }, { scope: inputs.scope, name: 'scalar-filters' });
  /** Every query input is read before await; superseded work never publishes. */
  const query = cell(() => ({ database: database(), scalarFilters: scalarFilters(), agents: inputs.agents(), group: inputs.group(), sort: inputs.sort(), selectionRevision: inputs.selectionRevision() }), async (deps, ctx): Promise<QueryResult> => inputs.schedule(async () => {
    const engine = await inputs.engine();
    if (ctx.signal.aborted) throw ctx.signal.reason;
    await engine.setAgents(deps.agents);
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const result = await engine.snapshotQuery({ group: deps.group, sort: deps.sort }) as QueryResult;
    if (ctx.signal.aborted) throw ctx.signal.reason;
    inputs.accept(result);
    return result;
  }), { scope: inputs.scope, name: 'query' });
  return { database, scalarFilters, query };
}
