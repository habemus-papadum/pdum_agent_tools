# 059 — Rich native history reader

**19 October 2026 · ready for interaction review.** A real read-only viewer beside
054 can now browse the sixteen native captures from
[058](058-native-history-access.md): seven Codex threads and nine Claude sessions.
It keeps the transcript central, with a provider catalog and a collapsible source
or raw-record inspector. DuckDB is reserved for the later statistics slice.

## What to review

Open the shared lab at `/history/`. Search a capture, inspect native messages and
tool results, jump to an item, and compare its readable content with the preserved
raw record. Source & coverage keeps capture time, native method/version, host,
profile, read gaps and ancestry available. Space opens the shared command map;
all shortcuts and agent tools dispatch the same reader actions. The tool filter
includes Claude tool blocks within their native assistant/user message roles.

Real records show Codex commands, patches, compaction and fork ancestry, and
Claude text, thinking, tool calls/results, model identity and usage. Native
response IDs deduplicate the usage ledger; Claude's input, cache-read and cache-
creation counters remain separate. Tools have no independently inferred charge.
Cost and current context occupancy are unknown. Stored runtime metadata does not
establish present execution state or task completion.

The explicitly separate **synthetic rendering bench** exercises Markdown tables,
colored TypeScript, inline/display TeX, Mermaid, a minimal embedded raster image,
tool-shaped content and an unknown block. These are renderer checks, not evidence
that either native history API returns every rich-content type. Uncaptured image
locations remain references. Unknown blocks and fields remain in the exact source
JSON, including native read errors.

## Scope decisions and contracts

The user had already chosen native read surfaces, read-only interaction, a
separate rendering specimen, and source-linked Solid/AIUI. Provider projection,
keyed inspector replacement, cancellation and layout were delegated engineering
choices. Catalog/transcript density, folding and phone reflow are mock questions
for review. Pricing, current context reconstruction, complete child discovery,
continuation and live attachment are deferred until their corresponding slices;
this study adds none of those operations. Owners are O09 session workspace, O10
transcript/tools, O14 history/branching and O20 component lab.

- **RC-01/RC-08:** the inspector labels native source/runtime uncertainty and
  preserves provider-specific metadata; no “completed” state is inferred.
- **RC-02/RC-05:** browser networking is GET-only to existing local exports. Its
  action registry has no native start, resume, subscribe or fork operation.
  058 separately verifies passive native access.
- **RC-07:** source gaps remain visible. A failed document has its requested key
  and error; a superseded read is aborted. Old content is hidden during a pending
  replacement, and source/raw-record identity changes atomically with the view.

## Implementation and evidence

The app follows pure adapters → scoped store/cells → components → application.
Actual AIUI components provide controls, cell status, JSON/text inspection, TeX,
Mermaid and the page boundary. The existing 055 source compiler, palette, command
map and development dock are reused. Markdown tokens render as JSX and supported
fenced languages use Highlight.js. The count-once principle from 054 is retained;
its illustrative pricing code is not reused for native evidence. No production
package or upstream AIUI source was changed.

Validation on macOS, Node 26, pnpm 11.9.0, Solid 2.0.0-rc.13 and source-linked
AIUI 0.21: shared typecheck passed; **9 pure/cell tests** passed, including native
object/provenance preservation, Claude model/tool attribution and duplicate
response counters, every graph input, failure recovery, and a late superseded
response. **23 browser checks passed at each of 360/390/414 × 844 and 1440 × 900
CSS pixels**, with no horizontal overflow, page faults, console warnings or
errors. Checks exercised source/raw replacement, actual rich components, search,
tool filters, keyboard palette, focus and source stamps. Desktop and phone
screenshots were visually reviewed in the tool output. The browser tool denied
file output under the local workspace, so this report does not claim saved
screenshot artifacts.

Component and graph HMR edits both preserved a real Claude selection and transcript
search; all five cells settled ready afterward. The corpus originates in existing
bounded research captures; this viewer made no paid calls. Raw data stays under
ignored `artifacts/058-native-history-access/`, not in tracked source or this report.
See the [runnable README](../../spikes/059-historical-viewer/README.md) and
`history.browser-check.mjs` for reproduction.

The next review should judge the three-pane density, source/raw interaction,
tool folding, and phone stacking. Larger-history rendering/pagination, richer
image/child examples, complete usage coverage and production shared components
remain unqualified. A compact provenance inspector and a rich-content renderer
are potential upstream extractions after a second reviewed consumer.
