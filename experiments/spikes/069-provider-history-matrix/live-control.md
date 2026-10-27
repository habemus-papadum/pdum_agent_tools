# Attachment, controls and multiple clients

“Several clients” means several connections to **one execution owner**, not
several independent processes concurrently writing the same saved conversation.
The latter is not established by these results. See the [version/status key](README.md).

**070 update:** [the HP backend study](../../docs/spikes/070-hp-backend-parity.md)
adds ordered notification replay over actual MessagePorts in Node and a Chrome
Worker, independently of RPC input and persistence. Clients detached/rejoined
without stopping the owner or resubmitting recorded actions. Its fresh-owner
restore helpers are still distinct from a production network `thread/resume` API.

| Capability | Codex | Claude: current integration and 068 direction | HP Node/browser shared core |
| --- | --- | --- | --- |
| Launch separate from attachment | **Observed:** launcher owns server; clients connect and initialize separately. Thread creation/resume is another operation. [028][joins], [065][lifecycle] | **Current production:** allocate identity, lazy worker on SDK attach. **Observed 068:** launch native process, attach clients independently; process outlives attachments. [016][claude], [068][raw] | **Observed:** host constructs runtime, then binds MessagePorts. Browser Worker and Node port demonstrations use same core. [039][hp], [040][hp-live] |
| Attach to existing live work | **Observed:** `thread/resume` subscribes and returns native snapshot. Read/initialize alone do not subscribe to its complete turn stream. [028][joins] | **Current production:** one SDK controller per worker. **Observed 068:** attach to launcher-owned process feed without SDK. No discovery/adoption of arbitrary native CLI sessions implied. [068][raw] | **Local-tested:** several ports observe one runtime. Existing RPC has no `thread/resume`; initialized connections receive runtime notifications, reads supply snapshots. [049][control], [protocol][hp-protocol] |
| What a late join receives | **Observed:** snapshot plus pending requests, not full past stream. An unfinished text prefix was missing until completed item replaced it. No global replay cursor was established. [028][joins] | **Observed 068:** full recorded stdout with explicit replay/live boundary; two real browser contexts received identical output. Stdin is journaled but never synthesized into the client feed. [068][raw] | **Source:** future notifications after initialize; explicit current snapshot/recording reads. No atomic snapshot-plus-cursor attachment contract yet. [protocol][hp-protocol] |
| Multiple input senders | **Observed:** native server handles submissions; repeated `clientUserMessageId` did not make two sends idempotent. [028][joins] | **Observed 068:** relay forwards unchanged; native user echo preserves UUID; command lifecycle marks queued/started/completed. Two concurrent prompts completed in native sequence. General duplicate-input policy remains unqualified. [068][raw] | **Source/local-tested:** all bound clients address same runtime. `turn/start` during active turn explicitly rejects; caller must choose steer. Broader concurrent-control races need focused qualification. [runtime][hp-source], [049][control] |
| Human/dynamic tool responses | **Observed:** multiple clients can answer ordinary human/dynamic requests; first response wins, late answer may receive no acknowledgement. Some authentication callbacks have owner exceptions. [028][joins] | **Observed 068:** both clients see `can_use_tool`; Claude broadcasts accepted allow response, ignores late opposing deny. Repeated initialize exposes pending permissions; replay resolves answered request. Winner client identity is absent. [068][raw] | **Gap:** no general human/permission callback arbitration service in current prototype. Host-executed tools and agent mailboxes are not a substitute. [052][jobs] |
| Steering an active turn | **Observed:** native `turn/steer` checks expected active turn; stale ID rejected. Submitting another `turn/start` can instead add input to the active turn. [028][joins], [056][inactive] | **Observed 068:** two concurrent inputs execute as sequential commands. Mid-generation steering semantics remain unqualified; do not call this Codex-equivalent steer. [068][raw] | **Observed/local-tested:** queued startup input, provider steering, committed/rejected/unknown states, tool-boundary ordering. Live control and browser delegation qualified separately. [048][steer], [049][control] |
| Queue a later turn | **Observed:** `thread/queue/add` on idle loaded thread immediately starts work. It is not a passive draft store. [029][fork] | **Unqualified:** map native input admission/timing before promising an after-turn queue. | **Gap:** general user-submission queue absent. Agent queue-only mail and explicit followup are implemented but have distinct semantics. [047][dynamic] |
| Interrupt | **Observed:** native interrupted turn; selected shell process could remain alive until runtime end. [065][lifecycle] | **Observed current SDK:** result error followed by matching cancelled command UUID; selected shell process exited. **Observed raw 068:** idle interrupt acknowledges. Active raw-stream cancellation remains unqualified. [065][lifecycle], [068][raw] | **Observed/local-tested:** thread/subtree scopes; waiting parent can stop without cancelling child; late tool effects remain explicit. Browser shares local scenarios; live interruption recovery in 049 was Node. [047][dynamic], [049][control] |
| Multiple clients' job waits | Standalone process handles are connection-owned; thread background terminals have other ownership. No common generic job API qualified. [030][remote], [057][terminal] | Live task notifications do not establish a uniform job-control or completion contract. [059 ledger][availability] | **Local-tested in Node/Chrome:** connection-owned wait IDs; cancelling/detaching waiter leaves producer and other waiters. Host must clean up abrupt connection loss. [052][jobs] |

