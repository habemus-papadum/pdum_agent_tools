# 053 — Agent overview interaction mock

**Status:** disposable UI study, now using actual AIUI/Solid components and tools.
The [design note](../../spikes/053-orchestrator-overview/README.md) records the
interaction and implementation boundaries. All agents and cost values are synthetic;
no provider calls are made.

## Question and current direction

Can an operator scan a mixed fleet, vary density and grouping, inspect evidence,
and drive the same interface with mouse, keyboard or agent tools?

The first large editorial cards became a compact application shell after operator
feedback. The current view retains 36/500 fixtures, tiny/tile/card/detail levels,
list/grid arrangement, independent grouping/sorting, and filtered/whole count/cost
percentages. Phones retain the whole-fleet known-cost denominator. Unknown coverage
remains explicit; stale observations do not imply failure.

Aggregate labels explicitly say **filtered / all**. A separate presented count in
the grouping banner reflects collapse/focus, without changing aggregate scope.

Groups can collapse individually or together, or the presentation can focus on one
group. These operations leave the filtered dataset and totals intact. Selection
survives filtering and hidden groups. Group headers may reasonably add scrolling.
Project names are explicit fixture metadata, not inference from real directories.

## Actual framework integration

The former imperative DOM runtime has been replaced by Solid components, scoped
AIUI controls/actions, durable signals/resources and asynchronous cells. Database
initialization, search publication and query results are separate cell boundaries.
`PageBoundary`, `CellView` and `hotCellGraph` provide lifecycle/error attribution.

The filter tray now mounts real `MosaicView` category bars, with `selectionDim`
adoption and `categorySelection` highlight behavior over the shared crossfilter.
DuckDB-Wasm and a Mosaic Coordinator execute filtering/grouping/aggregates. Mouse,
native controls and crossfilter tools share canonical category state; an unrelated
search/group change cannot overwrite a chart's multi-selection.

The actual AIUI dock exposes the declared tool surface, including source location,
report/set/actions, crossfilter and SQL/schema. The oracle-facing overview is a
summary with at most 12 example IDs; the full fixture inventory is still queryable.
A shared Space-led modal keyboard map lists concrete commands and icons, including
navigation, filters, grouping, collapse/focus and density. Provider sessions remain
operator initiated; this study makes no paid calls.

## Evidence and reproduction

Use the shared Vite mock-server workflow and open `/053-orchestrator-overview/`.
From `experiments/`:

```sh
node --test spikes/053-orchestrator-overview/model.test.mjs
pnpm --filter @agent-spike/orchestrator-mock-lab test ../053-orchestrator-overview/query-graph.test.ts
pnpm --filter @agent-spike/orchestrator-mock-lab typecheck
```

Twelve pure checks cover fixture/filter/uncertainty invariants and presentation-only
focus/collapse. Two headless AIUI cell tests cover every query input, preservation of
categorical producers and suppression of late superseded results. Those injected
backend tests qualify graph behavior; actual browser checks qualify the real stack.

In Chrome, selecting Claude gave 10 rows; Shift-pointer selection of Codex in the
actual provider chart gave 22. Subsequent text search preserved both categories.
Host focus displayed four cards while aggregate scope stayed at 10 rows/$13.60.
Collapse-all hid cards without changing totals. All three Mosaic charts rendered;
Space → g opened the Groups map, Escape twice closed it, and j moved selection to
the next presented agent. With 500 fixtures, the overview reporter used 12 IDs and
about 3.2 KB, while full QA state retained all 500 records.

The earlier compact-layout browser checks verified 500 ungrouped tiny glyphs at
1440 × 900 CSS pixels, plus a 390 × 844 phone view with 10 / 36 agents (27.8%) and
$13.60 / $43.63 known cost (31.2%), without document overflow. The coordinating pass
records final visual checks of the Solid iteration.

The actual Solid/Mosaic phone view was also checked at 390 × 844: all three
charts mounted inside a scrolling filter tray, known cost remained fully visible,
and the Space-command map fit the viewport without horizontal or document overflow.

A per-row DOM boundary removed a 36-source list-insertion diagnostic. Keyed
selection projection then removed the 500-subscriber selection diagnostic. Initial
bulk loading of 500 rows still produced `HOT_SCOPE_TIME`: approximately 17–18 ms
in the `For` memo against an 8 ms diagnostic budget. This remains an explicit
performance follow-up, not a suppressed warning or a production scalability claim.

A real graph-file HMR edit preserved document identity, the exact database object,
Claude filter, host grouping and focused group; fixture-write count stayed 36.
Vite required a literal `import.meta.hot.accept()` at the graph call site: the
helper's library-side acceptance was invisible to static module analysis. That is
recorded as an upstream documentation/tooling candidate, not a hidden recovery shim.

## Remaining scope

This remains a disposable application study, not the final SDK or component API.
HP palette/glyph/motion refinements are provisional upstream candidates. Live
provider behavior, data placement, refresh policy, persistence and recovery remain
in their component plans. HMR persistence does not promise survival across reloads.
The [working method](../../../docs/plans/agent-orchestrator/methodology.md) and
[O08 component](../../../docs/plans/agent-orchestrator/components/08-agent-overview.md)
remain the owners of the design decisions.
