# Codex client feasibility: history, live control and observation

**Proposed and executed 2026-10-14.** The user approved the round with agents and
a $5 total provider budget. Read the [combined findings](../../../docs/codex-client-findings.md)
for results, actual coverage, measured usage and remaining checks. The plan below
preserves the original questions; it is not a claim that every subcase ran or a
new SDK implementation contract. Claude work remains at its
[checkpoint](../../../docs/claude-handoff.md).

The next round should establish which facts Codex exposes, when it exposes them,
and which survive after a session ends. That determines how much one client
toolkit can support conversation control, historical investigation, and health
and cost processors. Use stable and experimental APIs; investigate their limits
instead of excluding useful capabilities because they are experimental.

## Recommendation

The approved plan was to run ten small investigations, numbered 025–034, in three parallel tracks after a
shared version/build baseline. Prioritize history completeness and joining active
threads: these can change the eventual SDK and recording design most substantially.
Remote files/processes are a largely independent, mostly inference-free track.
Reuse a small set of real conversations across history, branching and accounting
checks instead of paying to generate a new corpus for every question.

The output should be a capability/evidence matrix, runnable probes, short wire
examples and a revised architecture recommendation. Build enough exploratory UI
to exercise history → join → disconnect and a remote terminal; avoid a dashboard
or a publishable library in this round.

## What we already know, and what remains open

- [007](../spikes/007-codex-protocol-guide.md) inventories 266 named messages from
  installed Codex 0.162.1, with experimental exports enabled. Presence in that
  schema does not prove runtime support. The [inventory](../../apps/web/public/protocol-inventory.json)
  already includes history pagination, filesystem, process, project, section,
  attachment, goal and queue methods worth inspecting.
- [005](../spikes/005-codex-auth-storage.md) demonstrated restart/resume/fork with
  a synthetic provider, but importing model history did not recreate visible
  turns. It did not establish faithful replay of a real, tool-rich session.
- [009](../spikes/009-codex-turn-telemetry.md) measured live per-completion usage
  snapshots and sticky model overrides. Its returned turn objects did not contain
  another usage/cost payload. [012](../spikes/012-codex-context-meter.md) explains
  the version-specific context meter; cumulative usage is not context occupancy.
- [010](../spikes/010-codex-live-subagents.md) observed child events and parent/child
  history, but did not retest late joins or multiple clients. Child activity can
  exist without a preceding `thread/started` notification on the observed stream.
- The Python launcher already supplies a browser-compatible relay, asynchronous
  [message processors](../../../packages/codex-launcher/src/pdum/codex_launcher/observation.py)
  and a [latest-usage observer](../../../packages/codex-launcher/src/pdum/codex_launcher/metrics.py).
  It does not yet supply historical reconstruction, complete health analysis or
  price calculation. Its management API is launch/status/capture/stop, not a
  replacement for native thread APIs.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server),
checked for this proposal, describes reading and paging saved history without
resuming a thread, as well as standalone filesystem and process operations. Those
are promising entry points, not proof that every item or diagnostic survives.
There is also visible documentation/inventory drift: current docs mention
`isPinned`, while the stored 0.162.1 inventory's thread list/metadata fields do
not. Re-export schemas before choosing test payloads.

At proposal time the installed CLI reported **0.162.1**, and there was no
`experiments/vendor/codex` checkout. Earlier builds and private captures were
deliberately excluded by the [research import](../../IMPORT.md). Spike 025 has
since restored and built the clean pin; see its result for executable identities.

## Define what “replay” means

| Operation | What we want to establish |
| --- | --- |
| Browse saved history | Read stored threads/items through app-server without loading an agent, starting a turn, or executing tools. A management process may still be running. |
| Replay a recorded session | Feed a saved observation file through an offline renderer/analyzer, with no app-server, credentials, or network. Recover original timing only if it was captured. |
| Join current work | Obtain history/current state, then follow updates from the same running thread without gaps or duplicates where the protocol allows it. |
| Continue or fork | Deliberately make a thread available for new work; determine whether loading itself can trigger goals or background activity. |

