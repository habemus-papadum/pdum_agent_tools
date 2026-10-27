# 059 — Agent behavior evidence inventory

**24 October 2026 · first audit, before the next UI iteration.** This inventory
records what we want to see, which evidence exists, and what to collect next.
It is deliberately extensible. A renderer should preserve unfamiliar native
records while we qualify their meaning; this is not a frozen event taxonomy.

## High-level findings

**Follow-up collected:** [agent families and meaningful duration](059-agent-family-evidence.md)
qualifies a complete selected Codex family, two Claude family listings with
explicit relationship gaps, paginated item clocks and operation-specific timing.
The findings below describe the original 23-document audit; the family exports
are separate and have not replaced the viewer catalogue.

The current 23 exported histories contain **8,474 records**. They already support
more useful presentation than the viewer exposes: Claude compact-command/output
pairs and background work, plus Codex's structured child-agent activity. Some
other tracks require different native history methods or a separately attributed
capture source.

| Finding | Consequence |
| --- | --- |
| Codex has 363 `subAgentActivity` records: 26 started, 246 interacted and 91 completed, referencing 26 distinct children. None of those child transcripts is in this catalogue. | Interpret these records and collect one whole family. Repeated completion is activity evidence, not 91 distinct children or proof of final lifetime termination. |
| Codex has 138 turn starts and 137 ends, but its bare transcript items have durations rather than wall-clock anchors. Older paginated captures contain 38 item entries with start/end timestamps. | A turn-level time view is feasible; qualify item-level pagination on long traces before claiming message-level timing. |
| There are 24 gaps exceeding 30 minutes between consecutive recorded Codex turns; the largest is 61,804 seconds. | There is real material for gap-compression experiments. These are gaps in parent-turn activity, not proof that children/jobs were inactive. |
| Claude contains two `/compact` command/output pairs, six background-launch requests, five matching launch results, four stop results and one completion notification. | Build a focused operation/job interpretation from actual examples; retain the unmatched launch and missing lifecycle information. |
| Native images include three user inputs and 70 tool outputs. No embedded images or Markdown image references were found in phase-labelled assistant updates/finals. | Prompt/tool-image coverage is real; update/final image placement and image-generation output remain collection gaps. |
| Claude exposes response stop reasons and model identifiers; its helper omits per-message timestamps. Codex parent model/effort/tier history is absent from these transcript records. | Keep model-response termination distinct from user-turn completion, and source model/timing tracks explicitly. |

Counts above are occurrences in the exported documents, which may share history;
they are not deduplicated fleet totals or billing units. The real-data inventory
is separate from the synthetic rendering bench.

## Evidence levels and process

Use four labels per behavior: **observed** in the current native exports;
**prior probe** demonstrated by an earlier bounded experiment; **source-only**
supported by inspected APIs/code but not yet captured here; **missing** from the
selected examples. Text matches are **candidates** until their enclosing record,
role and relationships have been checked. Searching for `/compact`, `steer` or
math alone is not proof of an operation.

For each selected example retain provider/version, source method, native session/
turn/item identity, exact fields, missing pieces and a local raw-record pointer.
Separate source assertions from derived presentation and policy. Record positive,
negative, cancelled and incomplete cases where relevant. Each later iteration
can add rows or split a row when the provider's behavior warrants it.

Raw pointers and hashes are in ignored
`experiments/artifacts/059-evidence-inventory/audit.json`. The reproducible
[auditor](../../spikes/059-historical-viewer/audit-evidence.mjs) reads already-exported
JSON only. It does not parse private recovery formats, contact providers or
change the captures. Its text-marker results remain candidates rather than a
production semantic parser.

## Working behavior inventory

