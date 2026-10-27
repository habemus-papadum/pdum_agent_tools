# Native history reader

**Reviewed and wrapped up for this mock phase, 24 October 2026.** Start with the
[handoff](HANDOFF.md) for the changes, evidence, validation, preview ownership,
limitations and suggested return to the other orchestrator mocks. No additional
history experiment is a prerequisite to moving on.

**Rich-message review:** select **Rich messages · prompts and responses** under
Families & examples, or open `/history/?group=rich-messages`. Six native-message
bookmarks reveal actual human image prompts and assistant mathematical updates/
finals. The [example guide](../../docs/spikes/059-rich-messages.md) contains direct
links and the cases not yet found. These independent captures assert no ancestry.

## Review revision — 24 October 2026

The operator approved a second iteration over real, substantial conversations:
compact prose with outline/reading levels, expandable tool pills, a navigation
minimap, concise optional inspection, and image thumbnail → preview → detail.
The small initial captures are real experiments, not everyday-work examples;
the renderer bench is synthetic. Those distinctions must be legible immediately.

This slice follows pure presentation/asset projections → scoped controls/cells →
components → browser qualification. Acceptance: preserve native chronology and
identity through grouping/expansion/filtering; distinguish reported phase from
unknown; use only passive history reads (RC-01/05/08); retain missing fields and
read failures (RC-07); test a long real trace, rich rendering, keyboard/phone
navigation and hot reload. Raw histories and assets stay ignored and local.

Already answered: dense graphical presentation, full prose may be elided,
shared direction with the live view, real examples preferred. Mock experiments:
density levels, window size, minimap and thumbnail interactions. Delegated:
corpus selection/read adapters and display-only grouping. Deferred until real
storage/continuation work: catalogue paging contract, fork-tree placement, S3
asset resolver and MotherDuck cross-links. No live control or billing estimator
is introduced here. Missing, measured and not-yet-implemented metrics stay distinct.

Read-only Round A study: real Claude SDK and Codex app-server history, presented
as a transcript with native provenance, coverage and raw records beside it.
The separately labelled synthetic bench exercises rich content absent from the
captured corpus. This is disposable study code, not a production history SDK.

Run from `experiments/`:

```sh
pnpm --filter @agent-spike/orchestrator-mock-lab dev
```

Open the printed origin at `/history/` or `/059-historical-viewer/`. The shared
055 host serves `GET /__history/catalog` and
`GET /__history/document/<key>` from spike 058's ignored export. Generate that
export following [058](../058-native-history-access/README.md). A missing export
has an explicit error; the synthetic bench remains usable. Refresh rereads local
export files and never regenerates them or contacts a provider.

The catalog separates substantial **Real work** histories from sixteen small
real experiments. Provider and text filters narrow that catalog. **Outline**
elides all prose, **compact** shows excerpts, and **reading** expands messages.
Tool pills expand individually; native Codex turns and the current display window
have expand/fold actions. IDs and full paths are available through each item's
raw-record icon. “Tool” includes Claude tool-use/result containers without
misidentifying tool-returned images as human uploads.

The minimap covers the full filtered chronology; its box marks the mounted window
of 80/160/320 items. Clicking it or Start/End can jump outside that window. The
whole export is still downloaded/parsed. **Source & coverage** holds provenance,
gaps, ancestry and the request ledger. Space opens the command map; `j`/`k` move
through items, `s` toggles sessions, `m` shows the minimap, `r` raw, `p` provenance,
and `1`/`2`/`3` select outline/compact/reading. `i` finds images, `e` finds
operations, `t` switches sequence/time, `u` toggles update pills and `f` refreshes.

Image thumbnails use Lens hover/focus → preview → click detail → optional pin.
Embedded bytes and listed exported raster assets are supported. Copied files
explicitly say their historical byte equality is unverified. Thumbnails currently
use full image bytes; no thumbnail server, S3 client or MotherDuck history reader
is implied. Missing references and failed image loads remain distinguishable.