Separately label **structured thread history**, **recorded client-protocol
messages**, **native persisted records**, and **upstream model traffic**. They
are different evidence sources. “Raw” must identify which one we mean. A final
item snapshot may reconstruct a transcript but not its original deltas, timing,
approval decisions, or full upstream request. Replaying history must not resend
old tool calls or control requests.

## Proposed spikes

Each spike now has runnable code under `spikes/NNN-name/` and a result under
`docs/spikes/`. The sections below describe the original intended tests; individual
results distinguish completed checks from source-only evidence and remaining work.

### 025 — Version, source build and protocol baseline

**Question:** Which exact executable, source and capabilities are we testing?

Follow the [vendor instructions](../../vendor/README.md): restore the clean pinned
checkout at `6c372fbef45f730b6d8aa727b0ec8332365588db`, then use the
[003 build procedure](../../spikes/003-codex-control/README.md). The old submodule
command does not apply to this imported workspace. Keep the browser-Origin patch
unapplied; use the existing launcher relay for browser probes.

Record binary path/hash/version, source commit/dirty state, toolchain, OS, build
flags and schema hashes. Read upstream build instructions and record any
toolchain deviation without changing the developer's default tools. Preserve a
clean explicit binary under ignored artifacts. Generate normal and experimental
TypeScript/JSON schemas and compare them with the saved inventory.

Inspect the release source identified by the earlier research
(`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` for 0.162.1), verifying that mapping.
Do not claim the newer historical pin is the installed binary's source. Use the
installed release for continuity and the clean source build for comparison;
if a useful API requires newer upstream, pin that revision separately and test
only the affected cases. Avoid a full version cross-product.

**Deliverable:** reproducible source/build setup, protocol diff, and a short
runtime capability probe with experimental opt-in on/off. Distinguish a schema
entry from an accepted RPC and from successful execution. No inference required.

### 026 — Session catalogue and administrative state

**Question:** Can a client find and organize all relevant conversations without
activating them, and where do our tags/marks belong?

Create a small isolated corpus with distinct names/cwds, roots, children, forks,
archived and ephemeral threads. Exercise `thread/list`, `thread/loaded/list`,
search, name changes, archive/unarchive and disposable-thread deletion. Inspect
project/section APIs, `thread/metadata/update`, attachment APIs and pin support
where available before inventing another metadata store.

Measure pagination order, default filters, source/provider visibility, search
scope, updates during paging, and cross-connection change notifications. Check
persistence over restart and whether mutating a parent affects descendants.
Distinguish profile identity, server lifetime, thread ID, session-tree identity,
parent/child links and fork ancestry. Include threads created through a second
client and, sequentially, the vanilla CLI in the same isolated profile.

**Deliverable:** supported native admin operations and a concrete answer for
tags, pins, notes and application ownership. If an application index is needed,
describe its minimal identifiers and reconciliation needs; do not build one yet.

### 027 — History completeness and offline replay

**Question:** What can we reconstruct after restart, without starting a conversation?

Record one small real conversation with text, a local command, a tool result and
a file change; reuse later image/child/callback cases as they become available.
Read it while loaded, after unloading and after a clean app-server restart using
`thread/read`, `thread/turns/list` and `thread/items/list`. Compare legacy and
paginated storage when supported, summary/full views, both pagination directions,
cursor anchors and reads while the tail is changing.

For every item type, compare the recorded live stream with the returned history:
input, assistant text, visible reasoning, tool arguments/results, stdout/stderr,
diffs, errors, approvals/questions, images, child links, timestamps, effective
model, token counts and context window. Record omitted or truncated information
explicitly. Inspect the pinned history serialization source to explain losses;
read only experiment-owned native records when needed. Private native storage
is a versioned diagnostic fallback, not an assumed stable client API.

Verify history-only reads produce no new turn, tool execution or inference, and
do not load the thread into the active registry. Treat incidental storage/index
maintenance separately from conversation activation. Compare a fresh captured
session with one for which the client recording is intentionally unavailable.

**Deliverable:** a field-by-field live/history/capture completeness matrix and a
small offline renderer/analyzer. State whether “entire session” means all stored
items or a faithful event replay. Show what cannot be recovered retrospectively.