| ID | What we want to understand | Evidence now and next qualification |
| --- | --- | --- |
| E01 | Human input, assistant update, partial answer and final answer | **Observed:** Codex has 446 `commentary` and 120 `final_answer` records. The user clarified that Claude's distinction was the unclear one. Preserve unknown phases. |
| E02 | Claude messages that yield to tools versus end a model response | **Observed:** 651 assistant records with `stop_reason=tool_use`, 42 with `end_turn`; repeated native response IDs occur. **Missing:** a qualified mapping from those records to completion of an SDK query/user turn. An end reason alone must not become a lifecycle guarantee. |
| E03 | Slash commands and their local output | **Observed/manual inspection:** two Claude `command-name=/compact` records followed by `local-command-stdout` reporting compaction. Both are carried in user-role messages. More commands—model selection, clear, resume, rewind and others—need examples. Do not render every user-role record as human prose. |
| E04 | Manual/automatic compaction, summaries and changed context | **Observed:** 39 Codex compaction items; Claude summary/compact text. **Prior probe:** 029/033 show context changes and separately billed compaction. **Missing:** reliable trigger/summary association for every variant; distinguish transcript from model context. |
| E05 | Model, reasoning effort and service tier at a point in time | **Observed:** Claude assistant model identifiers; 21 Codex child-creation activity records carry model/effort. Those fields describe children, not their parent. **Source-only:** existing ingestion reads native turn context/settings-applied events. Need a mixed-settings example with requested, effective and provider-reported values distinguished. |
| E06 | Steering during an active turn | **Prior probe:** 028 qualifies `turn/steer` and stale-turn rejection. **Missing in this corpus:** explicit request/acceptance/application linkage. A later user message inside one turn or a prose mention of steering is insufficient. Preserve client input identity and active-turn target. |
| E07 | Queued input, next-turn delivery and automatic continuation | **Prior probe:** 029 has queue-triggered turns and resumed goals. Collect one sequence containing enqueue, disposition and resulting turn; keep explicit delivery intent separate from inferred intent. |
| E08 | Interrupt, cancel, stop and incomplete output | **Observed:** task stop calls/results; source enums describe interrupted turns/tools. Need linked examples distinguishing cancelled observation, interrupted model work, terminated tool and stopped child. Unknown delivery remains unknown. |
| E09 | Tool request, result, error, retries and truncation | **Observed:** native tools, results, nonzero exits and Claude `is_error`. Classify failures per operation: an unsuccessful search exit is evidence of that exit, not automatically a sick session. Collect retry and explicitly truncated/missing-output cases. |
| E10 | Parallel tools and overlapping work | **Missing:** a qualified overlap example with start/end anchors. Adjacent calls or multiple pills do not prove parallel execution. Preserve separate call/result identities. |
| E11 | Background job launch and continued output | **Observed/manual inspection:** six Claude `Bash` calls request background execution; five results carry a background ID. Find the missing pair and preserve uncertainty. **Prior probe:** 032/057 cover Codex managed terminals and teardown. |
| E12 | Background completion, failure and cancellation | **Observed:** four Claude stop results and a completed-task notification. **Source-only:** SDK `task_updated` can carry terminal state without a separate notification. Capture both live forms; don't leave a stopped task alive because the notification is absent. |
| E13 | Task planning/checklists versus running jobs | **Observed:** Claude `TaskCreate`/`TaskUpdate` alongside `Bash`/`TaskStop`. These are different concepts; sharing the word “task” is not a lifecycle relationship. |
| E14 | Child creation, activity, interruption and completion | **Observed:** 363 Codex `subAgentActivity` records and 32 older collaboration `wait` records. The viewer currently preserves the activity records as unknown. **Missing:** interrupted-child example and complete child histories. |
| E15 | Parent→child messages, child→parent reports and nested children | **Observed:** activity kinds and two Claude `SendMessage` calls. “Interacted” does not supply message body/direction. **Source-only:** Claude `list_subagents`/`get_subagent_messages` expose child history and parent tool/agent metadata. Qualify one complete family and its mail. |
| E16 | Fork, resume, copied context and rollback | **Prior probes:** 026/029/035; native ancestry exists in the small corpus. Keep fork lineage, child ownership and task dependence distinct. Avoid counting inherited usage again. |
| E17 | Approvals, user questions and waiting | **Prior probe:** 032 distinguishes pending permission/input from mere idle. Need real captured request/response/cancel examples and how they survive history reads. |
| E18 | Session load/unload, disconnect, reconnect and observation loss | **Prior probes:** RC-01–08, 056/057. A history view does not establish current runtime state. Record missing observation intervals separately from inactivity. |
| E19 | Calendar time, durations and event order | **Observed:** Codex turn clocks and command/tool durations; some paginated item clocks. Claude's SDK wrapper drops source timestamps. Qualify units, missing anchors, simultaneous events and clock ordering before aligning lanes. |
| E20 | Token usage and cache read/write | **Observed:** Claude native counters and response identities. **Prior probes:** Codex usage notifications, warmups/compaction and counter gaps. Dedupe snapshots/response IDs; keep cache semantics provider-specific. |
| E21 | API-equivalent cost, latency and cost rate | **Prior probes:** 033/034 show useful signals and missing costs. Still requires versioned pricing/model/tier and coverage. Parent/child totals must not count forwarded reports twice. No current cost estimator in 059. |
| E22 | Context occupancy, limits, compaction and exhaustion | **Prior probes:** 029/032/037. Context can shrink while cumulative usage rises. Need historical samples and model-specific limits; keep reported, estimated and unknown distinguishable. |
| E23 | Images in human prompts | **Observed:** two Codex image references and one Claude embedded upload. Existing copied files are qualified as export-time copies. Capture missing/unavailable and multiple-image cases too. |
| E24 | Images in assistant updates, final answers and tool output | **Observed:** 48 Codex and 22 Claude tool images; 24 Codex image-view operations. **Missing:** update/final embedded or linked-image examples and native image-generation results. Tool screenshots and agent-generated pictures are not interchangeable. |
| E25 | Markdown, math, diagrams, files, audio and other rich input | **Observed/rendered:** actual mathematical prose and Mermaid. More input/output forms and generated artifacts remain open. Preserve the source and unsupported blocks instead of flattening them into misleading prose. |
| E26 | Coverage, duplicates and changing schemas | **Observed:** Claude's selected-chain boundary after compaction; missing item/usage fields; new native activity types. Track API method/version, paging coverage, item count and unknown fields. Absence from one export is not proof that an event never happened. |
| E27 | Meaningful duration, waits and long-running work | **Follow-up observed:** native tool elapsed, producer endpoint intervals and client receipt spans are distinct. Background lifetime can exceed a launching turn; child work completion can recur. Show duration where meaningful, preserve missing endpoints, and avoid generic slow/stuck thresholds. See the family report and RC-10. |