The reader has no turn, resume, fork, live-subscription, login or profile-write
action. Stored runtime metadata describes its source, never current execution
elsewhere. Tokens are native response fields, with repeated response IDs counted
once; cost and context occupancy remain unknown. Claude input/cache-read/cache-
creation fields stay separate. Tools do not receive a separate inferred bill.

## Source and framework

- `src/model/native.ts`: pure provider projections, unknown-block preservation,
  response attribution, filters and formatters.
- `src/model/presentation.ts`: chronological pill groups, source-reported phase,
  display window and full-document minimap. These do not rewrite native data.
- `src/model/store.ts`: scoped controls, view-only actions and durable selections.
- `src/model/graph.ts`: cancellable local GET cells, projections and standard AIUI
  tools at `window['__native-history']`. Expected read failures are explicit
  values so another source remains selectable; old content is hidden while a
  replacement is pending. Source/record boundaries remount keyed JSON views.
- `src/ui/`: actual Solid 2 components. AIUI supplies `CellView`, controls,
  `JsonView`, `TextView`, `TeX`, `Mermaid`, `PageBoundary`, and the shared 055
  command palette/dock. Markdown tokens are rendered as JSX; Highlight.js colors
  supported code languages. All study CSS is scoped under `.history-app`.

Native envelopes remain unchanged. The rendered projection is deliberately
incomplete: unknown provider items remain inspectable. Embedded raster bytes and
explicit exported assets render as images; references without captured bytes
remain labelled references. Raw HTML is text, and links require an explicit
click. No raw capture is checked into this folder.

## Checks

The [behavior evidence inventory](../../docs/spikes/059-evidence-inventory.md)
records the audit behind operation-aware presentation, background jobs and
children, time/gap axes, settings tracks and image placement. Re-audit the existing
exports without contacting a provider:

```sh
node spikes/059-historical-viewer/audit-evidence.mjs
node --test spikes/059-historical-viewer/audit-evidence.test.mjs
```

Run those commands from `experiments/`. Output stays under ignored
`artifacts/059-evidence-inventory/`; it contains native pointers/hashes, while the
report contains only aggregate findings. Text markers are discovery candidates.
These audit commands do not modify the viewer or its captures.

The [family follow-up](../../docs/spikes/059-agent-family-evidence.md) now supplies
separate Codex/Claude parent-child evidence and records duration semantics. Its
exports are available through the Captured family selector. `audit-recorded-timing.mjs` also
compares reported durations with receipt intervals in existing 032/057 captures;
`audit-recorded-timing.test.mjs` tests missing endpoints and per-client clocks.

```sh
pnpm --filter @agent-spike/orchestrator-mock-lab typecheck
pnpm --filter @agent-spike/orchestrator-mock-lab exec vitest run ../059-historical-viewer/src/model
```

In the actual Vite browser page:

```js
const { runHistoryBrowserChecks } = await import('/059-historical-viewer/history.browser-check.mjs');
await runHistoryBrowserChecks();
```

The browser check is inspection-only and emits names, counts and booleans. It
expects both providers and the everyday/rich corpus exported by 058; it
does not fabricate missing native evidence. Current results and limitations are
in the [spike report](../../docs/spikes/059-historical-viewer.md).

### Validation — 24 October 2026

- **16 model/cell checks** passed, covering native preservation, explicit phases,
  image origin/sidecars, request deduplication, math and full-history window jumps.
- **54 browser checks passed at 1440×900 and 360×844 CSS pixels**, against all
  23 catalog entries, including the 3,948-item conversation, genuine assistant
  Mermaid/mathematical prose, Claude user/tool images and copied Codex assets.
  Checks include hover/detail/pinning, native order, fold/expand, keyboard tools,
  raw identity, source stamps and no page overflow/faults. Layouts were inspected.
- Shared typecheck and Vite build passed. Two actual local HTTP/server checks
  passed, including listed asset bytes, unknown-asset rejection and GET-only
  operations. The build still reports large Mermaid/ELK/Mosaic chunks.