### 028 — Late join, multiple clients and disconnect

**Question:** What exactly does a second client see, and can either client respond?

Use clients A and B against the same app-server through the existing relay. Join
before a turn, during streaming output, while a tool or user question is pending,
and after completion. Compare initialization alone, history reads and
`thread/resume`; do not assume a separate subscribe RPC exists. Record snapshots,
notifications, replayed requests, usage and settings received at each stage.

Deliberately let work progress between reading a snapshot and receiving live
events. Determine the available ordering/anchor guarantees and a reconciliation
algorithm, or document the unavoidable gap. Test duplicate observations, dropped
connections, reconnect, `thread/unsubscribe`, one client leaving and all clients
leaving. Keep app-server alive independently during these connection tests;
then test its restart separately. Do not import Claude's disconnect semantics.

Have either client answer a pending request, then race two answers and send a
late answer. Inspect request-ID scope, `serverRequest/resolved`, cancellation and
loser responses. Test competing starts, steering against a stale turn ID, and
the actual duplicate-submission behavior before recommending retries.

**Deliverable:** annotated wire timelines and a join/control state model. Support
multiple listeners/responders wherever native behavior permits; introduce no
single-controller restriction without a demonstrated correctness reason. Also
show which events a passive launcher observer misses when no client subscribes.

### 029 — Forks, continuation, compaction and side effects

**Question:** What does branching preserve, and what does it actually duplicate?

Fork a completed and an active thread at the supported turn boundaries; compare
whole-history, partial and ephemeral forks. Check parent/child/fork identity,
metadata, settings, tool history, pending questions, goals and usage baselines.
Continue parent and fork with tiny distinct prompts and verify their separation.
Check cold versus warm resume and configuration inheritance using the earlier
[permission findings](../spikes/006-codex-permissions.md) as targeted regressions.

Run one bounded manual compaction and inspect history/context/accounting before
and after. Exercise revert on disposable data. Test whether loading/forking a
thread with a pending goal or queued input starts work automatically, and whether
an available defer control prevents it. Inspect `thread/queue/*` and goal APIs
only far enough to establish these lifecycle implications.

**Deliverable:** history/settings/usage inheritance table and explicit distinction
between branching a conversation and copying files, restarting processes or
repeating external side effects. Do not equate fork or revert with a filesystem
snapshot or Hostfork environment clone.

### 030 — Remote filesystem and terminal operations

**Question:** Can an admin client inspect files and operate a terminal independently
of a live agent, and which execution API should it use?

Exercise `fs/readFile`, directory/metadata reads and watch/unwatch on disposable
text/binary files. Check absolute-path and symlink behavior, nonexistent paths,
changing files, byte encoding and server-side limits. Use small write/copy/remove
round trips only to characterize the available file-management surface.

Compare `command/exec`, experimental `process/*`, and thread-associated shell
commands/background terminals. Use a deterministic real child that alternates
stdout/stderr, waits for stdin, echoes non-ASCII/binary bytes, and exits nonzero.
Test pipes and PTY, stdin close, resize, cancellation, timeout and disconnect.
Record whether output precedes the RPC reply, whether final output repeats prior
deltas, stream ordering, native cap indicators, process-handle scope and cleanup.

**Deliverable:** exact request/reply/event examples and a tiny browser terminal
through our relay. Demonstrate which operations need no thread or inference;
document host/thread permission scope and which process outputs survive in
conversation history. Native output caps are evidence to investigate, not a
reason to add caps to our observation pipeline. A local client/server path proves
protocol behavior; a separate Linux/remote-host check qualifies platform details.

### 031 — Images and other rich prompt inputs

**Question:** How does a browser submit rich input, and what can history show later?

Use a tiny known image and text prompt with Luna after checking its reported
input modalities. Test the actual accepted image forms: client-supplied data,
URL and server-local path where supported. Record who resolves a URL/path and
whether a browser needs a file-transfer step. Include missing/invalid image input
and a capability rejection without silently changing models.

