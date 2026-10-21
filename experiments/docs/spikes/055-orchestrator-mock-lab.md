# 055 — AIUI mock lab and development boundaries

**Revised 19 October 2026:** the two disposable studies now run as actual Solid 2 /
AIUI applications. The original plain-DOM screens were replaced. The
[overview](053-orchestrator-overview.md) adds native Mosaic category widgets and
presentation-only group collapse/focus; the [session](054-orchestrator-session.md)
adds request-level usage attribution and metric-based transcript navigation.

Both expose scoped controls/actions, durable state and cell projections through
AIUI's actual tool registry. Vite's AIUI plugin compiles source/factory attribution
before Solid. The requested internal development dock mounts its Tools, Source,
keys and oracle/live UI; tool/source checks need no model. Provider connections
remain operator initiated and were not exercised. No server-side live-session
backend or production client/coordinator is implied.

A shared **Space-led command map** uses AIUI's key layers and mode engine. Grouped
commands share actions with buttons/tools; ordinary typing and native input
controls retain their keys. The layout, shortcuts and timeline alternatives remain
provisional preferences rather than a finished interaction contract.

The preview retains available ports, per-instance state/cache directories and
independent shutdown. The same-origin host serves matching DuckDB worker/WASM
assets and rendered Markdown notes. Source-linked imports are explicit private
study dependencies; no AIUI source or fonts were copied.

**Validation:** 23 Node tests, 10 Vitest keyboard/cell tests, 24 real browser
DuckDB assertions, strict TypeScript checking and Vite production compilation.
Session browser checks include 29 assertions at each of 1440×900 and 390×844 CSS
viewports. Actual Mosaic multi-selection, group scope, dock tools/source and
keyboard/typing behavior were inspected. These qualify mock/frontend behavior,
not provider compatibility or physical-phone input.

Graph hot edits retained database identity, filters and focused groups; session
graph/UI edits retained draft, selection, metric controls, pinned source and
scroll. This needed a literal call-site HMR acceptance marker as well as
`hotCellGraph`. Source inspection and this measurement are recorded as an upstream
documentation/tooling candidate, alongside a focused-Lens HMR diagnostic and
bulk-render performance observations. No upstream library was edited.

Run from `experiments/`:

```sh
pnpm install
node spikes/055-orchestrator-mock-lab/serve.mjs
```

See the [runbook](../../spikes/055-orchestrator-mock-lab/README.md) for exact source
links, tooling versions, test commands and limitations. Provider experiment spend:
**$0**; implementation-assistant costs are not available.

The [development-flow sketch](../../../docs/plans/agent-orchestrator/development-flow.md)
and [visual direction](../../../docs/plans/agent-orchestrator/visual-direction.md)
record this iteration without selecting final packaging or live-runtime policies.

## Round A extension

The host now also serves the [059 native-history reader](059-historical-viewer.md)
at `/history/` and the [060 authentication simulation](060-authentication-flows.md)
at `/auth/`. [058](058-native-history-access.md) supplies 16 real native API exports
through GET-only local catalogue/document routes, with original histories left
unchanged. The exports stay in ignored artifacts and are not bundled into the
application. Authentication previews map to existing launcher/configuration
operations; no login, profile edit or provider request is executed by the mock.

The combined Vitest set now passes 34 tests; host/read-adapter Node checks and
actual-export Python checks pass, as do typechecking, Vite compilation and strict
documentation builds. See the [next-round tracker](../../../docs/plans/agent-orchestrator/next-mock-rounds.md)
for per-study evidence and the review gates before ingestion/statistics and
management work. The earlier measurements above remain the original two-study
baseline.
