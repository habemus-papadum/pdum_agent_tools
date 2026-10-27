# 069 — Provider, history and runtime compatibility

**25 October 2026 — evidence synthesis for the backend/client design.** This
investigation assembles the existing experiments; it makes no new provider calls.
It separates what we measured from what the next architecture proposes. The
[evidence register](../../spikes/069-provider-history-matrix/README.md) records
versions, source locations and the meaning of the status labels.

**Follow-up:** [070](070-hp-backend-parity.md) now qualifies HP persisted-history
reads, fresh-owner resume, historical checkpoint forks and real accounting through
filesystem and IndexedDB adapters. It fills several research gaps listed below;
production management/ingestor registration and broader recovery remain open.
The subsequent [071 check](071-claude-sdk-replay.md) also qualifies official Claude
SDK reuse with client-owned replay/reconnection logic against the persistent
process. SDK-free server ownership does not require SDK-free application clients.

The useful common interface is a set of explicit operations and shared view
computations, with native provider messages retained underneath. We have enough
evidence for that design. We do not have evidence that one universal conversation
protocol, replay mechanism or process lifetime already exists across the agents.

## The main findings

| Question | Architectural finding | Detail |
| --- | --- | --- |
| What does “history” mean? | Native transcript reads, a recorded live feed, model context and analytical ingestion are separate sources. A transcript can be useful while omitting live timing, usage or earlier compacted messages. | [History and continuation](../../spikes/069-provider-history-matrix/history.md) |
| Can several clients share work? | Codex already has measured multiple-listener/responder behavior. HP has measured multiple clients attached to one in-memory owner. Claude's SDK-free 068 process continues without clients and replays identical native output to new ones. Its earlier SDK/client-owned worker behavior is a different integration. | [Attachment and control](../../spikes/069-provider-history-matrix/live-control.md) |
| Can one renderer/analysis serve live and historical views? | Yes, with separate source adapters and explicit missing-data coverage. Selected Codex/Claude tool turns already share presentation. Calculations must preserve native identities, counter basis and actor/time scope. | [Content and measurements](../../spikes/069-provider-history-matrix/measurements.md) |
| What persists when a browser leaves? | Connection, runtime, task, stored conversation and owner have different lifetimes. Browser-backed storage would preserve HP data; it would not by itself preserve its executing Worker or callbacks. | [Ownership and storage](../../spikes/069-provider-history-matrix/ownership.md) |
| What remains to design for HP? | 070 adds working portable storage adapters, fresh-owner resume and historical forks to the earlier core. Production extraction, storage scheduling/durability, cross-tab hosting and management remain design work. | [HP boundary](../../spikes/069-provider-history-matrix/ownership.md#hp-storage-and-hosting-boundary), [070](070-hp-backend-parity.md) |

Two omissions deserve particular visibility. Codex's native history API does not
return the live usage/context series. Claude's official history helper follows a
selected message chain; one 5,767-record source yielded only four visible messages
across a compaction boundary. Neither omission should be hidden by the shared
renderer or repaired by quietly resuming an agent. [027](027-codex-history-replay.md),
[058](058-native-history-access.md), [059 availability](059-data-availability.md).

## The revised Claude direction

The user selected a simpler process-owned arrangement, now exercised in 068:
launch/list and attach are separate; client departure does not stop the process;
attachment replays its complete recorded **stdout** before following live output.
The service forwards client input unchanged and journals stdin/stdout/stderr for
diagnosis. It does not echo recorded stdin to clients, manufacture acceptance
acknowledgements, validate conversation commands, choose a controlling browser
or arbitrate semantic responses. Clients interpret native outputs and coordinate
their state.

This does **not** require the official conversation SDK. Existing SDK-based
qualification remains evidence about the current launcher, while
[068](068-claude-feed-replay.md) investigates the revised native-stream boundary.
Observed native user echoes preserve the submitted UUID, and native command
lifecycle events distinguish queueing, execution and completion. Two concurrent
inputs were queued and completed in sequence by Claude itself. Work also completed
with zero attached clients. The service did not implement that conversation queue.
Actual browser checks separately qualified attach/replay/control with no model
inputs. Two clients also saw the same native permission request: Claude broadcast
the accepted answer and ignored a late conflicting answer. It did not report the
winning client identity. [068 findings](068-claude-feed-replay.md).

Official history helpers remain a separately qualified way to read/fork saved
conversations. A running-process journal is not a replacement for that history,
and the proposed profile `.aiui` location is not yet a production storage contract.

The journal carries transport sequence and direction; the client feed carries
output sequence and replay/live boundaries. A diagnostic stdin record establishes
only its presence in the observed input channel. A user-message echo visible to
clients is native Claude output. Native lifecycle/control responses provide their
own outcome evidence. Replay is client reconstruction; it must not resend old
inputs or execute old callback requests. The versioned consequences are retained in
[RC-13](../../../docs/runtime-contracts.md#rc-13-claude-feed-replay-can-use-native-multi-client-outcomes).

## What to carry into the architecture discussion

1. **Separate management from conversation traffic.** Management owns profiles,
   process identities, launch/stop, endpoints and history access. Provider clients
   own protocol interpretation. Native semantics remain available instead of being
   flattened into the smallest common API.
2. **Share source-aware projections and computations.** Live, native-history,
   journal and ingested inputs can yield related transcript/usage/health views.
   Retain source/version, native identities, missing fields and uncertainty. Keep
   optional development captures separate from normal historical storage.
3. **Make attachment and continuation different actions.** Attaching to current
   work, reading old work, resuming context and forking context have different
   effects. A draft stays unsent until Send. Native history does not restore files,
   terminals, callbacks or JavaScript execution.
4. **Give HP host adapters explicit storage and execution ownership.** Share its
   TypeScript semantics across Node/browser. Choose storage and connection hosts
   around that core; do not introduce browser-only conversation rules merely
   because browser storage differs.

The remaining near-term decisions are narrow: define the first HP storage owner
and restoration boundary, choose the client's behavior for conflicting native
actions where evidence leaves ambiguity, and describe what a lost coordinator
means for its endpoints and journals. We can retain simple history-based relaunch
without solving seamless crash recovery first. The detailed matrices identify
which qualification becomes necessary when each capability is promised.

This report changes no production library, profile or service. New provider spend
is **USD 0**; 068 has its own qualification and usage ledger. Earlier experiment
costs and implementation-assistant usage are not charges incurred by this synthesis.