Inspect available text/file references, skills, mentions, additional context and
dynamic-tool result content. Execute one representative extra input form; retain
the rest as a capability inventory. Follow image input through notifications,
stored history, restart and fork; test whether the original asset must remain
available. Compare what the UI can render with what the model received.

**Deliverable:** actual wire examples, a minimal browser image submission, and
asset-lifetime/cost implications. No separate media service in this round.

### 032 — Session health, waiting and swarm visibility

**Question:** Which useful health indicators are facts, and which are heuristics?

Create short cases for a successful tool, repeated failing tools, a deliberately
slow command, a sandbox denial, a pending human/tool/MCP response, interruption,
provider failure, and compaction. Use real local tools and explicit sandbox-on
fixtures for denial cases; leave ordinary runtime defaults unchanged. Bound loop
tests externally. Deterministic injected provider failures test error handling,
not upstream compatibility.

Reuse one small parent/child case if available; if a new live case is needed,
attempt it with Luna and record unsupported behavior without model substitution.
Compare child visibility and totals on live streams and history. Inspect goals,
queues and background terminals for cases where an idle parent still has work.

**Deliverable:** a table mapping indicators to messages, scope and confidence:
tool count/failure rate, repeated-call suspicion, explicit sandbox denials,
pending input, last progress, context pressure/compaction, cache reuse and cost
rate. Separate transport loss, model retry, blocked callback and healthy long
execution. “No recent text” is not proof of a stuck agent; “turn complete” is not
proof an environment is safe to suspend. Alerts remain advisory, with evidence
and unknown/stale states, rather than automatic intervention policy.

### 033 — Usage and API-equivalent cost across time and branches

**Question:** Can the same accounting run in a client, plugin and historical tool?

Reconcile live usage notifications, saved history, replayed captures, available
native telemetry and selected upstream MITM evidence. Reuse the other spikes'
calls. Count completed provider responses separately from user turns and tool
calls. Check warmups, retries, failed/interrupted work, caching, delayed updates,
compaction, process restart, multiple clients, children and forked prefixes.

Determine which identities and cumulative counters allow safe deduplication.
Handle counter resets and imported/inherited history explicitly. Report new
spend on a branch separately from costs of its inherited context; a copied
history is not a second bill. Attribute actual model/provider/service tier per
request when observable, rather than pricing everything at the thread's latest
setting. Start live checks with Luna; test mixed-model accounting offline using
identified evidence or clearly labelled fixtures.

**Deliverable:** a dated price table plus reproducible accounting examples with
known totals, estimates and unknown coverage. For verified inclusive input/cache
counters, use uncached input × input rate + cached input × cache rate + output ×
output rate; do not double-count reasoning output. Add other price components
only when applicable and supported by evidence. Unknown fields/rates remain
unknown. Separate API-equivalent dollars from subscription billing and distinguish
historical-price from today's-price calculations. Do not derive spend by summing
successive cumulative usage snapshots. Distinguish model-completion accounting
from local context recomputation; a changed `last` estimate is not by itself
evidence of another billable response.

### 034 — Shared analysis and Logfire feasibility

**Question:** What minimal analysis can be reused, and where must we observe it?

Feed three inputs into small equivalent computations: a live client stream, the
launcher's existing processor hook, and an offline saved capture. Add a native
history adapter with explicit missing fields. Compare final transcript/usage/
health results on the same corpus, then replay duplicates, gaps, truncated tails,
unknown event types and snapshot-plus-delta overlaps. Preserve original messages
and provenance; do not discard unfamiliar protocol data during normalization.
Keep connection-local sequence numbers separate from native event identities;
our recorder's ordering is not a server-wide replay cursor.

Inspect native telemetry/export settings and compare their coverage with relay
and optional upstream observation. Test one local telemetry collector, then one
Logfire trace/metric export when a destination is configured. Keep run, profile,
thread, turn, item and process correlation where observed; use appropriate links
for forks/children. Avoid high-cardinality metric labels for every message/item.
Test slow/unavailable exporters, backlog/loss reporting and shutdown flush while
the client continues receiving events.

