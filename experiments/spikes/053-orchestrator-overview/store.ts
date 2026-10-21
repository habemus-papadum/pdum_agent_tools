/** Durable controls and actions. HMR persistence is not reload/crash recovery. */
import { action, agentToolkit, control, registerStandardTools, scope } from '@habemus-papadum/aiui-viz';
import { bindSelectionComponents } from '@habemus-papadum/aiui-viz/mosaic-selection';
import { registerSqlTools } from '@habemus-papadum/aiui-viz/duckdb';
import { crossfilterViews, registerCrossfilterTools } from '@habemus-papadum/aiui-viz/crossfilter';
import { createOverviewData } from './data-engine';
import { createAgents, groupValue, simulate } from './model.mjs';

export const appScope = scope('orchestrator-overview');
export type Agent = ReturnType<typeof createAgents>[number];
export interface QueryResult { agents: Agent[]; groups: { value: string; count: number; knownCost: number; incomplete: number }[]; facets: Record<string,{value:string;count:number}[]>; engine: string; }
/** Literal text search over synthetic agent identity and activity. */
export const search = control({ scope: appScope, name: 'search', value: '' });
/** Group filtered agents without changing the selected rows or aggregates. */
export const group = control({ scope: appScope, name: 'group', value: '', options: ['', 'status', 'host', 'cwd', 'project', 'provider'] });
/** Ordering inside each group, or across the ungrouped collection. */
export const sort = control({ scope: appScope, name: 'sort', value: 'attention', options: ['attention', 'recent', 'name'] });
/** Glyph/tile/card/detail density affects presentation only. */
export const density = control({ scope: appScope, name: 'density', value: 'tile', options: ['tiny', 'tile', 'card', 'detail'] });
/** Collection arrangement, independent of its data query. */
export const layout = control({ scope: appScope, name: 'layout', value: 'cards', options: ['cards', 'list'] });
/** Optional glyph activity effects. All motion represents simulated data. */
export const effects = control({ scope: appScope, name: 'effects', value: true });
/** Show the filter tray, including real coordinated Mosaic charts. */
export const filtersOpen = control({ scope: appScope, name: 'filters-open', value: false });
/** Show selected-agent details without changing selected identity. */
export const inspectorOpen = control({ scope: appScope, name: 'inspector-open', value: false });
/** Selected agent detail level. */
export const detail = control({ scope: appScope, name: 'detail', value: 'activity', options: ['activity', 'summary', 'evidence'] });
export const inventory = appScope.durableSignal<Agent[]>('inventory', createAgents());
export const selectedId = appScope.durableSignal<string | null>('selected-id', null);
export const mockOpen = appScope.durableSignal('mock-open', false);
/** Which synthetic fault/progress event the Apply action will simulate. */
export const scenario = control({ scope: appScope, name: 'scenario', value: 'progress', options: ['progress','input','stale','failure','host-loss'] });
export const step = appScope.durableSignal('step', 0);
export const announcement = appScope.durableSignal('announcement', 'Select an agent to inspect. Space opens the command palette.');
export const selectionRevision = appScope.durableSignal('selection-revision', 0);
export const collapsed = appScope.durableSignal<string[]>('collapsed-groups', []);
export const focusedGroup = appScope.durableSignal<{ field: string; value: string } | null>('focused-group', null);
export const runtime = appScope.durable('engine-owner', () => ({
  promise: null as ReturnType<typeof createOverviewData> | null,
  engine: null as Awaited<ReturnType<typeof createOverviewData>> | null,
  result: null as QueryResult | null,
  queue: Promise.resolve() as Promise<unknown>,
}));
export const kit = agentToolkit(appScope.name, { brief: 'Synthetic multi-provider agent overview. Controls select filters and display. Crossfilter tools and Mosaic charts share a real in-browser database. Group collapse/focus changes presentation only, never query totals. No live agents are controlled. Read report before changing explicit controls.' });
registerStandardTools(kit);
kit.setActive(true);

