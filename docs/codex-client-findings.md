# Codex client feasibility: findings from spikes 025–034

**Completed 14 October 2026.** Codex exposes enough native functionality for a
useful browser/Node client covering conversations, session administration, files
and terminals. The main architectural requirement is to keep three activities
distinct: browsing saved history, joining live work, and recording what actually
happened. They overlap, but none substitutes fully for the others.

The follow-on [API design](specs/codex-client.md) and
[implementation plan](plans/codex-client.md) are now drafted for review.
Their proposed interfaces are separate from the observed results below.

I recommend a thin native-protocol client with shared analysis functions, using
the existing launcher for profiles, processes, relaying and observation. Use
native session organization where it works. Add a recording capability for
historical diagnostics, and native telemetry for activity that client messages
miss. Multiple clients can participate; the evidence does not justify imposing
a single controller. These are recommendations for the next design discussion,
not newly implemented libraries or a replacement for the existing launcher spec.

## Results at a glance

The linked reports contain exact messages, source references, reproduction
commands, evidence paths and limits. They live locally under
`experiments/docs/spikes/`; repository links become available after publication.

| Investigation | What we learned | Detail |
| --- | --- | --- |
| **025 — Version and source** | Restored and built the pinned source. The installed release exposes 266 named messages; the clean build exposes 269. Useful features differ even between these nearby versions. | [Baseline](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/025-codex-baseline.md) |
| **026 — Session administration** | Projects, sections, names, archives and arbitrary attachments work. Attachments can hold tags and notes. The clean build adds persistent read/unread marks. Lists and search have omissions and need reconciliation. | [Administration](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/026-codex-session-admin.md) |
| **027 — History and replay** | Saved history can be read without credentials, loading an agent or starting work. Paginated history is richer than legacy history, but neither is a complete recording. Command output can be truncated in native storage. | [History](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/027-codex-history-replay.md) |
| **028 — Joining and multiple clients** | Resume subscribes to a live thread and replays pending questions. Either client can answer; the first answer wins. A join can miss an unfinished text prefix until the complete item arrives. Duplicate turn submissions can duplicate input. | [Joining](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/028-codex-joins.md) |
| **029 — Forks and continuation** | Forks copy conversation history, not the filesystem. Revert does not undo a tool's side effects. Queue insertion and resuming an active goal can start work immediately. | [Branching](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/029-codex-forks.md) |
| **030 — Remote files and terminals** | File reads/writes/watches and streaming terminals work independently of a conversation. Browser terminal input and resizing worked. Standalone process handles belong to their connection and die when it disconnects. | [Files and processes](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/030-codex-remote-operations.md) |
| **031 — Images** | A real browser submitted an inline PNG and received the correct answer. Server-local images also work, but stored UI history may retain only a path. HTTP image URLs were rejected. | [Rich input](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/031-codex-rich-inputs.md) |
| **032 — Health and swarms** | We can identify waiting, failures, repetition, children and context changes. These are evidence for advisory health, not a reliable automatic “stuck” verdict. An idle turn can still have a background command. | [Health](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/032-codex-health.md) |
| **033 — Cost** | The same calculation can run live and offline. Repeated counters and inherited fork history must not be charged twice. Client counters omit some warmup and compaction usage. | [Accounting](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/033-codex-accounting.md) |
| **034 — Observation and telemetry** | Client, launcher processor and offline replay produced identical analysis on one real capture. Native telemetry supplied missing sandbox and usage evidence. Slow/failing exporters did not stop the tested client operations. Hosted Logfire remains untested. | [Observation](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/034-codex-observation.md) |

## What this means for the user experience

A session browser can list and organize conversations, open their saved
transcripts, and search within a selected conversation without waking an agent.
This is a real native capability. We should make **Open history** and **Join or
continue** separate actions: resuming a conversation with an active goal started
an automatic turn in the experiment. Adding input to an idle thread's queue also
started work immediately.

The catalogue is useful but imperfect. Default filters hid a session created by
`codex exec`; an explicit source filter found it. Empty threads could be absent,
and one reverted thread appeared twice with different storage paths. Global
search missed text that per-thread search found. An application can reconcile
by profile/thread identity and refresh selected detail. It should not present
the first list response as an exhaustive inventory. Tags and notes can use native
attachments; changing an existing attachment's payload needs deliberate replace
semantics because adding the same identity preserves the original payload.

