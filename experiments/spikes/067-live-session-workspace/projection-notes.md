# Live and saved-history projections

**25 October 2026.** Disposable adapters in `src/model/projections.ts` feed one
transcript display. Their `DisplayItem` and `Usage` shapes are local view inputs,
not a proposed cross-provider SDK or persisted schema.

## What is shared

Both views can render user/assistant prose, expandable tool operations, reasoning,
explicit errors and unfamiliar records. Each row retains native identity when
available and a raw source record. Saved-history projection reuses 059's pure
native adapter and response-usage ledger. This leaves one place to carry forward
its source-specific interpretation and missing-data rules.

Codex command input/output render as one operation in both views. Claude's tool
use and tool result remain separate blocks because that is how the source presents
them. A shared renderer does not require the same number or arrangement of native
records. The comparison panel reports rendered block counts, native-ID overlap
and available measurements; none is a claim of complete transcript equality.

## What remains provider- and source-specific

| Concern | Live interpretation | Saved interpretation |
| --- | --- | --- |
| Codex messages/tools | Start, delta and completion frames update one native turn/item identity. Completed content replaces accumulated deltas. | Native items are complete read records; there may be no stream or request-usage evidence. |
| Claude messages/tools | Streamed content blocks reconcile with assistant records, so the final assistant body does not appear twice. Tool result keeps its native tool-use reference. | Official helper wrappers contain messages/blocks and can omit stream/control records. Wrapper UUID and model-response ID have different scopes. |
| User input | A local receipt is provisional until a native echo appears. Claude uses the supplied UUID when echoed; Codex falls back to exact text in pending arrival order. | Native user-message identity is authoritative for the saved record. A user-role container can also contain tool output. |
| Codex usage | Latest native `thread/tokenUsage/updated` totals; last-turn total tokens and model-window capacity have separate fields. No dollar estimate is fabricated. | Current native history projection does not establish request usage, cost or context occupancy. |
| Claude usage | Prefer cumulative `modelUsage`/cost from SDK results. Count each model once, preserve separate uncached/cache-read/cache-created counters; fall back to result UUID or response-ID deduplication. | Reuse 059's response-ID ledger. Missing cost/context remains missing. |
| Completion/error | Preserve Codex phase when explicit. Claude stop reason is not Codex phase or whole-query completion. `is_error: true` remains failure even with result subtype `success`. | Preserve native phase/status and block error flags; a saved record never establishes present-day runtime state. |
| Unknown data | Unfamiliar messages/items remain inspectable. Known control/telemetry messages can be absent from the transcript while the full capture retains them. | Unknown blocks remain inspectable through the native adapter. |

When the Codex read contains only pages, the adapter creates a **reading input**
from the native turn/item pages. Its raw inspector distinguishes that input from
actual page-wrapper paths. It does not reconstruct or restore a running agent.

Claude model-window capacity is displayed only when one reported model supplies
it; response input or cumulative tokens are never relabelled as context occupancy.
The history view does not borrow live usage to make missing native fields appear
present. Joining sources later should keep the provenance of any enrichment.

## Measured live/history comparison

The root experiment supplied real captures from the same newly launched sessions.
No additional provider calls were needed for this comparison:

| Capture | Live records → display | Saved display | What agrees / differs |
| --- | --- | --- | --- |
| Codex `735b1c89e0e548a3b867dc2034ee6c3d` | 40 wire records → 3 conversation/tool items + 7 protocol rows | 3 native items | The ordered ordinary `(role, kind, text)` triples match exactly. All three native item IDs overlap. Live usage is present; this saved projection has none. |
| Claude `d9bc87332b9b47a9963e0a72781576a8` | 44 SDK/local records → 4 conversation/tool blocks + 3 protocol rows | 4 native blocks | The ordered ordinary triples match exactly. Known token counters agree; live result cost and model-window capacity are absent from saved helper messages. |

Codex's seven protocol rows are remote-control status, three MCP startup statuses,
two moderation-metadata events and a read-state change. Claude's three extra rows
are `command_lifecycle` events. These remain inspectable in a collapsed protocol
section, separate from the conversation. They are not missing prose/tool content
in the historical view, nor unexpected fabricated messages.

The Claude run reports 4 uncached input, 32,469 cache-read, 7,510 cache-created and
120 output tokens in both projections. The live cumulative estimate is USD
0.00188709 and model-window capacity is 1,000,000 tokens; saved cost/window and
actual context occupancy remain unknown. Codex's final live snapshot reports
36,970 input, 29,824 cached and 47 output tokens; last context 18,536 and capacity
258,400. No Codex dollar cost is invented by these adapters.

Only one displayed native ID overlaps for Claude because the tool-use and result
share a tool-use ID, while the final assistant uses an SDK response ID live and a
helper wrapper UUID historically. The raw envelopes preserve both identifier
kinds. This is evidence to retain separate identity scopes in eventual SDK types,
not a reason to guess equality from a single generic ID field.

Raw `live.json` and `history.json` reside under the ignored 067 `runs/<capture>/`
directories. Exact body agreement here establishes this selected simple prompt
and real file-read journey, not universal provider/history parity.

## Validation and limits

Six focused synthetic regression cases passed: Codex prompt/delta/completion
reconciliation, repeated prompt handling and snapshot usage, Claude stream/final
and cumulative-usage deduplication, explicit failures/unknown records, historical
response-ID accounting, and read-only native page rendering. They protect
interpretation, not upstream compatibility. The parent experiment's real provider
captures are the compatibility evidence and should be compared with these adapters.

No model calls were made by the projection work. Raw captures stay ignored; test
records are deliberately small authored cases rather than private session copies.

Remaining limits are deliberate: this is not a general incremental indexing
engine; it recomputes a compact view from the current capture. Codex user-echo
matching without a native receipt association is provisional. Claude child stream
blocks are separated by parent-tool identity, but actor/family UI and cross-actor
usage attribution are not established. Image bytes/references remain inspectable;
the new display does not claim complete image retrieval. Clock reconstruction,
health thresholds, external-session joining and universal lifecycle semantics are
outside this adapter.
