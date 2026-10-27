import {agentToolkit, cell, hotCellGraph, registerStandardTools} from '@habemus-papadum/aiui-viz';
import {getConfiguration, getHistoryCatalogue, getHistoryChoice, getOwnedRuns} from './controller';
import {projectConversation} from './continuation';
import {compareProjections, projectHistory} from './projections';
import {appScope, configurationRevision, cwd, historyProvider, historyReference, historyRevision, historySearch,
  panel, provider, runsRevision, selected, session, view} from './store';
import type {Configuration, HistoryChoice, HistoryRef, Projection, Run} from './types';

const empty: Projection = {items: [], usage: {basis: 'No saved history has been read.'}, notes: []};
export function createCells() {
  const configuration = cell(() => configurationRevision.get(), async (): Promise<Configuration> => getConfiguration(), {scope: appScope});
  const setup = cell(() => ({configuration: configuration(), provider: provider.get(), cwd: cwd.get()}),
    ({configuration, provider, cwd}) => ({...configuration.providers.find(item => item.provider === provider),
      effectiveCwd: cwd.trim() || configuration.defaultCwd}), {scope: appScope});
  const live = cell(() => ({state: session.get(), provider: provider.get()}), ({state, provider}) =>
    projectConversation(state.run?.provider ?? provider, state.records, state.baseline), {scope: appScope});
  const history = cell(() => ({document: session.get().history}), ({document}) => document ? projectHistory(document) : empty, {scope: appScope});
  const displayed = cell(() => ({live: live(), history: history(), view: view.get()}),
    ({live, history, view}) => view === 'history' ? history : live, {scope: appScope});
  const comparison = cell(() => ({live: live(), history: history(), available: Boolean(session.get().history)}),
    ({live, history, available}) => available ? compareProjections(live, history) : null, {scope: appScope});
  const catalogue = cell(() => ({open: panel.get() === 'history', provider: historyProvider.get(), revision: historyRevision.get()}),
    async ({open, provider}, context): Promise<{sessions: HistoryRef[]; scope: string}> => {
      if (!open) return {sessions: [], scope: 'Open Saved sessions to read the native catalogue.'};
      const result = await getHistoryCatalogue(provider);
      if (context.signal.aborted) throw new DOMException('Superseded', 'AbortError');
      return result;
    }, {scope: appScope});
  const catalogueRows = cell(() => ({catalogue: catalogue(), search: historySearch.get()}), ({catalogue, search}) => {
    const q = search.trim().toLowerCase();
    return catalogue.sessions.filter(row => `${row.title} ${row.sessionId} ${row.cwd}`.toLowerCase().includes(q));
  }, {scope: appScope});
  const libraryChoice = cell(() => ({open: panel.get() === 'history', provider: historyProvider.get(), reference: historyReference.get(), revision: historyRevision.get()}),
    async ({open, provider, reference}, context): Promise<HistoryChoice | null> => {
      if (!open || !reference || reference.provider !== provider) return null;
      const result = await getHistoryChoice(reference);
      if (context.signal.aborted) throw new DOMException('Superseded', 'AbortError');
      return result;
    }, {scope: appScope});
  const libraryProjection = cell(() => ({choice: libraryChoice()}), ({choice}): Projection => {
    if (!choice) return empty;
    const projection = projectHistory(choice.document);
    return {...projection, items: projection.items.map(item => ({...item,
      id: `library:${choice.reference.provider}:${choice.reference.sessionId}:${item.id}`}))};
  }, {scope: appScope});
  const runs = cell(() => ({open: panel.get() === 'runs', revision: runsRevision.get()}), async ({open}, context): Promise<{rows: Run[]; readAt: string | null}> => {
    if (!open) return {rows: [], readAt: null};
    const rows = await getOwnedRuns();
    if (context.signal.aborted) throw new DOMException('Superseded', 'AbortError');
    return {rows, readAt: new Date().toISOString()};
  }, {scope: appScope});
  const selectedItem = cell(() => ({live: live(), history: history(), library: libraryProjection(), key: selected.get()}),
    ({live, history, library, key}) => [...live.items, ...(history?.items ?? []), ...library.items].find(item => `${item.source}:${item.id}` === key) ?? null,
    {scope: appScope});
  return {configuration, setup, live, history, displayed, comparison, selectedItem,
    catalogue, catalogueRows, libraryChoice, libraryProjection, runs};
}
export const graph = hotCellGraph(appScope.name, createCells, import.meta.hot);
if (import.meta.hot) import.meta.hot.accept();
export const kit = agentToolkit(appScope.name, {brief: 'Launch owned Codex/Luna or Claude/Haiku sessions in isolated profiles. No external processes are adopted. refresh-history/select-history inspect provider-native lab history; continue-session explicitly resumes latest or forks from a native boundary in the recorded profile/cwd. Drafts are never automatically sent. send-turn submits a real prompt only when ready. interrupt-turn, disconnect-client, end-runtime and end-all-owned-runs have different scopes. refresh-runtimes reads actual ownership/status evidence; unowned records cannot be stopped here. Live and saved records share rendering while retaining source data and availability. Model calls may incur usage.'});
registerStandardTools(kit);
kit.registerReporter('workspace', () => ({
  phase: session.get().phase, run: session.get().run, view: view.get(),
  records: session.get().records.length, liveItems: graph().live.latest()?.items.length ?? 0,
  savedItems: graph().history.latest()?.items.length ?? 0,
  selected: selected.get(), usage: graph().displayed.latest()?.usage,
  historySource: session.get().history?.source, error: session.get().error,
  panel: panel.get(), inspectedHistory: historyReference.get()?.provider === historyProvider.get() ? historyReference.get() : null,
  catalogueCount: graph().catalogue.latest()?.sessions.length ?? 0,
  ownedRuns: graph().runs.latest()?.rows.map(row => ({id: row.id, provider: row.provider, state: row.state,
    owned: row.owned, runtime: row.runtime})) ?? [],
}));