Opening history can show prompts, answers, file changes and, in paginated mode,
command results. It cannot recreate the whole original experience. Legacy
history dropped a command item from our real corpus. A separate command streamed
**70,000 bytes**, but its saved result contained **65,536 bytes**, including a
truncation marker. Usage notifications, original streaming timing and some
request/diagnostic information were absent from returned history. A detailed
historical inspector therefore needs a recording made while the work happens;
it must show which information is unavailable for older unrecorded sessions.

Joining live work is practical. Other clients can see pending questions and
answer them, and native handling chose one winner when two answered. The UI
needs to retire answered questions across clients, using both resolution events
and completed items because different callback types behaved differently.
During a text stream, a late join missed the first 80 characters until the final
item supplied the complete text. We should reconcile snapshots and events by
identity, replace completed items, and show incomplete live content honestly.
Blindly retrying `turn/start` is unsafe: the same user-message ID did not make
submission idempotent.

The terminal and agent have different lifetimes. **Agent work continued after
every client disconnected. Standalone terminal processes were killed when their
own connection closed.** A reconnecting client must not infer one behavior from
the other. Files and terminals can be offered as independent workspace tools;
the tested APIs need neither a conversation nor model inference. These are host
operations with their own permission scope, not automatically operations inside
the selected thread's sandbox.

Inline images are straightforward for browser clients. Local-path images need
an asset access/preservation policy if a later remote viewer should display
them. Native model context retained prepared image bytes in our experiment,
while structured UI history kept the original path. Reading and forking that
history succeeded after deletion, but we did not run new visual inference after
deletion and cannot promise continued image understanding from that test.

## Health and cost need to say what they know

A useful first health view can show current native state, unresolved questions,
running tools, recent progress, visible tool failures, children, context estimates
and estimated cost. Repeated identical calls can flag a possible loop. Silence
can mean a healthy slow tool. A completed turn can leave a background terminal.
After connection loss, the dashboard's information is stale; that does not mean
the agent stopped.

The observation source matters. A real sandbox-denied command was absent from
structured command items but present in native records and telemetry. A passive
relay saw no messages while an unsubscribed agent continued working. Tool counts
and failure rates from that relay must therefore be labelled as observed counts.
For unattended agents, native telemetry and persisted records complement the
client stream. An always-on subscribing observer is worth a targeted follow-up:
we should understand its lifecycle before using `resume`, which can start goals.

Cost has similar gaps. Cumulative usage may be replayed to several clients and
copied into a fork. Count new increments once and keep inherited history separate.
Context size is not cumulative usage. In the telemetry test, native/upstream
records exposed two warmups and an explicit compaction missing from ordinary
client accounting. Provider response IDs help reconcile captures; the native
log records did not contain equivalent IDs in this run. A single universal,
exact billing total is not established.

The encouraging result is that shared computation works: the real client, a
launcher processor and an offline JSONL reader produced **identical results for
82 messages**. That supports small pure analysis functions with explicit
provenance, missing-data and stale-state fields. Native-history inputs need their
own adapter with reduced coverage; equality with a complete recording should
never be assumed.

## Recommended architecture and order of work

1. **Native client operations.** Use versioned generated types and a small
   connection layer for RPCs, notifications and server questions. Expose native
   administrative, history, file and process operations. Detect experimental
   capabilities and surface returned effective settings.
2. **Conversation state and reconciliation.** Build history browsing and live
   joining on explicit snapshots/items/events. Support multiple listeners and
   responders. Handle uncertain submissions without automatic duplicate turns.
   Keep process connections distinct from agent-thread lifetime.
3. **Shared analysis.** Feed observations into reusable transcript, usage and
   health computations in a browser, Node tool, launcher processor or offline
   reader. Retain original messages, source/version identity and known gaps.
4. **Recording and operations.** Use the existing launcher hooks for asynchronous
   capture, backlog and loss reporting. Add native telemetry for unattended
   activity. Keep optional upstream capture for investigations and accounting
   verification. Configure Logfire only after selecting a destination.

