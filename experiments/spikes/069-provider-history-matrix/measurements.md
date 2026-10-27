# Content, measurements and observation coverage

The live stream, native transcript, process journal and ingested tables overlap.
They are not interchangeable. The [status/version register](README.md) applies;
these are measured source differences, not a proposal for a new universal schema.

**070 update:** [actual HP Node/browser archives](../../docs/spikes/070-hp-backend-parity.md)
now qualify usage/cost round-trip through the existing schema-v5 writer and
production TypeScript/SQL calculations, including compact responses and fork
deduplication. Schema v5 remains current. Production integration needs HP source
registration, a corrected out-of-turn response invariant and separation of pure
pricing from its Node refresh import; no schema-version migration was required.

## What can be rendered or inspected?

| Evidence | Codex live / native history | Claude live / native helper history | HP Node/browser research core |
| --- | --- | --- | --- |
| Text and tool conversation | **Observed:** selected 067 live and saved items match, including native item IDs. Legacy history can omit a command. [027][history], [067][compare] | **Observed:** selected 067 blocks match, but saved wrapper UUIDs differ from response IDs. Tool use/result are separate blocks. [067][compare] | **Observed:** conversation snapshots and model context retained separately; host tool results and children exported. [039][hp], [045][behavior] |
| Unfinished streamed text | **Observed:** live deltas; late join can miss prefix until final item replaces it. History is not a delta recording. [028][joins] | **Observed:** live streaming through prior SDK. **Observed 068:** recorded native stdout is replayed byte-for-byte; native history omits its original streaming envelope/timing. [014][claude], [068][raw] | **Source/local-tested:** emitted notifications retained in journal; snapshots reconstruct final saved state. No general late-join atomicity claim. [runtime][hp-source] |
| Tool output completeness | **Observed:** 70,000 live bytes became 65,536 persisted bytes including native truncation marker. [027][history] | **Unqualified:** observed results are useful but no general no-truncation guarantee. Selected-chain omissions can hide prior calls/results. [058][native] | **Source/observed selected tools:** complete output in experimental adapters; `max_output_tokens` advisory. No large-history/storage-performance qualification. [042][tools] |
| Images | **Observed:** live inline PNG and host-local image; stored inline data survives, local path alone cannot supply remote viewer bytes. [031][images] | **Observed historical:** human uploads/tool images in helper exports. No new raw-feed multimodal live qualification implied. [059 rich][rich] | **Gap:** current RPC input adapter accepts text only. Retained MCP image JSON in string tool output is not model-image delivery. [protocol][hp-protocol], [042][tools] |
| Markdown/math/Mermaid | **Observed viewer:** real native prose examples rendered; the mixed rich fixture tests missing forms. These are presentation capabilities, not new provider protocol features. [059][viewer], [059 rich][rich] | Same renderer distinction; per-source content remains intact. | Shared rendering is possible; no inference that HP already supports every rich input/output form. |
| Parent/child relationships | **Observed:** child IDs/activity and selected complete family; activity bodies do not contain a complete mailbox transcript. [059 family][family] | **Observed:** children listed/read by root session + agent ID; many parent IDs/calls missing, including compaction omissions. [059 family][family] | **Observed/Source:** parent and fork edges, child histories and attributed mailbox records. Preserve fork versus spawn. [045][behavior], [047][control], [export][hp-export] |
| Errors and unknown messages | **Observed:** sandbox denial can be absent from structured command items but present in native telemetry. [034][telemetry] | **Observed:** `is_error:true` can coexist with `subtype:success`; cancellation needs intent/UUID correlation. 068 malformed JSON terminates native process with stderr; unsupported control subtype instead has correlated stdout error. [066][auth], [065][lifecycle], [068][raw] | **Local-tested:** failures, rejected inputs, unknown outcomes and late host results are distinct records. Not every diagnostic is exposed by one common item type. [047][control], [048][steer] |

## Tokens, cost, context and time