## Tools, parallel work and agents

| Facility | Codex | Claude | HP Node | HP browser |
| --- | --- | --- | --- | --- |
| Tools and tool results | **Observed:** commands, files, MCP/dynamic tools in live/history; some failures only in native logs/telemetry. [027][history], [034][telemetry] | **Observed:** Bash/tool callbacks, separate tool-use/result blocks, history children/tool images. [014][claude-old], [059][availability], [067][live-history] | **Observed:** native-shaped shell/patch tools, explicit skill loading and real HTTP MCP adapter; model coding task passed. [042][tools], [045][behavior] | **Observed:** model uses application tools. Remote execution/MCP adapter bundles; actual shell lives in a host adapter, not browser core. [042][tools], [045][behavior] |
| Parallel tool execution | **Source/observed native work:** step-scoped shared/exclusive scheduling; tools can start before the model stream finishes. [050][parallel] | **Unqualified here:** no equivalent scheduler/timing contract was established by these studies. | **Observed:** model-selected eligible tools overlap; exclusive by default; outputs rejoin in call order. [052][jobs] | **Observed:** identical model-selected parallel case in real Chrome Worker. [052][jobs] |
| Independent subagents | **Observed:** native child threads, recurring work, activity and histories. [032][health], [059 family][family] | **Observed history:** root-session + agent-ID helpers; parent edges can be incomplete. These exports do not qualify every live control. [059 family][family] | **Observed:** model-selected spawn, message/wait and independent histories, through async core executions. [045][behavior], [049][control] | **Observed:** parent/child both run in Worker; no subprocess required. [045][behavior], [049][control] |
| Background work beyond a turn | **Observed:** managed terminal can survive interrupted turn; unload later kills it. [057][terminal], [065][lifecycle] | **Observed history:** task launch/stop and some notifications. General task quiescence/survival remains unqualified. [059][availability] | **Observed:** async job survives initiating turn and interruption; shell adapter shares registry. [051][background], [052][jobs] | **Observed:** async application job with structured input/progress/result survives initiating turn. CPU-Worker and AIUI-cell adapters remain future work. [052][jobs] |

The client should show the action's target, timing and observed outcome. It should
not translate a missing acknowledgement into rejection or resend an uncertain
prompt. Multiple listeners do not justify an exclusive-controller rule, but they
do require clients to reconcile native request identities and completed results.
Transport replay itself must remain passive. These rules follow RC-03/04/05/07/08/13.

068 also distinguishes two kinds of rejection. An unsupported control subtype
receives a correlated native error. Malformed JSON forwarded unchanged instead
ends the native process with code 1 and a stderr diagnostic; there is no correlated
stdout rejection. The service deliberately does not validate JSONL. Client codecs
and explicit process-exit observations therefore matter. The accepted permission
response is visible to every client, but does not identify which client answered;
the losing reply has no separate native outcome event. These are measured limits,
not reasons to move semantic arbitration into the server.

Output sequence numbers come from the whole channel journal, so intervening
stdin/stderr records can create legitimate gaps in the stdout-only sequence.
A client must not report those gaps as lost output; the replay boundary and
transport delivery evidence have their own scope.

For the new Claude path, keep the server's responsibility mechanical: process
ownership, complete transport records, ordered attachment and fan-out. The client
library can suppress stale controls, expose unresolved responses and reconstruct
state. It cannot promise a native acceptance signal that the tested executable
does not emit. 068 owns the evidence for that boundary.

[joins]: ../../docs/spikes/028-codex-joins.md
[fork]: ../../docs/spikes/029-codex-forks.md
[history]: ../../docs/spikes/027-codex-history-replay.md
[remote]: ../../docs/spikes/030-codex-remote-operations.md
[health]: ../../docs/spikes/032-codex-health.md
[telemetry]: ../../docs/spikes/034-codex-observation.md
[inactive]: ../../docs/spikes/056-codex-inactive-lifecycle.md
[terminal]: ../../docs/spikes/057-launcher-inactive-turns.md
[lifecycle]: ../../docs/spikes/065-session-lifecycle.md
[claude]: ../../docs/spikes/016-claude-client-sessions.md
[claude-old]: ../../docs/spikes/014-claude-app-server.md
[raw]: ../../docs/spikes/068-claude-feed-replay.md
[hp]: ../../docs/spikes/039-hp-agent-runtime.md
[hp-live]: ../../docs/spikes/040-hp-integration.md
[tools]: ../../docs/spikes/042-hp-tools-skills.md
[behavior]: ../../docs/spikes/045-hp-behavior.md
[dynamic]: ../../docs/spikes/047-hp-dynamic-control.md
[steer]: ../../docs/spikes/048-hp-steering-edges.md
[control]: ../../docs/spikes/049-hp-control-integration.md
[parallel]: ../../docs/spikes/050-hp-parallel-tools.md
[background]: ../../docs/spikes/051-hp-background-jobs.md
[jobs]: ../../docs/spikes/052-hp-work-integration.md
[family]: ../../docs/spikes/059-agent-family-evidence.md
[availability]: ../../docs/spikes/059-data-availability.md
[live-history]: ../../docs/spikes/067-live-session-workspace.md
[hp-source]: ../039-hp-agent-runtime/src/runtime.ts
[hp-protocol]: ../039-hp-agent-runtime/src/protocol.ts
