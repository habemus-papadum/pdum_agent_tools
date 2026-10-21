# Overview interaction mock

**Disposable AIUI application study.** The current iteration uses actual Solid 2
components, AIUI controls/cells/tools and coordinated Mosaic plots. Agents, prompts,
usage and API-equivalent amounts remain synthetic. It never launches a provider.

## What the interface is trying to convey

Keep fleet controls anchored while the collection scrolls. Tiny glyph, tile, card
and detailed views share the same 36- or 500-agent fixture set; a list arrangement
is also available. Provider symbols/colors, context rings, state dots and stale
hatching progressively give way to names, activity, cost and evidence. The inspector
has Activity, Summary and Raw JSON views. Tab-local HP remains explicitly local.

Group by execution state, host, directory, explicit fixture project or provider,
then sort independently within each group. Collapse/expand groups, collapse/expand
all, or show only one group. These are **presentation operations**: filtered counts,
known costs and SQL scope remain unchanged. Selection survives hidden groups and
filters. “Show all groups” restores the presentation without clearing filters.

The header retains filtered/whole-fleet counts, known costs and percentages on
phones too. Labels say **filtered / all**, and the group banner separately counts
presented agents so collapse/focus cannot be mistaken for filtering. Cost
percentages mean a share of **known cost**, not total billing.
Unknown/partial coverage stays visible. Querying replaces filtered figures with
ellipses rather than presenting an old answer as current.

## Real AIUI integration

- `model.mjs`: pure fixtures, transforms and group-presentation semantics.
- `store.ts`: the `orchestrator-overview` scope, declared controls/actions,
  durable signals and the durable database owner.
- `query-graph.ts` / `graph.ts`: asynchronous database/search/query cells,
  supersession checks and `hotCellGraph` publication.
- `ui/`: Solid components reading controls/cells; actual `MosaicView` category
  plots using `selectionDim`, `categorySelection` and a shared crossfilter.
- `main.tsx`: `PageBoundary`, shared modal keyboard map and the actual AIUI dock.

The filter tray contains coordinated provider, host and state bars. Click a bar;
Shift/Meta-click adds/removes categories. Native selects reflect multiple selection
without silently reducing it to one. Categories have one authoritative dimension:
mouse, native actions and agent tools update that same state. Search has its own
control/cell; changing search or grouping does not overwrite chart selections.
Queries and group aggregates run in DuckDB-Wasm through Mosaic. There is no silent
JavaScript fallback. The tools expose report/set/actions, crossfilter, SQL/schema
and source-location inspection. The overview reporter is a bounded summary with
12 example IDs; complete fixture rows remain available through SQL and the QA API.

Press **Space** for a grouped command map, then a group key to narrow it; Escape
backs out/closes. Direct shortcuts outside typing include j/k (presented agents),
l (grid/list), s (sort), g (group), r (clear filters), x (selected group), f (filters),
i (inspector), 1–4 (density). They dispatch the same declared actions/controls as
buttons and tools. The dock is mounted for tool/oracle inspection; no model session
starts automatically. Mock-only fault controls remain under the gear.

## What is provisional

The HP `aiui-design` source checkout supplies the design baseline. Compact glyphs,
optional pulses/glow, density and group affordances are experiments to review and
possibly contribute upstream. No upstream library was edited in this iteration.
The eventual SDK, live data placement, refresh, browser persistence and recovery
remain open. The session link opens a separate scripted study.

Graph HMR was tested against the live Vite server: filter/group/focus state and the
exact database instance survived a graph edit, with no additional fixture writes.
A necessary call-site `if (import.meta.hot) import.meta.hot.accept()` is explicit:
Vite's static analysis cannot see the helper's library-side `hot.accept()`. This
is an upstream documentation/tooling candidate. Durable HMR state is not reload
or crash persistence; editing the durable store may intentionally reload.

Two observed Solid diagnostics led to narrow changes: a per-row DOM boundary
isolates lazy component results from the list insertion effect, and a keyed
`createProjection` prevents selection changes from waking all 500 rows. A remaining
`HOT_SCOPE_TIME` warning measured approximately 17–18 ms in the initial 500-row
`For` calculation against an 8 ms diagnostic budget. It remains visible as a
performance follow-up; the mock does not claim a warning-free scalability result.

## Run and check

Use the shared Vite mock-server workflow; open `/053-orchestrator-overview/`.
From `experiments/`:

```sh
node --test spikes/053-orchestrator-overview/model.test.mjs
pnpm --filter @agent-spike/orchestrator-mock-lab test ../053-orchestrator-overview/query-graph.test.ts
pnpm --filter @agent-spike/orchestrator-mock-lab typecheck
```

`await window.mockOverview.idle()` waits for the query cell (Mosaic's independent
chart painting may settle afterward). The API retains `state`, `select`, `scenario`,
`reset`, `count`, `density`, `inspector`, `filters` and `details`, and adds `collapse`,
`collapseAll`, `expandAll`, `focusGroup`, `showAllGroups`. Category filters in `state`
are canonical arrays, including multi-selection. Full `state()` is a QA affordance;
it is deliberately richer than the oracle-facing summary. None of these checks
establish provider compatibility or a production component contract.
