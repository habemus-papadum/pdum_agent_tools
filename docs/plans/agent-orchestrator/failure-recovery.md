# Host coordination: pragmatic failure and recovery

**Status: policy sketch, 19 October 2026.** The unified host coordinator is an
accepted architectural direction. This document records a pragmatic starting
point and questions for later preferences/spikes, not a recovery implementation
or availability guarantee. See [O21](components/21-host-coordinator.md) for its
management boundary and [O18](components/18-environments-recovery.md) for later
environment restoration.

## The operating choice

This is an internal tool with useful retained history. Seamless continuation is
desirable when practical, but it is not a prerequisite. A failure may lose live
execution, unrecorded output, progress, in-memory state or the latest history
tail. An operator or agentic recovery tool may inspect what remains and relaunch
the work. That is an acceptable recovery outcome when reported honestly.

Do not make independent workers, replicated storage, exact-once execution or a
general distributed supervisor prerequisites for the first useful coordinator.
Keep simple lifecycle seams so stronger recovery can be added where experience
justifies it. Loss acceptance does not introduce intentional capture truncation
or quotas; the normal observation policy still preserves what it receives and
reports failures/gaps.

## Three recovery scenarios

| Scenario | Pragmatic starting policy | Better outcome when qualified | Loss or uncertainty to retain |
| --- | --- | --- | --- |
| **Rediscover running work after coordinator failure** | Read durable run records, inspect the relevant host and verify surviving process/endpoint identity. Rebuild the inventory where possible. If ownership/control cannot be recovered, report the survivor or unknown state and offer inspection or history-based relaunch. | A session worker owns its required endpoint, pipes and capture resources independently, and a new coordinator restores management access. | A live PID does not establish a usable conversation, healthy relay or complete output record. Never kill/adopt a reused PID by name alone. |
| **Reconnect a client to an existing conversation** | Reconnect through the provider's supported interface and refresh its snapshot/history. Do not resend pending turns/tool answers merely because the reply was lost. If no usable live session remains, fall back to supported saved-history continuation or a new run. | Rejoin the same running session, reconcile pending requests and recover its observable tail. | Missing deltas, unknown request outcomes and provider-specific client ownership remain visible. A reconnect is not proof of a fresh runtime or uninterrupted execution. |
| **Reconstruct/relaunch work from retained history** | An explicitly invoked or policy-enabled recovery agent reads available history and current workspace evidence, identifies useful context and launches a continuation/replacement. Native resume/fork is preferred where it fits; otherwise construct a new prompt with provenance. | Restore richer environment state and relationships through supported provider/Hostfork mechanisms. | Partial history, missing jobs/children and uncertain side effects may require revising the task. A replacement is not the original execution, and conversation restoration is not filesystem rollback. |

These are alternatives with different evidence, not a guarantee that every
recovery proceeds through all three. If the host is unreachable, its work stays
unknown until there is evidence; a timeout is not proof that it stopped. If the
available history/configuration is insufficient, describe what is missing rather
than claiming recovery succeeded.

## Existing provider lifetimes are the starting point

**25 October revision:** the Claude row below is the implemented baseline.
[068](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md)
now investigates keeping the process alive across client disconnects and attaching
multiple clients through full feed replay. This does not establish survival of
the process owner or recovery of lost pipes. After process death, native history
remains the continuation path. The upcoming architecture must incorporate the
new evidence instead of treating the old disconnect policy as fixed.

