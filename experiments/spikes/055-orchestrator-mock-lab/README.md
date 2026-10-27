# Orchestrator interaction lab

**Disposable AIUI applications, revised 19 October 2026.** The overview and session
studies now use actual Solid 2 components, scoped AIUI controls/actions, durable
state and cell graphs. The first round was plain DOM with AIUI styling and a
DuckDB adapter; that implementation has been replaced. These remain interaction
experiments whose notes will feed a later specification.

| Study | Page | Design intent |
| --- | --- | --- |
| Agent overview | `/053-orchestrator-overview/` | [Overview note](../053-orchestrator-overview/README.md) |
| Conversation, source and usage | `/054-orchestrator-session/` | [Session note](../054-orchestrator-session/README.md) |
| Read-only native history | `/history/` (`/059-historical-viewer/`) | [History note](../059-historical-viewer/README.md), [native access evidence](../058-native-history-access/README.md) |
| Authentication ownership | `/auth/` (`/060-authentication-flows/`) | [Auth operation map and note](../060-authentication-flows/README.md) |
| Ingestion and statistics | `/ingestion/` (`/061-ingestion-statistics/`) | [Real ingestion/query study](../061-ingestion-statistics/README.md) |
| Launcher connections | `/connections/` (`/062-launcher-connections/`) | [Local discovery and endpoint study](../062-launcher-connections/README.md) |
| Profile workbench | `/profiles/` (`/063-profile-workbench/`) | [Native lab profile operations](../063-profile-workbench/README.md) |
| Owned live sessions | `/session-lab/` (`/067-live-session-workspace/`) | [Real Codex/Claude prompts and live/history comparison](../067-live-session-workspace/README.md) |

The [three-round tracker](../../../docs/plans/agent-orchestrator/next-mock-rounds.md)
records the next phase. Round A is reviewed; Round B builds disposable working
applications over real local data and operations. Round C remains queued. Configuration
choices map to existing tool owners, including the ingestor's `history.yaml` and
the launcher/profile APIs. The mock host's export-directory option is only a local
reader input, not another ingestor configuration schema.

## Run and source linking

From `experiments/`, with the AIUI checkout linked and its dependencies installed:

```sh
pnpm install
node spikes/055-orchestrator-mock-lab/serve.mjs
```

Round B's working backends also use the repository-root Python environment and,
for statistical queries, the separate `typescript/` workspace installation.
They invoke those existing owners directly; dependencies are not merged into
the experimental workspace. Follow the 061/062/063 runbooks for input preparation
and supported operations. Captured data and lab profiles are ignored local files;
a fresh checkout shows unavailable/empty data until explicitly prepared.

For concurrent development, `PDUM_INGESTION_LAB_DIR` and
`PDUM_PROFILE_LAB_DIR` select different lab data directories. Preview instances
already have independent HTTP ports and Vite caches; they must also use different
data directories when testing independent writable scenarios.

The root repository's `./scripts/link-aiui.sh` creates `.dev/aiui`, normally pointing
to `~/src/pdum_aiui`. The private study manifests explicitly link AIUI's
public package exports to that checkout; they do not copy source. Repoint that
link and reinstall if changing checkouts. Keep the compiler, runtime and design
source together. The application is not a new published library.

The preview host owns one HTTP listener, an OS-allocated port and a temporary
instance directory with its Vite cache. It defaults to `0.0.0.0`; `PORT` and
`MOCK_HOST` select an explicit endpoint. `/__instance` identifies the PID, URL and
state directory. Ctrl-C/SIGTERM shuts down this instance. A final CLI exit sweep
removes late cache writes from Vite's optimizer. Real two-process checks verify
separate ports/state and that stopping one leaves the other available.

Vite runs `aiui()` before the Solid compiler, with all eight sibling apps in
`stampRoots`. It supplies actual factory/source attribution, source browsing and
hot updates. Shared framework imports resolve through the host's declared
package exports so the linked checkout and app use the same runtime. Versions:
Solid / `@solidjs/web` **2.0.0-rc.13**, Vite **8.3.4**, Mosaic **0.28.1**,
DuckDB-WASM **1.33.1-dev64.0**; Flechette **2.5.0** matches the linked connector.
Dependencies and lockfile stay in `experiments/`, separate from production.

## What is real and what remains simulated