## Timeline and minimap directions to explore

The user proposed two independent axes: **sequence order** and **calendar time**.
The current minimap bins records, so one visual line can represent several items;
it is not always one message per line. Preserve that overview while testing time.

A time view should position events by their actual available clock and keep
unknown-time records in an explicitly ordered area. Codex turn clocks are Unix
seconds; paginated item `startedAtMs`/`completedAtMs` are Unix milliseconds.
Do not spread untimed messages evenly across a turn and present those positions
as measured times. A duration without an absolute start is not a timestamp.

Gap compression is a display transformation, not deletion. A break should show
its true elapsed duration and allow expansion. **Thirty minutes is a candidate
control value, not a decided default.** A fixed threshold, automatic threshold
based on viewed extent, and manual expansion can be explored. If automatic,
show the selected rule/value and keep it overridable. Preserve native item/time
anchors when switching scale so the reader does not lose their place.

With multiple lanes, compress a shared time interval only under an explicit rule
that accounts for the selected parent, children and jobs. A parent gap may contain
active child work. A missing observation interval should have its own marker,
not a confident “inactive” label. Include timezone and clock/source information
where it affects alignment. Long waits, long running tools, overnight gaps,
interrupted coverage and simultaneous activity need separate examples.

Selectable tracks can include user/agent/tool activity, errors, model, reasoning
effort, service tier, input/output/cache counters, accumulated estimated cost and
context occupancy. Offer a compact family overview and deeper per-agent lanes;
width, density, lane selection and color mapping remain exploratory. Each metric
needs a denominator and coverage: tool error count/rate, known-cost sum, and
context occupancy are different quantities. Model color should describe the
actor/request for which the setting is known, not borrow a child's model for its
parent or apply the final setting retrospectively to the whole session.