| Runtime | Current boundary | Consequence for the first coordinator |
| --- | --- | --- |
| Codex | Launcher context owns app-server cleanup; the implementation also owns log pipes and any selected relay/sidecar. Native saved-history resume exists. | Wrapping the library does not establish crash survival. Probe the actual launch path; accept history-based continuation when live management cannot be recovered. |
| Claude | Official SDK client owns the query; the Python relay bridges worker pipes. Current disconnect ends the worker; official history helpers provide saved-conversation operations. | Do not promise transparent worker reattachment or reverse-engineer recovery internals. A new supported SDK session using saved history can be the recovery path. |
| HP Node | Agent state lives in its hosting process; its jobs have explicit owner lifetimes and retained in-memory evidence. | A separately hosted runtime could outlive the coordinator, but persistence/re-adoption must be implemented and tested. Otherwise use whatever history was actually exported. |
| HP browser | The page/Worker application owns a local facilitation/test runtime; remote-coordinator administration and implicit cross-tab sharing are outside the initial scope. | Coordinator loss is not its ownership event. Browser-host destruction can lose state; local-history/reload policy remains open. Optional central log storage does not establish a remotely recoverable Worker. |

Normal shutdown, application error, abrupt coordinator death, session-worker
death, relay/MITM failure and whole-host loss are different cases. Preserve
existing cleanup behavior until a specific survival mode is designed and
qualified. Foreground versus daemon hosting alone does not settle those cases.

## A useful recovery record and flow

Start from existing run/history records rather than choosing a new operational
database in advance. Useful evidence includes host/provider/run identity,
profile and working-directory references, effective launch choices, known native
session IDs/endpoints, last observation, available history locations and the
outcome/uncertainty of the last request. Storage layout and flush guarantees are
not fixed here. Credentials remain resolved through the relevant profile/host.

A candidate recovery tool would:

1. Inspect surviving runs and available history without activating new work.
2. Summarize what survived, what is missing and what side effects are uncertain.
3. Select supported rejoin, resume/fork or a new launch with reconstructed context.
4. Inspect the current workspace when deciding whether work needs repeating;
   do not mechanically replay uncertain tool calls or outbound protocol frames.
5. Link the recovery attempt and replacement sessions to the old run/history,
   retaining the old evidence and any reported loss.

The operator or an authorized calling agent can initiate this flow; an eventual
configured policy may automate it. No additional mandatory human approval layer
is implied. Recovery scope, how children/jobs are handled and when to stop or
ask for more information remain preferences to establish. A recovery summary
should distinguish reconstructed context from original recorded history.

Lost launch acknowledgements deserve the same treatment: reconcile recorded
request/run identity before repeating a launch. Exactly which requests receive
deduplication keys, and how incomplete records are handled, belong to the spike.

## Observation, databases and partner hosts

The coordinator can configure traffic taps and aggregate daily status. Place
observations at the relevant runtime/relay boundary, retain source identities,
and let rendering/analysis/export lag independently of agent traffic. A required
relay or proxy is part of the live failure path even if its processors are async.

Local DuckDB and MotherDuck remain interchangeable analytical destinations where
the existing ingestion contract permits. Give local writes a clear owner and
keep expensive queries off the management event loop. Retain enough local
operational evidence to inspect/reconcile work during a cloud outage; an empty
or stale analytics result must not erase a known run. Unflushed observations
lost in a crash may be reported as a gap even when their exact size is unknown.

Each partner coordinator owns its local processes. Another coordinator may
aggregate its inventory or relay management calls, with direct session endpoints
or an explicit relay route returned to the client. No global consensus or
cross-host automatic takeover is required by this sketch.

## Questions and bounded spikes for later

- For each provider, interrupt only the coordinator while work is active;
  restart it and measure process survival, endpoint usability and retained data.
- Disconnect a client during a turn or pending request; establish what supported
  rejoin actually restores and whether a new session is required.
- Kill the runtime separately; exercise one history-based reconstruction and
  compare recovered context, missing output and current workspace effects.
- Lose a launch acknowledgement; demonstrate discovery of an existing run or
  an explicit unknown outcome rather than an unnoticed duplicate launch.
- Make the observer/database unavailable, then a peer host unreachable; separate
  stale status, recording loss and actual execution failure.

For each case, record process fate, saved-history coverage, uncertain actions,
recovery method and practical operator effort. Then choose the cheapest useful
policy. Specific loss budgets, retry/automation rules, daemon service setup,
independent worker design and guarantees remain **TBD**. No new runtime code or
failure probes are part of this planning update.