export async function ensureEngine() {
  if (!runtime.promise) runtime.promise = createOverviewData(inventory.get(), { scope: appScope }).then(engine => {
    runtime.engine = engine;
    bindSelectionComponents({ bindings: (['provider','host','status'] as const).map(field => ({ dim: engine.dims[field], producer: `${appScope.name}/${field}-chart` })) });
    // Selection notifications invalidate the read-only query cell, never scalar writes.
    engine.subscribe?.(() => selectionRevision.set(v => v + 1));
    registerCrossfilterTools(kit, { scope: appScope, selection: engine.selection, onReset: () => { search.set(''); engine.clear(); } });
    registerSqlTools(kit, { runner: engine.sqlRunner, views: [crossfilterViews({selection:engine.selection,scope:appScope})] });
    return engine;
  });
  return runtime.promise;
}
export const controls = { search, group, sort, density, layout, effects, filtersOpen, inspectorOpen, detail, scenario };
export const filtersSnapshot = () => { selectionRevision.get(); return { ...runtime.engine?.currentFilters(), query: search.get(), group: group.get(), sort: sort.get() }; };
export const categoryValue = (field: 'provider'|'host'|'status') => { selectionRevision.get(); const value = runtime.engine?.currentFilters()[field]; return Array.isArray(value) ? value.length > 1 ? '__multiple' : String(value[0] ?? '') : String(value ?? ''); };
export const groupKey = (field: string, value: string) => JSON.stringify([field, value]);
export const isCollapsed = (value: string) => collapsed.get().includes(groupKey(group.get(), value));
export const focusedValue = () => focusedGroup.get()?.field === group.get() ? focusedGroup.get()?.value ?? null : null;
export const selected = () => inventory.get().find(agent => agent.id === selectedId.get());
export function invoke(name: string, args: Record<string, unknown> = {}) { return kit.handle().call(name, args); }
export function setControl(control: { name: string }, value: unknown) { return invoke('set', { name: control.name, value }); }

/** Set one category/special filter through the engine's canonical selection dimensions. */
export const filterCategory = action({ scope: appScope, name: 'filter-category', params: { field: 'provider, host or status', value: 'Exact category, empty to clear, attention or stale for special status' }, async run(args) {
  const field = String(args?.field); if (!['provider','host','status'].includes(field)) throw Error('Unknown filter dimension');
  const value = String(args?.value ?? ''); await (await ensureEngine()).setFilters({ [field]: value }); return { field, value };
} });