I would design the first two together with a minimal recording format, then
prove the same analysis on both live and saved inputs before expanding health
features. We do not need another conversation manager, a replacement tag store,
or a single-controller rule to begin. Environment cloning remains a separate
Hostfork concern: conversation fork/revert cannot restore files or processes.

## Evidence, spend and remaining limits

Three parallel tracks used disposable state, real local subprocesses and small
**gpt-6-luna** calls. We restored clean source commit
`6c372fbef45f730b6d8aa727b0ec8332365588db`, built it, exported normal/experimental
schemas, inspected relevant source and compared selected behavior with installed
**Codex 0.162.1** (release source `092d3acd…`). The build used local Rust 1.98.1
instead of the source's 1.95.0 pin; it passed compilation, not the entire upstream
test suite. The browser checks used Chrome 155 through our existing relay.

Remote-file/process checks passed 13 cases on both binaries. History/replay,
multi-client and accounting verifiers passed against their private captures.
We tested real sandbox denial, actual Luna parent/child work, and an explicitly
injected local HTTP 503. The latter establishes failure handling, not real
provider retry behavior. A credentials-free telemetry probe also tested delayed
and unavailable collectors. Metrics configuration changed between versions:
0.162.1 suppressed custom metrics when analytics was disabled; the clean build
exported them under that setting.

Measured, deduplicated **API-equivalent usage** at 14 October 2026 Luna Standard
rates was:

| Experiment | USD estimate from observed usage |
| --- | ---: |
| 026 — Vanilla CLI catalogue fixture | 0.00021540 |
| 027 — Shared history corpus | 0.00163042 |
| 028 — Join/control probes | 0.00664424 |
| 029 — New branch/queue replies | 0.00063094 |
| 031 — Three CLI image cases and one browser turn | 0.00092768 |
| 032 — Health/child probes | 0.00763714 |
| 034 — Five generating completions, including compaction | 0.00099338 |
| 034 — Two warmups, priced nominally; billability unknown | 0.00182980 |
| **All measured usage** | **0.02050900** |

025/030 and offline analysis made no additional model calls. Shared corpus
replays, inherited fork counters and repeated browser snapshots are counted
once. Most runs lacked upstream capture, so other warmups, 029 compaction and
unreported interrupted work remain unknown. This is **about two cents measured,
not an exact spend ceiling or subscription invoice**. Orchestration-agent billing
is not exposed here and is not included. No budget pressure required shortening
the experiments; the authorized provider budget was $5.

The remaining useful checks are bounded: Linux/remote-host behavior; pending
question inheritance and queued work across crashes; paginated late joins;
continuous observation with no controlling client; long exporter outages;
additional rich-media forms; and a real Logfire destination. Browser file-picker
automation was blocked by its allowed filesystem roots, so the actual submitted
image came from a browser canvas fixture. No hosted Logfire project/login was
configured; local OTLP delivery is qualified, hosted ingestion is not. This round
does not claim every one of the 269 protocol messages or large-swarm scale tested.

The [original plan](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/proposals/codex-client-feasibility-spikes.md)
and [research index](research.md) connect the remaining detail. Raw evidence stays
in ignored `experiments/artifacts/`; public reports contain no credentials.

## Analysis paths for history and live sessions (spike 035, 2026-10-16)

Spike [035](https://github.com/habemus-papadum/pdum_agent_tools/tree/main/experiments/spikes/035-codex-analysis)
asked what the raw files and the read RPCs each let a backend analysis see.
One DuckDB schema with provenance columns received a read-only filesystem ingester
and an app-server ingester; 22 analysis questions ran as timed SQL over both.
The filesystem path ingested a real home (221 rollouts, three databases) in 7.6 s
and answered every question in milliseconds, with full-text search at about 200 ms.
The API path returned identical items for 35,876 shared rows but no per-response
usage, rate limits, per-turn model and effort, or fork lineage, listed 157 of 213
catalogue threads, and needed the SQLite history projection copied or each thread
resumed before a snapshot server returned any history. A one-turn live subscription
matched the persisted usage records exactly but never saw response ids or the model.
The client SDK should therefore share the schema and extraction and provide both
ingesters, treating usage and turn settings as filesystem or live-subscription facts.
The [report](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/035-codex-analysis.md) records the evidence.