SVG versus Canvas/WebGPU is an engineering choice after measuring a representative
family. The important boundary is a shared evidence/aggregation model independent
of renderer, so changing the drawing technology does not redefine the data.

## Next bounded collection and mock slices

1. **Complete family:** one existing Codex parent plus selected children, and one
   Claude family through official subagent helpers. Preserve message linkage and
   coverage; include background work that outlives a parent turn where available.
2. **Time and controls:** page item timestamps for a long Codex capture; qualify
   a source for Claude event time; find mixed model/settings, steering and queued
   delivery with actual request/result evidence. Reuse prior probe captures where
   suitable before considering a new paid experiment.
3. **Rich-content finder:** collect update/final image examples or explicitly keep
   those slots missing. Add an image/event locator to the mock so review does not
   require guessing which window contains an example.
4. **One family visualization:** render operation-aware pills and child activity,
   then compare sequence/time axes and gap rules using known time anchors. Try
   selectable metric tracks only where the evidence supports them. Review before
   choosing automatic collapsing or a production graphics backend.

No product answer is needed to assemble this inventory. Gap thresholds, initial
track choices and lane layout are mock experiments; authoritative timestamp and
cost sources need agreement before shipping claims based on them. The existing
native-history versus DuckDB/MotherDuck-statistics boundary remains in place.
Optional enrichment can cross-link those sources with attribution; it must not
silently relabel ingested data as a native history API response.

## Reproduction, sources and qualification

From `experiments/`:

```sh
node spikes/059-historical-viewer/audit-evidence.mjs
node --test spikes/059-historical-viewer/audit-evidence.test.mjs
```

The first command writes only ignored audit output. Four regression checks cover
image origin, timestamp units/containers, settings ownership, text-candidate
classification and modern subagent identity. Those fixture tests validate the
auditor, not provider compatibility. Counts above came from the real 23-document
corpus, with manual inspection of compact/background wrapper shapes. No provider
inference, login, profile mutation or new history export occurred in this audit.

- Native exports: Codex 0.163.0/0.164.0 and Claude SDK 0.2.165; see
  [058](058-native-history-access.md). Current UI and limitations: [059](059-historical-viewer.md).
- Codex inspected checkout: `6c372fbef45f730b6d8aa727b0ec8332365588db`.
  Source-only contracts: `app-server-protocol/src/protocol/v2/thread_data.rs`
  (`Turn`), `thread.rs` (`ThreadItemEntry`), `item.rs` (`SubAgentActivity`),
  `turn.rs` (settings/steer), and `thread_history.rs` (projection omissions).
  Paths are under `experiments/vendor/codex/codex-rs`; source checkout and binary
  versions are recorded separately rather than assumed identical.
- Installed Claude SDK `types.py` and `_internal/sessions.py`: `SessionMessage`,
  `TaskStarted/Progress/Updated/NotificationMessage`, visible-chain conversion,
  `list_subagents` and `get_subagent_messages`. These source-supported methods
  have not yet been qualified in this viewer. The current launcher
  [helper](../../../packages/claude-launcher/src/pdum/claude_launcher/_storage_helper.py)
  exposes main-session history, not those child methods.
- Existing optional enrichment owners:
  [Codex ingestion](../../../packages/agent-history/src/pdum/agent_history/codex.py),
  [Claude ingestion](../../../packages/agent-history/src/pdum/agent_history/claude.py).
  Their storage readers remain separate from the native viewer; this pass adds
  no private recovery parser or replacement config/schema.
- Prior qualified work: [028 joins/steering](028-codex-joins.md),
  [029 forks/queues/compaction](029-codex-forks.md),
  [032 health](032-codex-health.md), [033 accounting](033-codex-accounting.md),
  [034 observation](034-codex-observation.md), and
  [runtime contracts RC-01–08](../../../docs/runtime-contracts.md).

New experiment inference cost: **USD 0**. This excludes the original histories'
usage and the implementation/research assistant's own execution cost.
