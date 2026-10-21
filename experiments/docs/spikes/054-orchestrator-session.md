# 054 — Session navigation, request telemetry and source Lens

**Status:** disposable Solid/AIUI application study. **Date:** 19 October 2026.
All conversation, file, usage and price values are invented fixtures.

## Question and candidate

Can a conversation-first view support deep inspection without moving metadata
into the foreground? The [session workbench](../../spikes/054-orchestrator-session/README.md)
now combines compact per-item usage, running totals, request attribution and a
switchable top/side navigator with its source-selection and explicit-prompt flow.

Choose time, cumulative known cost, cumulative input/output tokens or current
context. Clicking a plotted item navigates the transcript without changing its
chronological order. Source references use the actual AIUI Lens for preview/detail;
Pin is application-owned. The transcript scrolls independently and the composer
stays at the bottom. Scenario controls/help stay in the separate Study menu.

## Data meaning

Model request rows own token usage and cost. Tool rows reference the originating
request, expose duration/status and contribute no independent model charge. The
fixture includes cache reuse, growing context, a costly trace read, a failed test
command, a missing usage record and a compaction drop from 59k to 16.5k. Context
is a snapshot; compaction cannot subtract already-used tokens or already-estimated
request costs.

The default five known requests total $0.17296 and 141,920 input/output tokens;
89,000 cached tokens are already included in 133,700 input tokens. One of six
requests lacks usage and compaction cost is unavailable. Totals explicitly show
this incomplete coverage. Prices ($2/M input, $0.20/M cached input, $8/M output)
are illustrative accounting fixtures, not current provider prices or billing.

## Implementation and evidence

The former plain JavaScript DOM runtime was removed. The active implementation is
Solid 2 with the source-linked AIUI library: scoped durable controls/signals/actions,
`hotCellGraph`, ledger/navigation/source cells, `CellView`, actual `Lens`, named
`bridgeEffect` boundaries, registered `orchestrator-session` tools and `PageBoundary`.
The shared lab supplies Vite compilation, the source processor, keyboard palette
and development dock. No provider connects automatically.

Ten pure tests pass under Node 26.10.0: source provenance/missing files, immutable
submission snapshots, explicit intent, ended-turn/unknown-ack races, request cache
partitioning, missing coverage, compaction and duplicate rejection.

```sh
node --test spikes/054-orchestrator-session/model.test.mjs spikes/054-orchestrator-session/telemetry.test.mjs
```

Three headless `cellHarness` tests also pass through the shared Vitest runner:
usage coverage changes ledger and navigator; metric changes navigator semantics
without mutating accounting; both source choice and scenario change the source cell.

The actual Solid rewrite passed **29 browser assertions at each of 1440×900 and
390×844 CSS pixels** in Chrome 155. `session.browser-check.mjs` drives the registered
tools and checks cell readiness, control dependency updates, source listing/reading,
navigation, native Lens/pin state, immutable prompts, delivery races and geometry.
Native Space → Navigate → failed-command selection and typing isolation were
verified. The actual dock's Tools log and Source browser were inspected; neither
Oracle nor Live was connected.

Harmless graph/UI source edits retained the document (`performance.timeOrigin`),
draft, comment, selected lines and control settings. The UI edit additionally kept
the pinned source and the transcript's **240 px** scroll position. The graph has
an explicit call-site `import.meta.hot.accept()` so Vite 8 recognizes the boundary;
`hotCellGraph` continues to own disposal/rebuilding. Library documentation/tooling
should explain this requirement.

Ordinary interaction checks produced no Solid diagnostics. UI HMR with a focused
native Lens trigger emitted one upstream focus-out `STRICT_READ_UNTRACKED` warning,
while preserving state and functionality; this is recorded for an upstream fix.
Shared dev-server restarts exposed stale optimized-dependency 504 responses
from the Solid performance-track preload; excluding it from prebundling fixed the
clean reload. Row memo boundaries removed excessive telemetry-cell fan-out. The
final hard reload and 29 desktop assertions produced no console errors or warnings.
Neither finding is evidence of provider recovery behavior. The earlier DOM
revision's tests are not used to qualify this rewrite.
Provider cost is zero; implementation-assistant usage is not exposed here.

## What remains provisional

The [essence note](../../spikes/054-orchestrator-session/README.md) is the input to
a later concrete spec. Top chart versus rail, compact metric density, source pane
ownership and shared keyboard behavior remain interaction candidates. AIUI Lens
has no controlled Pin hook in this revision; the app keeps state in its store and
uses the rendered close button when pinning. A presentation hook may be worth
adding upstream after review.

Before real data, resolve attribution/coverage, queue placement/editing, annotation
anchoring/storage, provider-specific receipt evidence and acknowledgement
reconciliation. The fixture's retained historical bytes are not a universal
backend promise. Packaging, local development isolation and recovery remain
separate work. No code was published or committed and no upstream package changed.
