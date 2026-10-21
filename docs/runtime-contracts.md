# Runtime contracts and gotchas

**Canonical integration reference; last qualified 19 October 2026.** Read the
applicable entries when designing or implementing launchers, client SDKs, the
orchestrator, history views or background jobs. This is where consequential
findings graduate from individual spikes into the infrastructure's working knowledge.

These are versioned facts and implementation implications, not promises that an
upstream provider will never change. Product choices remain explicitly open.
The [design principles](design-principles.md) own our agreed operating stance;
package specifications own APIs; [implementation status](implementation-status.md)
owns what we have implemented. Spike reports retain experiments and detailed evidence.

## Index

| ID | Point to retain | Implementation owner |
| --- | --- | --- |
| [RC-01](#rc-01-runtime-state-is-not-task-completion) | Loaded/idle, unloaded, archived and stale are different facts. | Inventory, overview and shared state model |
| [RC-02](#rc-02-subscriptions-control-ordinary-idle-retention) | A subscribed idle conversation does not expire because nobody types. | Client connection/session layer |
| [RC-03](#rc-03-turn-start-does-not-resume-an-unloaded-thread) | Resume on attachment/reconnection; no status check before every turn. | Codex client SDK |
| [RC-04](#rc-04-unloading-can-kill-background-terminals) | Runtime unloading terminates managed terminals; history does not restore processes. | Coordinator/job ownership and session UI |
| [RC-05](#rc-05-resume-can-have-side-effects) | Resume can activate goals or rebuild a runtime when overrides differ. | Client intent handling and history UI |
| [RC-06](#rc-06-idle-delay-is-native-server-configuration) | The timer is a server startup setting; zero means immediate, not disabled. | Profiles and launch configuration |
| [RC-07](#rc-07-observation-and-recovery-have-gaps) | Closure events lack a reason; teardown reads can race; delivery may be unknown. | Client recovery and observation processors |
| [RC-08](#rc-08-lifetimes-are-provider-specific) | Codex, our Claude workers and HP must retain their distinct lifetime semantics. | Provider adapters and shared application model |

## Evidence baseline

RC-01–RC-07 refer to **Codex 0.163.0**, release source
`83086188ae0614bd882818ff1aa23f3194962012`. [056][spike056] traced native lifecycle
code and ran 18 isolated protocol checks. [057][spike057] used the production
launcher/relay and real Luna turns to verify managed-terminal termination,
unloaded-turn rejection and resume/new-turn success on macOS. It records its
harness failures and narrower follow-up checks rather than claiming an entirely
clean run. Timer defaults, some race paths and child-eviction rules are source
findings; not every condition below was reproduced live.

No production client SDK or automatic recovery policy is implied by these
results. Recheck affected contracts when upgrading the native executable or
changing transport, process ownership or host platform.

## RC-01 — Runtime state is not task completion

Codex's **Ready** maps to a loaded, idle runtime; **Inactive** maps to `notLoaded`
in the app-server being queried. It does not establish success, failure or
archival, nor prove that no other server has related work running. Observation
freshness is another independent fact. A displayed “updated” age is not the
unload deadline. [Evidence: 056][spike056].

**Carry into implementation:** retain runtime state, current turn state, archival,
endpoint/owner identity and observation freshness separately. An idle parent can
still have background work. Do not infer objective completion from its UI group.

**Regression to retain:** show an unloaded but readable unarchived conversation,
an idle thread with a running terminal, and an unreachable source whose last
known state is preserved.

## RC-02 — Subscriptions control ordinary idle retention

Ordinary automatic unloading requires **no subscribed connections and non-Active
status** for the configured interval. It starts from whichever condition became
true later. Active turns and pending approval/user-input flags prevent this path.
A system-error state is non-Active despite appearing in the attention category.
Merely opening a WebSocket or reading history does not subscribe to a thread;
`thread/start` and `thread/resume` do. [Evidence: 056][spike056].

**Carry into implementation:** track native attachment per connection/thread.
Several UI listeners may share it; removing a local listener is distinct from
native `thread/unsubscribe`. No typing heartbeat or per-message status polling is
needed while attached. One other subscribed client keeps an ordinary idle thread
loaded. This does not protect against explicit shutdown, crashes or every V2 child
capacity-eviction path.

**Regression to retain:** idle beyond the shortened delay while subscribed;
unsubscribe one of two clients; then remove the last subscription and observe unload.

## RC-03 — Turn start does not resume an unloaded thread

Native `turn/start` performs a loaded-runtime lookup. After unload it rejects
with `-32600`, `thread not found: <id>`, without accepting the input. Our relay
passes this through. `thread/resume` rejoins a loaded runtime or reconstructs one
from saved history under the same thread ID and subscribes the connection. The
app-server process need not restart. [Direct check: 057][spike057].

**Carry into implementation:** initialize and resume once when opening or
reconnecting; send subsequent turns directly. Invalidate attachment on transport
loss or native closure. Keep conversation recovery in the client/session layer;
the launcher remains a transparent process/transport owner.

The error has no structured “unloaded” subtype and can also mean an unknown ID.
Do not interpret every `-32600` as a safe retry. A narrowly recognized lookup
rejection is different from an ambiguous timeout after submission.

**Open policy, needed when implementing session recovery:** should an explicit
send to a known detached conversation automatically reattach and retry a confirmed
rejection once? Preserve the user's intended steering/queueing semantics after
reconciliation. This helper is a proposal, not current launcher behavior.

**Regression to retain:** send after unload, verify rejection and no new turn,
resume, then send successfully through the same server/relay. Separately simulate
connection loss after submission and ensure the prompt is not blindly duplicated.

## RC-04 — Unloading can kill background terminals

A retained managed terminal does not itself keep Codex's thread status Active.
Session teardown explicitly terminates registered processes. In 057, a verified
OS process wrote heartbeats while its thread was idle, survived beyond the delay
while subscribed, and was killed after the final unsubscribe and automatic unload.
Resume restored the conversation but not the terminal. [Direct check: 057][spike057].

**Carry into implementation:** describe unloading as teardown, not resumable
process suspension. Conversation history is not a checkpoint of shell handles,
MCP connections, memory or filesystem state. Keep job ownership and desired
lifetime explicit. Arbitrary detached services and remote termination were not
qualified by that local test. Child agents have additional retention/eviction
rules; do not treat every background activity as a terminal.

**Open policy, needed before promising work survives closing a view:** deliberately
retain a native subscription, use a separately owned job, or accept termination
with a visible consequence. Increasing the timeout only postpones teardown.
No option has been selected as a universal default.

**Regression to retain:** verify registry membership, actual process identity and
progress before unload; verify termination before natural completion; then resume
and confirm the old process is not resurrected. Add separate checks for each new
host/job adapter whose survival we promise.

## RC-05 — Resume can have side effects

Warm and cold resume invoke idle lifecycle extensions; a saved active goal can
start work. Source also shows that mismatched resume overrides can rebuild an
unsubscribed idle runtime before its ordinary timeout, invoking teardown. A
concurrent `turn/start` can add input to an already active turn rather than create
a distinct execution. [Evidence and qualifications: 056][spike056], [057][spike057].

**Carry into implementation:** use history reads for inspection. Rejoin with only
the needed resume parameters, and make configuration changes deliberate. Reconcile
the resulting turn state before applying explicit send intent. A fleet overview
must not quietly resume every entry just to gather metrics.

**Regression to retain:** passive history browsing starts no runtime; ordinary
rejoin avoids gratuitous overrides; a resumed active goal cannot silently turn an
explicit “next turn” action into steering the current one. Goal/override cases
need their own bounded qualification when that client behavior is implemented.

## RC-06 — Idle delay is native server configuration

The top-level native `thread_unload_delay_secs` defaults to **1800**. It takes
nonnegative integer seconds; **zero requests immediate eligibility**. No disable
sentinel was found. It is captured at app-server startup and requires restarting
that server to change; per-thread overrides and native `[profiles.*]` are not
the setting's scope. [Source and launch check: 057][spike057].

Our separate-home profiles can place it at the root of native `config.toml`, or
use the existing launch-only override:

```python
LaunchOptions(config_overrides={"thread_unload_delay_secs": "7200"})
```

**Carry into implementation:** expose the native setting and its scope, without
a second launcher timeout schema. Native Codex may write other settings itself:
`thread/start` persisted project trust during 057, so whole-file immutability was
an invalid probe assertion even though the launch override was not persisted.

**Open policy, needed when choosing profile/run defaults:** decide whether a
particular workload wants the native default, a longer interval or deliberate
retained attachment. Do not change operator settings based solely on this ledger.

**Regression to retain:** launch with a short override, inspect its effective
value, measure unloading and verify that override was not written into config.

## RC-07 — Observation and recovery have gaps

An initialized passive connection can receive `thread/status/changed` →
`notLoaded` and `thread/closed` without retaining a thread subscription; 057
observed both. `thread/closed` has no typed cause. Relay processors only see
traffic that exists while an upstream connection exists. Teardown can also race
full-history reads and produce a misleading “not materialized yet” error despite
intact history; post-closure reads succeeded. [056][spike056], [057][spike057].

**Carry into implementation:** preserve native errors and uncertainty. Use events
and occasional reconciliation at reconnect, not status checks on every send.
Do not mistake a closing-state read failure for deletion. A closing resume may
need a bounded retry; transport loss or generic submission errors do not prove
the input was rejected. Inspection hooks stay asynchronous and do not gate relay
forwarding. A future coordinator's passive observation connection is a separate
role from keeping conversations attached.

**Regression to retain:** observe unload without pinning; read after confirmed
closure; handle reconnect gaps and a lost acknowledgement without inventing
completion or replaying an action with unknown delivery.

## RC-08 — Lifetimes are provider-specific

Our [Claude launcher](claude-handoff.md) intentionally ends a worker when its
client disconnects; later resume starts a new worker from saved history. That is
our implemented integration contract, not evidence of a native Claude equivalent
to Codex's timer. [HP background work](hp-agent-work.md) has its own job ownership
and cancellation primitives; its future idle-retention policy is still open.

**Carry into implementation:** shared UI can describe capabilities and ownership
without promising uniform disconnect, pause, resume or job-survival behavior.
Keep the portable HP core's semantics consistent across Node and browser, and
state what each host adapter can actually preserve.

**Regression to retain:** run each provider/host's own disconnect and resume
cases. Do not establish parity by mapping all native states into one “Inactive”
flag. Ask the unresolved HP retention questions when the live job-lifetime slice
needs an answer.

## Keep this document useful

At the start of a relevant slice, cite applicable RC IDs in its plan, connect
them to acceptance checks, and identify which open policies now need an answer
using the [working method](plans/agent-orchestrator/methodology.md). This is a
planning aid, not a new approval step for already delegated engineering work.

Add an entry when a finding could change API design, lose work, misreport state
or create a surprising side effect. Use the same compact shape: stable ID,
provider/version/date and evidence, observed behavior, implementation consequence
and owner, regression scenario, and unresolved policy with its needed-by trigger.
Mark source-only, measured and proposed behavior distinctly. An entry's checks
are obligations for the affected implementation, not assertions that tests exist.

Update an entry after new qualification instead of copying a growing explanation
into every plan. Link the owning specification and implemented test when they
exist; retain changed/superseded findings with their version boundary. Keep spike
reports as the detailed evidence. This initial ledger covers the lifecycle round;
it is not yet an exhaustive extraction of earlier research.

[spike056]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/056-codex-inactive-lifecycle.md
[spike057]: https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/057-launcher-inactive-turns.md
