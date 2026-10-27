# 059 — Native history availability ledger

**Working ledger, 24 October 2026.** Keep this beside the disposable viewer and
carry its evidence into production type/schema design. Provider history is an
interpretation of stored records, not a stable, complete event log. This document
is meant to change as APIs, SDKs, captures and our understanding change.

The [behavior inventory](059-evidence-inventory.md) tracks questions; the
[family collection](059-agent-family-evidence.md) records measured examples;
[runtime contracts](../../../docs/runtime-contracts.md) retain consequential
integration rules. This ledger connects those findings to the data a renderer
can responsibly use. It is not a new persisted schema or a universal provider API.

## Preserve these distinctions in future types

- **Original data and interpretation:** retain native payloads, unknown fields,
  source method/version and capture identity. A view projection can evolve
  without silently rewriting the source.
- **Availability:** a value may be reported, derived, absent from this API,
  not collected, unsupported by our renderer, or contradicted by evidence.
  A nullable number alone cannot explain all of those conditions. Count coverage
  at the item/lane level; a provider-wide capability flag is often too coarse.
- **Identity and ownership:** Codex child threads have thread identities; Claude
  children use a root session plus agent ID. Display/export keys are not native
  IDs. A missing parent link is different from an explicit root relationship.
  The current static mock's projected IDs include capture positions; incremental
  production views should anchor by scoped native identity and keep position
  separate. The mock preserves the original native IDs for that transition.
- **Clocks and duration:** preserve units and measurement scope. Producer item
  clocks, turn clocks, client receipt clocks, reported elapsed and derived
  intervals are separate. A point event need not have a meaningful duration.
- **Activity and lifetime:** a child completing a turn can work again. A tool
  returning can leave a background process alive. Captured history cannot by
  itself establish current process liveness.
- **Usage and attribution:** counters can repeat across messages and copied
  histories. Native response identity helps deduplication; it does not always
  establish which viewed agent originally incurred the usage.
- **Recognized text and native structure:** a recorded slash-command wrapper can
  receive a specialized presentation, with the recognition basis retained. Text
  mentioning an operation is not equivalent to a typed operation or an accepted
  control request. Nothing in recorded content executes on inspection.

A future typed measurement should be able to carry its value, basis, source,
actor, time scope and qualification. These are design requirements, not a settled
interface or a mandate to wrap every scalar in a heavyweight object.

## Current field/behavior availability

| Surface | Observed availability | Consequence / remaining qualification |
| --- | --- | --- |
| Version provenance | Export `source.version` identifies the reader CLI/SDK; original producer versions may differ or be unavailable. Adapter interpretation also evolves. | Keep producer, reader and adapter versions distinct in future types; capture time is not event time or proof of producer capability. |
| Authorship and capture grouping | User-role records can contain tool output, teammate notices or summaries. The rich-message collection qualifies three human image prompts and three mathematical assistant messages. | Message role alone does not establish human authorship. Independent review examples are a collection, not evidence of a parent/child family. See [direct examples and gaps](059-rich-messages.md). |
| Codex agent message phase | `commentary` and `final_answer` observed; partial is source-supported; old records can omit it. | Update pills can use explicit phase. Do not infer finality from position. |
| Claude response stop reason | `tool_use` and `end_turn` observed in assistant messages. | Show “yielded to tools” / “response ended” separately from Codex phase. User-query completion is not established solely by this field. |
| Codex full-thread items | Native text/tools/activity, with reported durations for some kinds; item clocks are outside the item body. | Do not conclude that item time is unavailable merely because `thread/read` omitted the wrapper. |
| Codex item pages | Family collection returned all 5,785 entries with `startedAtMs`/`completedAtMs`, matching full-read identities. | Join by thread/turn/item identity and retain wrapper fields. This does not establish coverage for every older history. |
| Codex turn clocks | Unix seconds; item clocks and durations use milliseconds. One family turn lacks an end/duration. | Keep unit conversion explicit; unknown end remains unknown. |
| Claude public message clocks | `SessionMessage` omits original wrapper timestamps. Family helpers returned no structured execution-duration fields. | Sequence navigation is available. A calendar axis requires another qualified source; collector latency is not agent duration. |
| Tool elapsed | Native command/MCP durations; dynamic tools include awaiting an external response; sleeps are deliberate waits. | Label the basis. Don't treat every interval as CPU/execution time or every long wait as unhealthy. |
| Codex child activity | `subAgentActivity` identifies child and kind; repeated work completions observed. | Navigate to captured child history. Activity does not establish message body, acknowledgement or process termination. |
| Claude child identity | Official list/read helpers; six nested links in the selected family, many missing parent IDs/calls. | Preserve `main-or-unknown` where appropriate. A sidecar existing does not guarantee usable relationship fields. |
| Parent↔child message bodies | Typed Codex activity lacks bodies; Claude parent call/result links are incomplete. | Show available child conversation separately; don't invent a full mailbox transcript from activity arrows. |
| Root lineage | All 104 Codex family `rootTurnId` fields absent despite known parent links. | Use each relationship's own evidence; one missing lineage field must not erase the rest. |
| Model/effort/tier | Claude response model present; some Codex child-creation activity in the broader corpus has model/effort. Parent historical settings are not in those records. | Never paint a parent's history using a child's creation settings or the session's latest model. Tier/effort tracks need qualified sources. |
| Usage/cache | Claude response counters and IDs; repeats occur within and across family documents. | Count response IDs once for known totals, expose incomplete coverage and avoid unsupported per-agent attribution. Tools have no separate inferred model bill. |
| Cost/context | Not established by the current native history projections. Additional sources exist in earlier probes/ingestion. | Keep missing cost/context explicit. Context occupancy is not cumulative token use. Pricing and enrichment remain separate work. |
| Compaction and slash commands | Native Codex compaction; Claude command/command-output wrappers and summaries. | Specialized view with source basis; don't imply a complete pre-compaction transcript or automatic/manual trigger unless supplied. |
| Background jobs | Explicit launch/stop requests and results, plus some notifications. Live SDK task updates can finish without a terminal notification. | Launching call duration and job lifetime differ. Missing completion is not success or proof of still-running work. |
| Images | Prompt and tool images observed; copied files qualified as export-time copies; update/final generated-image examples still missing. | Preserve origin, reference and retrieval evidence. Thumbnail sizing doesn't reduce byte transfer. S3 resolution is not implemented. |
| Unknown native items | Preserved in raw exports; adapters initially missed modern child activity. | Keep an inspectable fallback and a visible count. Add a versioned example before broadening semantic interpretation. |
| Loading | Current mock loads complete captured documents/families; transcript mounting is windowed. | Rendering density does not establish cheap transfer, parsing or native pagination. Measure them separately. |

## How to update this ledger

For a new field or behavior, record the provider/SDK/binary versions, source
method, actual native example, coverage counts and a private pointer/hash. State
whether it was observed, source-inspected, derived, or merely proposed. Record
negative and incomplete cases alongside the successful one. Add a meaningful
regression when interpretation could lose identity, miscount usage, invent time
or imply the wrong lifecycle action.

When a new version changes an assumption, preserve the earlier qualification and
mark the new boundary. Avoid an expanding collection of speculative compatibility
branches: our broader six-month history policy still counts unsupported formats
and makes failures planning items. Ask product questions when a real dependent
behavior needs an answer, not merely because a new field appears.

The mock remains disposable. Production extraction should begin from these
availability distinctions and reviewed interactions, rather than freezing its
current temporary transport envelopes or UI-shaped TypeScript interfaces.
