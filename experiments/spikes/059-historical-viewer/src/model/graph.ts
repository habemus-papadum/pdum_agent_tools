import {action, agentToolkit, cell, hotCellGraph, registerStandardTools} from '@habemus-papadum/aiui-viz';
import {filterCatalog, filterItems, projectHistory, type HistoryCatalog, type HistoryDocument} from './native';
import {specimen} from './specimen';
import {appScope, provider, catalogQuery, selectedKey, query, kind, refreshSequence, focus} from './store';
export type Reader = (path: string, signal: AbortSignal) => Promise<unknown>;
export interface CatalogResult extends HistoryCatalog {loadError?: string;}
export interface DocumentResult {document: HistoryDocument | null; requestedKey: string; loadError?: string;}
const readExport: Reader = async (path, signal) => {
  const response = await fetch(path, {method: 'GET', signal, cache: 'no-store'});
  if (!response.ok) throw new Error(`History export unavailable (${response.status}). Run spike 058's read-only export, then refresh.`);
  return response.json();
};
/** Injectable local GET seam for deterministic projection tests; the real backend remains a captured export. */
export function createCells(read: Reader = readExport) {
  /** Native capture inventory. Refresh rereads the export, not the provider. */
  const catalog = cell(() => ({revision: refreshSequence.get()}), async (_deps, ctx): Promise<CatalogResult> => {
    try {
      const value = await read('/__history/catalog', ctx.signal) as HistoryCatalog;
      if (!Array.isArray(value.sessions)) throw new Error('History catalog has no sessions array');
      return value;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return {sessions: [], loadError: String(error)};
    }
  }, {scope: appScope});
  /** Source list narrows independently from the selected transcript. */
  const sources = cell(() => ({catalog: catalog(), provider: provider.get(), query: catalogQuery.get()}),
    ({catalog, provider, query}) => filterCatalog(catalog.sessions, provider, query), {scope: appScope});
  /** Native document bytes are fetched by export key. Explicit bench selection needs no real source. */
  const document = cell(() => ({key: selectedKey.get() || catalog().sessions[0]?.key || '', revision: refreshSequence.get()}), async ({key}, ctx): Promise<DocumentResult> => {
    if (key === '@specimen') return {document: structuredClone(specimen), requestedKey: key};
    if (!key) return {document: null, requestedKey: key};
    try {
      const value = await read(`/__history/document/${encodeURIComponent(key)}`, ctx.signal) as HistoryDocument;
      if (value.key !== key || !value.source || !('payload' in value)) throw new Error('Native export envelope does not match the selected key');
      return {document: value, requestedKey: key};
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return {document: null, requestedKey: key, loadError: String(error)};
    }
  }, {scope: appScope});
  /** Source-specific readable view with original payload retained. */
  const projection = cell(() => ({result: document()}), ({result}) => result.document ? projectHistory(result.document) : null, {scope: appScope});
  /** Filtering changes presentation only; request accounting always covers the full selected capture. */
  const visible = cell(() => ({projection: projection(), query: query.get(), kind: kind.get()}),
    ({projection, query, kind}) => projection ? filterItems(projection.items, query, kind) : [], {scope: appScope});
  return {catalog, sources, document, projection, visible};
}
export const graph = hotCellGraph(appScope.name, () => createCells(), import.meta.hot);
if (import.meta.hot) import.meta.hot.accept();
/** Move through the current filtered transcript, changing reader focus only. */
export const stepItem = action({scope: appScope, name: 'step-item', group: 'navigation', params: {direction: 'next or previous'}, run: args => {
  const rows = graph().visible.latest() ?? [];
  const current = rows.findIndex(item => item.id === focus.get().id);
  const index = Math.max(0, Math.min(rows.length - 1, current + (args?.direction === 'previous' ? -1 : 1)));
  const item = rows[index];
  if (item) focus.set(state => ({id: item.id, sequence: state.sequence + 1}));
  return {id: item?.id ?? null};
}});
export const kit = agentToolkit(appScope.name, {brief: 'Read-only viewer of captured native Claude SDK and Codex app-server history. All network requests are GETs to local export files. Open-history, jump, filters and inspector controls change this reader only. No turn, resume, fork, live subscription or profile write is available. @specimen is authored renderer coverage, never provider evidence.'});
registerStandardTools(kit);
kit.registerReporter('history', () => {
  const value = graph().projection.latest();
  return {readOnly: true, requestedKey: selectedKey.get(), selectedKey: value?.document.key, provider: value?.document.provider,
    documentState: graph().document.state(), projectionState: graph().projection.state(), documentError: graph().document.latest()?.loadError,
    source: value?.document.source, synthetic: value?.document.provider === 'specimen',
    catalog: graph().catalog.latest()?.sessions.map(entry => ({key: entry.key, provider: entry.provider, sessionId: entry.sessionId, title: entry.title})),
    items: value?.items.map(item => ({id: item.id, nativeId: item.nativeId, role: item.role, path: item.path, blocks: item.blocks.map(block => block.kind)})),
    visible: graph().visible.latest()?.length, catalogError: graph().catalog.latest()?.loadError, focusedItem: focus.get().id, unknownBlocks: value?.unknownBlocks,
    usage: value?.ledger, warnings: value?.warnings};
});
// Graph hot swaps rebuild projections over the surviving reader controls.