| Measurement | Codex | Claude | HP Node/browser |
| --- | --- | --- | --- |
| Per-response usage | **Observed live:** cumulative/last counters. **Gap in history RPC projection:** usage series absent. **Observed ingestion:** native files can retain per-response records and older counter deltas. [033][accounting], [035][analysis] | **Observed:** assistant response counters in live and helper history. Repeated response IDs across blocks/families require deduplication. [059 ledger][availability], [067][compare] | **Observed:** response ID/model/usage records retained and exported during real Node/browser runs. [040][hp-live], [052][jobs] |
| Cache arithmetic | **Observed:** input includes cached input; avoid adding it twice. Cache write and reasoning fields need their own basis. [033][accounting], [067][compare] | **Observed:** input is uncached; cache read/create separate. Creation TTL can affect pricing. [016][claude-session], [067][compare] | **Observed/Source:** preserves connector's inclusive input/cached/output counters and response IDs. Pricing is a separate computation. [export][hp-export] |
| Cost | **Derived:** dated prices applied to deduplicated observed usage. Client-only coverage missed warmups and compaction in 034. No exact subscription invoice. [033][accounting] | **Observed live result estimate:** can be cumulative across resume; subtract prior baseline. **Gap in helper history:** that result-cost envelope absent. Historical cost can be derived from available counters/prices. [064 ledger][continuation-cost], [067][compare] | **Derived:** per-response usage priced by dated test ledger. Prototype export accepted by old history schema; production pricing/schema migration still needed. [040][hp-live] |
| Context occupancy | **Observed live/native files:** context estimates and compaction changes. Not equal to cumulative billed tokens; absent from ordinary native history projection. [033][accounting], [035][analysis] | **Gap:** current history projection and ingestor do not establish actual occupancy. Synthesized `last_total_tokens` is not a measurement of context size. Live model capacity is not occupied context. [061][ingestion], [067][compare] | **Observed Node:** count endpoint with complete request shape matched selected requests; explicit compaction reduced one context 344→205 tokens. **Unqualified browser live:** same adapter only built there. [043][compaction] |
| Model, effort, tier attribution | **Observed:** returned effective settings may differ from requested settings. Historical per-turn model/effort can come from native rollout context; a child's creation settings do not describe its parent. [029][fork], [035][analysis], [059 ledger][availability] | **Observed:** response model retained. Current history helpers do not establish all effort/tier configuration or parent/child attribution. [059 ledger][availability] | **Source:** requested thread model plus actual usage response model available. Full native per-turn effort/service-tier administration is not implemented by current RPC subset. [protocol][hp-protocol], [export][hp-export] |
| Event time | **Observed:** turn clocks seconds; paginated item clocks milliseconds. Receipt time is different. [059 family][family] | **Gap in helper:** original wrapper timestamps and structured durations omitted in selected exports. Sequence still useful. [059 ledger][availability] | **Source:** runtime journal timestamps/sequence and turn/item clocks; provider usage receipt timestamps. These are the runtime's clocks, not native provider execution clocks. [runtime][hp-source] |
| Tool/task duration | **Observed:** reported duration, item endpoint interval, wait and background lifetime differ. Missing ends stay unknown. [059 family][family] | **Gap in selected helper:** no structured execution durations. Collection latency is not duration. | **Local-tested:** job admission, start, output, cancellation and terminal events. A finished tool call can leave a separately owned job running. [051][background] |

## Shared computation rules

1. Keep the original observation plus source, provider/reader/adapter version and
   native identity. A later interpretation can improve without rewriting evidence.
2. Carry the measurement's basis and coverage. “Unavailable in native history,”
   “not collected,” “not priced” and “zero” have different meanings.
3. Deduplicate repeated counters and responses, exclude inherited fork baselines,
   and preserve source/actor scope. Do not add estimates from live, journal and
   ingestion as if they were independent provider work.
4. Reconcile started/completed item snapshots and tool-use/result pairs by native
   identity. Equal text alone does not establish duplication across sources.
5. Do not infer current liveness from an old incomplete task, cost from tool
   duration, or agent health from silence alone.

These apply RC-07/09/10/11/12/13. The 034 client/processor/offline analysis produced
identical results for all 82 observed records; that is evidence for a reusable
computation boundary. It is not evidence that native-history input has the same
coverage. Browser, Node and optional host processors can share TypeScript
computations without requiring every source to supply identical data.

The user does not require all live-only measurements to become ordinary history.
The 068 Claude running-process journal serves current-session attachment;
optional debug captures serve development; native saved history serves later
conversation browsing; the existing ingestor serves statistical queries.

[history]: ../../docs/spikes/027-codex-history-replay.md
[joins]: ../../docs/spikes/028-codex-joins.md
[fork]: ../../docs/spikes/029-codex-forks.md
[images]: ../../docs/spikes/031-codex-rich-inputs.md
[accounting]: ../../docs/spikes/033-codex-accounting.md
[telemetry]: ../../docs/spikes/034-codex-observation.md
[analysis]: ../../docs/spikes/035-codex-analysis.md
[claude]: ../../docs/spikes/014-claude-app-server.md
[claude-session]: ../../docs/spikes/016-claude-client-sessions.md
[hp]: ../../docs/spikes/039-hp-agent-runtime.md
[hp-live]: ../../docs/spikes/040-hp-integration.md
[tools]: ../../docs/spikes/042-hp-tools-skills.md
[compaction]: ../../docs/spikes/043-hp-context-compaction.md
[behavior]: ../../docs/spikes/045-hp-behavior.md
[control]: ../../docs/spikes/047-hp-dynamic-control.md
[steer]: ../../docs/spikes/048-hp-steering-edges.md
[background]: ../../docs/spikes/051-hp-background-jobs.md
[jobs]: ../../docs/spikes/052-hp-work-integration.md
[native]: ../../docs/spikes/058-native-history-access.md
[viewer]: ../../docs/spikes/059-historical-viewer.md
[availability]: ../../docs/spikes/059-data-availability.md
[family]: ../../docs/spikes/059-agent-family-evidence.md
[rich]: ../../docs/spikes/059-rich-messages.md
[ingestion]: ../../docs/spikes/061-ingestion-statistics.md
[lifecycle]: ../../docs/spikes/065-session-lifecycle.md
[auth]: ../../docs/spikes/066-claude-setup-token.md
[compare]: ../../docs/spikes/067-live-session-workspace.md
[raw]: ../../docs/spikes/068-claude-feed-replay.md
[continuation-cost]: ../064-history-continuation/usage-ledger.md
[hp-source]: ../039-hp-agent-runtime/src/runtime.ts
[hp-protocol]: ../039-hp-agent-runtime/src/protocol.ts
[hp-export]: ../039-hp-agent-runtime/src/history.ts
