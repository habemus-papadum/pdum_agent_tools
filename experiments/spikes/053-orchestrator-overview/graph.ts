/** Disposable query graph over durable controls, fixtures and DuckDB. */
import { createProjection } from 'solid-js';
import { hotCellGraph } from '@habemus-papadum/aiui-viz';
import { buildQueryGraph } from './query-graph';
import { appScope, ensureEngine, group, inventory, runtime, search, selectedId, selectionRevision, sort } from './store';

export const graph = hotCellGraph(appScope.name, () => {
  // Keyed leaf subscriptions avoid waking every row when selection changes.
  const selectedFlags = createProjection<Record<string,boolean>>(() => {
    const id = selectedId.get(); return id ? { [id]: true } : {};
  }, {});
  const cells = buildQueryGraph({
  scope: appScope, engine: ensureEngine,
  agents: inventory.get, search: search.get, group: group.get, sort: sort.get,
  selectionRevision: selectionRevision.get,
  schedule(work) { const next = runtime.queue.then(work); runtime.queue = next.catch(() => undefined); return next; },
  accept(result) { runtime.result = result; if (result.agents.length) selectedId.set(previous => previous ?? result.agents[0].id); },
  });
  return { ...cells, selectedFlags };
}, import.meta.hot);
export type OverviewGraph = ReturnType<typeof graph>;

// Vite's server must see this literal boundary; library-side hot.accept() alone
// registers at runtime but is invisible to Vite's static module analysis.
if (import.meta.hot) import.meta.hot.accept();