| Facility | Current implementation |
| --- | --- |
| Overview filters | Real DuckDB-WASM worker/table, Mosaic coordinator and `MosaicView` category bars; AIUI selection dimensions and crossfilter tools share the same selection. |
| State and dataflow | Scoped controls/actions, durable fixtures/resources, disposable `hotCellGraph` projections and real Solid components. |
| Keyboard | AIUI mode engine owns command-map modes; AIUI key layers dispatch the same app actions as buttons/tools. |
| Source inspection | Actual AIUI Lens, source processor stamps, `locate`, `sources` and `source`; pinning is application-owned. |
| Dock | Actual `VoiceDock`, tool log, key/source panels and oracle/live UI from the linked AIUI checkout. |
| Historical reader | GET-only access to 058's provider-native exports, retaining raw payloads and source/coverage; a separately labelled rendering specimen covers rich content. |
| Authentication | Simulation with exact existing launcher operation previews; no credentials read, login started or profile configuration written. This study omits the provider-capable dock. |
| Round B operations | Separate `/__ingestion/` and `/__management-lab/` handlers use existing ingestion/launcher libraries. Writes target explicit lab state; native history routes stay GET-only. See each study for exact supported operations and evidence. |
| Live workspace | `/__session-lab/` lazily owns a Python service composing existing launchers. Explicit launch creates only owned lab sessions; browser Codex RPC / official Claude SDK own conversation control. The preview closes the service and its provider runtimes on graceful shutdown. |
| Agent activity and usage | Overview/session fixtures are synthetic; historical usage is shown only when captured. Study controls do not drive a real orchestrator or conversation. |

The history routes read `experiments/artifacts/058-native-history-access` by default;
`PDUM_HISTORY_EXPORT_DIR` selects an explicit different export. Generate it through
058's documented native-reader workflow. Listed raster copies under the export's
`assets/` directory are served by `/__history/assets/<hash>.<extension>`; arbitrary
original machine paths are not routes. Missing exports produce an honest empty
catalogue; the rendering specimen remains available. `/__history/catalog` returns
metadata and `/__history/document/<key>` reads a catalogue-listed document. Opening
or refreshing the viewer neither regenerates exports nor resumes a provider runtime.
Raw captures remain ignored and are not bundled into builds or source manifests.

Each overview tab owns an in-memory database. Updating a fixture updates rows;
Mosaic charts and the collection refresh against the same table. Snapshot reads
await Mosaic's public pending event queues, so several category writes settle
before producing a combined result. There is no JavaScript filtering fallback.
The session's ledger counts usage once per model request, attributes related tool
items to that request, distinguishes context occupancy from cumulative tokens,
and retains unknown usage/compaction costs explicitly.

The existing dock is **internal AIUI lab scaffolding**, mounted here at the user's
explicit request for these local studies. This does not establish a production
SDK dependency on it. Tools and source inspection work without provider calls.
The oracle/browser live modes require a suitable key and an operator-initiated
connection. No keys are injected automatically, no oracle session was connected
for validation, and no server-side live-session backend is implemented. Its
capability probe returns an explicit unavailable response.

## Things to try

- In the overview, open Filters and click actual provider/host/state bars. Shift
  supports multi-selection. Use the native selects or `cross-filter` tool to
  exercise the same declared dimensions. Inspect the generated SQL and schema.
- Group the filtered agents, collapse one/all groups, expand all, or focus one
  group. These are presentation choices; filtered counts/costs remain unchanged.
- Press **Space** outside a text field to discover grouped commands. A group key
  narrows the map; Escape backs out. Direct shortcuts cover navigation, grouping,
  layout, sorting, density, filtering and inspection. Text inputs, selects,
  composition, modifier shortcuts and other modal surfaces retain their keys.
- In the session, compare the top chart with the side rail, switch time/cost/token/
  context measures, and jump to an expensive request, failed tool or compaction.
  Read the compact attribution strip or hover for detail.
- Open the **AIUI** dock: Tools shows the real registry, generated tool descriptions
  and call log; Source shows the compiled apps' source tree. Standard reports
  expose controls, cell state and dependency edges. Compiler checks and Solid
  diagnostics are active; this does not invent a separate universal lint tool.

The tool namespaces are `orchestrator-overview` and `orchestrator-session`, also
available through `window.__AIUI__.tools`. The study-specific `window.mockOverview`
and `window.mockSession` APIs remain QA affordances. Their full state is richer
than the deliberately concise oracle-facing reports.

Markdown links still render through the shared `markdown-page.mjs` reader with
headings, lists, tables, code and relative links. Append `?raw=1` for the source.
The Markdown files remain authoritative; the reader is disposable lab plumbing.

## Verification and limits