**Deliverable:** a small equivalence test and trace example, plus a recommendation
for the observation points needed when no UI is connected. Our plugin means an
application-owned inspection processor, not necessarily a Rust patch or a Codex
agent plugin. Start with existing hooks and native exporters; propose upstream
instrumentation only for a demonstrated missing signal. Cross-language shared
fixtures may be enough for Python and TypeScript initially; do not create a WASM
layer or a process-per-plugin system merely to share calculations.

## Execution order and evidence discipline

1. **Baseline:** coordinator completes 025 and selects the binaries, schema and
   shared event envelope. Freeze those for the round.
2. **First pass:** three agents own history/admin (026–027), joins (028), and
   files/processes (030). Coordinator owns integration, browser checks, manifests
   and the combined ledger. Give the history agent ownership of the reusable
   corpus; other agents own separate profiles and append identified cases.
3. **Second pass:** extend the history track with 029/031, the lifecycle track
   with 032, and the observation track with 033. Perform 034 after representative
   evidence exists. Stop broadening once the architecture questions are answered.

Use more capable reasoning for join races, persistence and accounting; ordinary
Sol or Luna agents are suitable for bounded schema/file/terminal chores. Agent
model choice is separate from provider probes, which use `gpt-6-luna` explicitly.
The proposal review itself launched no agents; the subsequently approved execution
used three parallel agents and a coordinating track.

Each report must include one representative request/reply/notification sequence,
one important negative case, exact versions, reproduction command, source anchors
and the implication for a client or plugin. Label conclusions **documented**,
**source-inspected**, **observed**, or **unresolved**. Save full private captures
under ignored artifacts; publish only inspected minimal examples and derived
findings. Never use the developer's ordinary sessions as test data.

Create disposable homes/cwds and use explicit executable paths. The default
browser/Node path uses the existing launcher relay. Check a representative direct
native path when distinguishing relay effects. A browser check should use the
available browser automation instead of making the operator do routine testing.
Mac first; run a narrow Linux qualification for process/sandbox/telemetry behavior
when available, without gating history/protocol work on a new machine.

The approved round allowed **USD 5 total**, while retaining the original
**USD 0.50** target and USD 0.05–0.10 aim per paid investigation. This explicit
authorization superseded the repository's lower ordinary investigation allowance.
The coordinator allocates sub-budgets; agents
must not each interpret the whole envelope as theirs. Put turn/tool/time/retry
bounds on probe runners, including compaction/goal cases, not on runtime defaults.
Log every attempt, failures and warmups included; record observed usage, estimated
API-equivalent cost, missing-usage uncertainty and pricing date. Keep orchestration
agent usage separate if reported; do not call it zero when unavailable.

## Architecture hypothesis to test

Keep native protocol types and an escape hatch for new/experimental messages.
Layer optional live connection/control and admin/history access over that
protocol. Below presentation, use small deterministic calculations for usage,
health and reconstructed state, with adapters for live observations and historical
inputs. Offline analysis should not need a live connection or authentication.

These calculations must retain completeness/provenance information. The same
calculation can run in several places without promising the same result from
incomplete inputs. A history adapter must not manufacture live-only timestamps,
pending requests or cost records. The versioned raw capture remains available
when deeper inspection is needed.

Use native metadata for organization when it meets the need; keep pet identity,
swarm membership or arbitrary annotations application-owned only where needed.
Keep Python process/profile management and generic MITM independent of a new
client SDK. Observation stays asynchronous and inspection-only. Monitoring
backlog/failures is required; new quotas and automatic policing are not.

The final review should answer four decisions with evidence:

1. Which historical features work from native storage alone, and which require
   recording from the beginning?
2. What join/reconciliation and multiple-responder behavior can the client promise?
3. What shared analysis inputs and missing-data rules are sufficient across live,
   historical and plugin use?
4. Which small native gaps justify an application API or exporter, and which
   would require an upstream change worth considering separately?

My suggested starting scope is text/images, history/admin, remote files/terminals,
and advisory health/cost analysis. Inventory other surfaces so the future SDK
does not exclude them, but defer voice/realtime media, custom thread storage,
large-scale swarm benchmarks and automatic recovery/remediation unless these
spikes reveal a concrete dependency.
