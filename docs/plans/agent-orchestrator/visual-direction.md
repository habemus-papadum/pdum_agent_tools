# Orchestrator visual direction

**Working preferences, 19 October 2026; subject to visual review.** These guide
the next mock iterations. They are not a finished design system, accessibility
programme, component specification or frozen set of product defaults.

## A personal application, in the Habemus Papadum family

This application primarily serves one experienced operator. Cater to their
preferences: compact information, expressive color, and a willingness to try
unusual CSS. Expect several iterations and concrete complaints to teach us which
combinations work. Keep inexpensive native labels, hover explanations and focus
behavior; broad accessibility work is not the priority of these disposable studies.

Use **Habemus Papadum's `aiui-design`** as the baseline. Its definitive local
source is `.dev/aiui/packages/aiui-design/` (`DESIGN.md`, `src/tokens.css`,
`src/site.css` and the categorical palettes in `src/index.ts`). This source link
points to `~/src/pdum_aiui`. Reuse its surface, slate text, indigo accent, semantic
status colors, type roles and data palettes. The earlier mock used the related
private FAI Labs sheet; the current iteration consumes Habemus Papadum directly.

Consistency permits improvement. Experiment locally with derived colors,
transitions, subtle glows, patterns, filters and motion. Tie each effect to a
meaning the operator can learn: active work, selected focus, stale observation,
uncertain coverage or a delivery outcome. Keep provider identity distinct from
execution status. A stale observation must not turn into an apparent failure,
and unknown metrics must not become zero or a made-up measurement.

## Give the work most of the screen

Keep navigation, metrics and controls small and anchored. Scroll the collection
or conversation inside the remaining area. The overview's filters and selected
agent inspector can collapse. Mock scenarios, reset, fixture sizing and “try
this” guidance belong in a clearly separate study popup at the top right.

The overview explores semantic levels of detail, independently of browser zoom:
compound glyphs at fleet scale, compact named tiles, and richer cards. Tiny mode
aims to show roughly 500 items on a desktop screen before scrolling. Icons,
small plots and meters should carry more of the information, with hover details
and a fuller inspector available. Exact sizes, initial density and icon choices
remain experiments. List view and sorting stay available.

Grouping is independent of filtering and sorting: first select the visible set,
then group it by execution status, host, working directory, explicit project or
agent type, and sort within each group. Tiny glyphs need compact group bands;
richer cards can afford fuller headings. Ungrouped remains a useful option.
Grouping by working directory does not establish that directory's project
identity; the mock can supply explicit synthetic project labels while real
project discovery stays open.

Keep total cost visible at all sizes. Show how much of the entire fleet is in
the current filtered view, both by agent count and by known cost, including
percentages. Missing usage makes a cost percentage a share of the **known**
amount, not a claim about the unknown total bill. Group headings may carry their
own counts and known costs. A narrow screen may need an additional compact row;
hiding the useful totals is not the preferred tradeoff.

Phone layout is part of the interaction exploration. Keep the main work usable,
wrap or collapse secondary controls, and let deeper inspection occupy a focused
surface. Browser viewport checks help iterate; they do not establish behavior
with a physical phone, its keyboard or touch gestures.

The session view gives the conversation priority and keeps its composer compact.
A source reference first offers a quick hover/focus preview, then an explicit
detail popup, then an optional pinned side pane for selection and prompting.
Moving between these presentations should retain useful selection and draft
state. AIUI's existing Lens is the reference for preview/detail; pinning is an
application-level extension to evaluate, not a capability we assume Lens has.

Density must preserve the [explicit-intent method](methodology.md): the selected
delivery mode and target remain visible. A short control can distinguish steering
this turn from queueing the next one without a large explanatory block or an
extra confirmation dialog.

## Data-backed interaction in the mock

The overview now explores a small in-memory DuckDB-WASM table in each browser
tab, Mosaic queries and AIUI's crossfilter routing. Facet counts reflect the
other selected dimensions while retaining alternatives in their own dimension.
Fixture changes update rows; no server database, agent monitoring or provider
connection is implied. This tests a useful frontend mechanism, not the eventual
live ingestion protocol or persistence architecture.

## Keyboard, framework inspection and usage exploration

The next reviewed direction is to exercise the actual AIUI primitives in these
mocks: Solid components, scoped controls/actions, durable state, cells and native
Mosaic widgets. The development dock and source compiler make the tool surface,
dataflow and source attribution inspectable. This is local lab scaffolding, not
a commitment to publish or depend on the internal dock in the finished SDK.

Keyboard operation should be practical outside text entry. **Space** opens a
grouped command map with icons, descriptions, keycaps and current availability;
group keys narrow it and Escape backs out. Direct shortcuts use the same actions
as mouse and tool calls. The mode engine owns modal state. Typing, native input
controls, composition and browser modifiers retain their normal meaning. The
first keymap is deliberately small enough to review; exact keys remain provisional.

Groups can collapse individually or together, expand together, or focus one group.
That is presentation state, separate from filtering. Show presented counts apart
from filtered/all count and cost ratios so a collapsed panel does not imply work
disappeared or change the accounting denominator.

The session explores both a top usage chart and a side navigator. Time, cost,
tokens and context should help find a point in the conversation, alongside compact
per-item attribution and running totals. Keep model-request usage counted once;
related tool items point to their request rather than receiving a fabricated
independent bill. Show cached input, missing coverage, compaction and errors.
Context occupancy can fall while cumulative usage continues to rise. These
fixtures inform future shared health computations; no automatic detector or
provider-level per-item billing guarantee is established by the mock.

## What might go upstream

Keep a short candidate list and revisit it after operator review:

| Candidate | What this iteration can teach us |
| --- | --- |
| Dense instrument chrome | Useful spacing, type and anchored-layout recipes without changing reading pages. |
| Compound agent/status glyphs | How provider shape, context ring, state dot and stale texture coexist at small sizes. |
| Motion and effect tokens | Durations, easing, glow strength and an effects switch that stay useful across many active items. |
| Lens pinning recipe | How preview, detail and persistent side inspection share selection and content state. |
| Small mutable crossfilter store | A convenient AIUI pattern for inserting/updating local records and refreshing coordinated views. |

The mock's CSS is a trial, not an upstream patch. Record accepted and rejected
experiments in its Markdown notes. Promote a pattern into `aiui-design` or
`aiui-viz` when it earns reuse, updating that package's documentation and examples
together. The young AIUI library may change pragmatically; assess affected demos
instead of inventing a backwards-compatibility obligation. No upstream design
source was changed for this iteration.

The current review surfaces are the [overview study](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/053-orchestrator-overview.md),
[session study](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/054-orchestrator-session.md) and
[shared preview lab](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/055-orchestrator-mock-lab.md).
These source links become available after publication; the local lab serves the
current working pages and their README notes.