The original Round A implementation passed 058's four actual-export Python checks and two Node
transport checks; 059's nine adapter/cell tests and 23 browser assertions at
360/390/414/1440 CSS widths; and 060's 15 model/cell tests and 41 browser checks.
That revision's combined Vitest set had 34 tests. The host has an additional actual HTTP
test for GET-only catalogue/document access, unchanged exports and unknown keys.
Each report distinguishes real API evidence from renderer/authentication fixtures.
That revision's typechecking, Vite compilation and documentation validation passed.
The 24 October [history handoff](../059-historical-viewer/HANDOFF.md) and
[authentication handoff](../060-authentication-flows/HANDOFF.md) record later
review changes and their validation. The
earlier overview/session validation below remains the recorded baseline.

```sh
node --test spikes/053-orchestrator-overview/model.test.mjs \
  spikes/054-orchestrator-session/model.test.mjs \
  spikes/054-orchestrator-session/telemetry.test.mjs \
  spikes/055-orchestrator-mock-lab/server.test.mjs
pnpm --filter @agent-spike/orchestrator-mock-lab test
pnpm --filter @agent-spike/orchestrator-mock-lab typecheck
pnpm --filter @agent-spike/orchestrator-mock-lab build
```

**Pre-Round-A baseline:** 23 Node tests (12 overview, 10 session/provenance/telemetry, one
actual two-server isolation test), and 10 Vitest checks (five keyboard/mode-engine,
two overview cell-graph and three session cell-graph tests). Typechecking and the
Vite production compilation pass. Generated output stays under ignored artifacts;
a successful compilation does not qualify static deployment, credentials or a
production coordinator. The browser fixture host supplies worker/WASM routes.

The real browser database check still passes all 24 assertions:

```js
await (await import('/053-orchestrator-overview/data-engine.browser-check.mjs')).checkDataEngine()
```

Chrome inspection covers actual Mosaic multi-selection and tools, collapse/focus,
keyboard versus typing, source attribution and dock Tools/Source. The session has
29 browser assertions exercised at 1440×900 and 390×844 CSS viewports, including
telemetry, lens/pin, prompt snapshots, receipts and navigation. Narrow-viewport
checks are not physical-phone or mobile-keyboard qualification.

Actual graph edits preserve the overview database instance, filters and group
focus, and the session draft, source selection and metric controls. A session UI
edit also retained the pinned pane and conversation scroll. Store/wiring edits
and explicit reloads may reset state. Vite requires a **literal call-site
`import.meta.hot.accept()`** for static boundary recognition; passing its handle
to the library alone was insufficient in this setup. The graph owns rebuilding;
the call-site marker makes that ownership visible to Vite.

Remaining upstream/performance candidates include the graph-boundary documentation,
a native Lens focus-out diagnostic when its focused trigger is replaced by HMR,
and measured bulk-render diagnostics at 500 agents. These are recorded in the
individual notes; no diagnostic is silenced and no upstream source was changed.
The command map and timeline presentations remain provisional.

Experiment provider usage/spend is **zero**. Implementation-assistant usage is not
exposed. Operator-initiated dock sessions would have their own usage.

## Development and packaging follow-up

[O22](../../../docs/plans/agent-orchestrator/components/22-development-delivery.md),
the [development-flow sketch](../../../docs/plans/agent-orchestrator/development-flow.md)
and [visual direction](../../../docs/plans/agent-orchestrator/visual-direction.md)
record the remaining browser/Electron, live coordinator and reusable-component
questions. These mocks now exercise real frontend primitives; their fixture
schemas and local host still do not settle production package boundaries.


### Family transport — 24 October iteration

`GET /__history/families` lists metadata for three explicitly selected captured
families; `GET /__history/family/<id>` reads one complete bundle. Native documents
and provider-specific relationship evidence remain unchanged. Claude child keys
retain their separate agent identity even when native session IDs are shared.
Missing selected runs are explicit, and all operations remain GET-only.

`PDUM_HISTORY_FAMILIES_CONFIG` can select different local export directories using
`{"families":[{"id":"study","title":"Study","provider":"codex","directory":"relative/run"}]}`.
Relative directories resolve against that file. This is disposable lab input
selection, not a coordinator/profile configuration scheme. Default runs are the
qualified 058 Codex family and the two Claude families. No capture is regenerated
or provider contacted by browsing.

Metadata currently requires parsing the selected native files; full family loading
is not paginated. The Codex response is approximately 74.5 MB. Eight reader/real
HTTP checks passed; see `family-reader.test.mjs`, `server.test.mjs` and the
[availability ledger](../../docs/spikes/059-data-availability.md).