- UI and graph hot edits preserved selected source, query and density; all eight
  cells settled ready. Store edits still cause a page reload by design.
- Final browser runs had no errors. Remaining diagnostics: bounded projection
  `HOT_SCOPE_TIME` observations of 8.6–21.7 ms, and the existing AIUI Lens
  focus-out `STRICT_READ_UNTRACKED` at `lens.tsx:284` when a focused lens is
  replaced. No warnings were suppressed. Worker projection/true incremental
  retrieval and the focused-lens lifecycle are follow-up engineering items.

Environment: macOS, Node 26.10.0, pnpm 11.9.0, Solid 2.0.0-rc.13, source-linked
AIUI 0.23.0+dev. The [058 qualification](../058-native-history-access/README.md)
records seven Python checks, original transcript hashes, native API versions and
reader cleanup. New provider inference spend: **USD 0**. Native data stays ignored.

### Family/time iteration — reviewed

Approved: family navigation, optional update pills, meaningful duration, image/event
finding, and sequence/calendar-time comparison with marked adjustable gap compression.
The [availability ledger](../../docs/spikes/059-data-availability.md) now records
field ownership, missing-data states and versioned interpretation for future schemas.

This slice follows pure native/family/time projections → scoped controls/cells →
compact components → browser checks. RC-01/05 keep reads passive; RC-08/09 preserve
provider identities/coverage; RC-10 governs time, durations and child completion.
Acceptance covers native identity through lane switches, repeated Claude response
IDs, missing clocks/parents, gap transforms that preserve selected-lane activity,
forward/inverse navigation, duration scope, phone layout, keyboard and HMR.

No product answer is blocking this mock: fixed selectable gap thresholds, lane
selection/width and display tracks are provisional experiments. Automatic gap
policy, authoritative enrichment/cost sources and a production graphics backend
remain deferred. This iteration uses the already collected native family exports;
no new inference or live agent control is involved.


The current family selector opens three separately captured groups without
changing the individual-capture catalogue. Each actor has a distinct export key,
including Claude children that share a native root session ID. Map lane selection
is independent of the transcript actor; an empty lane selection remains empty.
Time gaps use all records in selected lanes before text/type filtering. UTC,
threshold, folded duration, unavailable clocks and unassigned shared usage remain
visible. Cost/context are explicit unavailable tracks; no estimator was added.

Family browser qualification (actual local exports):

```js
const {runFamilyBrowserChecks} = await import('/059-historical-viewer/family.browser-check.mjs');
await runFamilyBrowserChecks();
```

**37 model/cell tests and 53 family browser checks** passed (1440×900, 390×844).
The individual-history suite still passes all 54 checks. Shared typecheck/build,
eight reader/HTTP checks and strict documentation checks passed. Family/actor,
selected lanes, axis and detail controls survived UI and graph HMR. Browser family
runs had only bounded `HOT_SCOPE_TIME` diagnostics (8.2–36.5 ms), with no errors.
The full Codex family response is approximately 74.5 MB; windowing and SVG binning
do not make transfer/parsing incremental. No new provider inference was performed.

### Rich-message bookmarks — 24 October follow-up

The **Rich messages · prompts and responses** collection adds six native examples
from three independent captures: three human image prompts, two mathematical
finals and one mathematical update. It starts on an actual user image rather than
at the beginning of a long trace. Sidebar buttons and `?group=rich-messages&example=…`
links resolve native identities and expand the target. No relationship is invented
between these captures. Missing human TeX and assistant-image cases remain explicit.

`rich-examples.browser-check.mjs` passed 63 checks at desktop/phone widths and five
checks for each fresh direct link. The shared model suite is now 40 checks, and
reader/HTTP coverage is 12 checks. See the [example guide](../../docs/spikes/059-rich-messages.md)
for exact links and qualification. Initial selection is derived, not an effect
that rewrites its inputs. The existing capture catalogue is unchanged.