/** Select an existing fixture agent and open the inspector; preserve its identity when filtering. */
export const selectAgent = action({ scope: appScope, name: 'select-agent', params: { id: 'Synthetic agent ID' }, run(args) {
  const id = String(args?.id ?? ''); if (!inventory.get().some(a => a.id === id)) throw Error('Unknown fixture agent');
  selectedId.set(id); inspectorOpen.set(true); return { selectedId: id };
} });
/** Toggle one group's presentation; filtering and cost totals do not change. */
export const toggleGroup = action({ scope: appScope, name: 'toggle-group', params: { value: 'Exact group value, including empty string for no directory' }, run(args) {
  const value = String(args?.value ?? ''); const key = groupKey(group.get(), value);
  collapsed.set(values => values.includes(key) ? values.filter(k => k !== key) : [...values, key]); return { group: group.get(), value, presentationOnly: true };
} });
/** Collapse every group in the current query result without stopping agents or filtering data. */
export const collapseAll = action({ scope: appScope, name: 'collapse-all', run() {
  const keys = (runtime.result?.groups || []).map((g: { value: string }) => groupKey(group.get(), g.value));
  collapsed.set(old => [...new Set([...old, ...keys])]); return { collapsed: keys.length, presentationOnly: true };
} });
/** Expand all groups in the current grouping dimension. */
export const expandAll = action({ scope: appScope, name: 'expand-all', run() {
  const field = group.get(); collapsed.set(old => old.filter(k => JSON.parse(k)[0] !== field)); return { expanded: true, presentationOnly: true };
} });
/** Show only this group's presentation. The filtered count and cost still cover the entire query result. */
export const focusGroup = action({ scope: appScope, name: 'focus-group', params: { value: 'Exact group value' }, run(args) {
  const value = String(args?.value ?? ''); focusedGroup.set({ field: group.get(), value }); announcement.set('Group focus changes presentation only; filtered totals are unchanged.'); return { field: group.get(), value, presentationOnly: true };
} });
/** Restore all groups without changing filters, sort, selection or collapsed states. */
export const showAllGroups = action({ scope: appScope, name: 'show-all-groups', run() { focusedGroup.set(null); return { presentationOnly: true }; } });
/** Clear search and all crossfilter clauses; grouping and display settings survive. */
export const clearFilters = action({ scope: appScope, name: 'clear-filters', async run() {
  search.set(''); await (await ensureEngine()).clear(); selectionRevision.set(v => v + 1); return { cleared: true };
} });
/** Replace the synthetic inventory with 36 or 500 fixtures; no real agent is launched. */
export const setCount = action({ scope: appScope, name: 'fixture-count', params: { count: '36 or 500' }, run(args) {
  const count = Number(args?.count); inventory.set(createAgents(count)); selectedId.set(null); step.set(0); collapsed.set([]); focusedGroup.set(null); announcement.set(`${count} synthetic agents.`); return { count };
} });
/** Apply a named synthetic scenario to the selected fixture only (or its host for host-loss). */
export const applyScenario = action({ scope: appScope, name: 'simulate', params: { scenario: 'progress, input, stale, failure or host-loss' }, run(args) {
  const value = String(args?.scenario ?? scenario.get()); const target = selected(); if (!target) throw Error('Select an agent first');
  if (!['progress', 'input', 'stale', 'failure', 'host-loss'].includes(value)) throw Error('Unknown fixture scenario');
  if (value === 'host-loss' && target.local) throw Error('This tab has no remote host link');
  const next = step.get() + 1; step.set(next); inventory.set(simulate(inventory.get(), target.id, value, next)); announcement.set(`Simulated ${value} · ${target.name}`); return { scenario: value, target: target.id };
} });
/** Toggle the mock-only settings popup. */
export const toggleMock = action({ scope: appScope, name: 'toggle-mock', run(args) { mockOpen.set(typeof args?.open === 'boolean' ? args.open : !mockOpen.get()); return { open: mockOpen.get() }; } });
/** Restore fixture data and view controls. Does not close or recreate the durable database. */
export const reset = action({ scope: appScope, name: 'reset-mock', async run() {
  for (const item of Object.values(controls)) setControl(item, item.initial);
  inventory.set(createAgents()); selectedId.set(null); collapsed.set([]); focusedGroup.set(null); step.set(0); scenario.set('progress');
  await (await ensureEngine()).clear(); selectionRevision.set(v => v + 1); announcement.set('Reset · 36 fixtures, tiles, no filters.'); return { reset: true };
} });
kit.registerReporter('presentation', () => ({ group: group.get(), collapsed: collapsed.get(), focus: focusedGroup.get(), selectedId: selectedId.get(), density: density.get(), layout: layout.get(), interpretation: 'Collapse and focus do not change filtered totals.' }));
kit.registerReporter('database', () => runtime.engine?.details() ?? { state: 'loading' });

/** Move to the previous/next presented agent without wrapping; hidden groups are skipped. */
export const moveSelection = action({ scope: appScope, name: 'move-selection', params: { direction: '-1 for previous, 1 for next' }, run(args) {
  const direction = Number(args?.direction); if (direction !== -1 && direction !== 1) throw Error('Direction must be -1 or 1');
  const field = group.get(); const focus = focusedValue();
  const rows = (runtime.result?.agents || []).filter(agent => !field || ((!isCollapsed(groupValue(agent,field))) && (focus === null || groupValue(agent,field) === focus)));
  if (!rows.length) return { moved:false, reason:'No presented agents' };
  const current = rows.findIndex(agent => agent.id === selectedId.get());
  const index = current < 0 ? direction > 0 ? 0 : rows.length - 1 : Math.max(0,Math.min(rows.length-1,current+direction));
  selectAgent.run({ id:rows[index].id }); return { selectedId:rows[index].id, scope:'presented agents', wrapped:false };
} });
/** Toggle the selected agent's group visibility, without changing filters or totals. */
export const toggleSelectedGroup = action({ scope: appScope, name: 'toggle-selected-group', run() {
  if (!group.get() || !selected()) return { changed:false, reason:'Choose a grouping and agent first' };
  return toggleGroup.run({ value:groupValue(selected(),group.get()) });
} });
