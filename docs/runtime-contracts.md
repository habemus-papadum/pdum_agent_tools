# Runtime contracts and gotchas

**Canonical integration reference; last updated 26 October 2026.** Read the
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
| [RC-09](#rc-09-history-is-a-projection-of-evidence) | History methods expose different clocks, settings, activity and usage; missing data is not inactivity. | Historical viewer, minimap, health and accounting |
| [RC-10](#rc-10-duration-and-completion-have-a-scope) | Reported elapsed, observed intervals, waits and background lifetimes differ; child completion can recur. | Tool/family timelines and health interpretation |
| [RC-11](#rc-11-authentication-status-is-not-model-access) | A selected token can appear logged in without being valid for a model request. | Profile authentication and launch readiness |
| [RC-12](#rc-12-continuation-preserves-native-boundaries-and-separates-drafts) | Resume/fork keeps native boundary semantics; opening a continuation does not send a draft or restore files. | Native history and session handoff |
| [RC-13](#rc-13-claude-feed-replay-can-use-native-multi-client-outcomes) | A process-owned Claude feed can serve several clients; native echoes and resolved callbacks drive state. | Claude transport and browser/Node client |
| [RC-14](#rc-14-hp-history-restores-context-through-host-independent-storage) | Portable HP archives restore context across owners/backends; execution and billing scope remain explicit. | HP storage/restore, host adapters and accounting |

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

**Orchestrator policy selected 26 October:** no retained host subscription for
keepalive/observation. Normal client attachment still subscribes. Offer longer
unload timing at server launch and expose the inherited value when reusing a
server; increasing the timeout postpones teardown rather than guaranteeing job
survival. Separately owned jobs and stronger survival modes remain later features.
This policy choice does not change the measured native teardown behavior.

**Regression to retain:** verify registry membership, actual process identity and
progress before unload; verify termination before natural completion; then resume
and confirm the old process is not resurrected. Add separate checks for each new
host/job adapter whose survival we promise.

**Active interruption follow-up, 25 October (065):** a Luna-driven 20-second shell
process was still alive after its native turn reported `interrupted`. Disconnect
left the owned Codex server alive. Explicit runtime end was followed by verified
tool-process exit before its completion marker could be written. Retain the
distinction between interrupting a turn/wait and ending managed execution. The
selected Claude sleep tool exited on interruption, which is separate provider
evidence, not a universal tool-cancellation guarantee. [065 evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/065-session-lifecycle.md).

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

**26 October review:** expose a longer-than-30-minute choice during session/launch
creation, without a retained host subscription. Apply it as a native server-start
override when launching that server, not a per-thread parameter or implicit global
config edit. A reused server has its existing shared timer; changing that requires
an explicit new/restarted server choice. The user has not chosen a numerical longer
default. Ordinary user-facing client subscriptions are unaffected.

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

**Owner-loss follow-up, 25 October (065):** SIGKILL of an isolated Python owner
left two native Codex PIDs alive at the two-second observation. A native Unix
socket still initialized, but the public WebSocket relay had disappeared with
the owner. Claude's worker exited. Graceful stdin EOF reaped the remaining owned
processes. A surviving process therefore does not establish a surviving client
endpoint or recovered ownership. Previous owner records must remain unowned
observations unless a separately qualified recovery operation adopts them.
The crash probe cleaned up survivors by recorded PID plus creation time; the
application did not automatically adopt or reconnect them. [065 evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/065-session-lifecycle.md).

## RC-08 — Lifetimes are provider-specific

Our [Claude launcher](claude-handoff.md) intentionally ends a worker when its
client disconnects; later resume starts a new worker from saved history. That is
our implemented integration contract, not evidence of a native Claude equivalent
to Codex's timer. [HP background work](hp-agent-work.md) has its own job ownership
and cancellation primitives; its future idle-retention policy is still open.

**Direction revised by the user, 25 October:** this disconnect behavior is not
the target for the next Claude client. [068](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md)
investigates a launcher-owned native process with separate launch/attach, multiple
clients and complete running-session feed replay. The server forwards input
unchanged and records transport evidence; clients interpret native outcomes and
coordinate their actions. No official conversation SDK or server-side acceptance
echo is required. Production behavior remains unchanged until that replacement
is implemented. Ordinary native history and restart-from-history stay distinct
from the running process's replay journal.

**Carry into implementation:** shared UI can describe capabilities and ownership
without promising uniform disconnect, pause, resume or job-survival behavior.
Keep the portable HP core's semantics consistent across Node and browser, and
state what each host adapter can actually preserve.

**Regression to retain:** run each provider/host's own disconnect and resume
cases. Do not establish parity by mapping all native states into one “Inactive”
flag. Ask the unresolved HP retention questions when the live job-lifetime slice
needs an answer.

**Cancellation result follow-up, 25 October (065):** interrupting the selected
Claude shell tool emitted a result with `error_during_execution`/`is_error: true`,
then a `command_lifecycle: cancelled` event matching the submitted prompt UUID.
Its worker remained connected until SDK disconnect. The UI may classify that as
requested interruption only after matching explicit local intent and native
cancellation identity, while retaining the raw error. An interrupt acknowledgement
alone, a different command's cancellation or an unrelated error is insufficient.
Three replay regressions pin that interpretation; the native result is not rewritten.

## RC-09 — History is a projection of evidence

**Observed 24 October 2026**, using Codex 0.163.0/0.164.0 history exports and Claude
SDK 0.2.165: full Codex thread records carry turn clocks in Unix seconds; separate
paginated item entries can carry start/end clocks in Unix milliseconds. Durations
on bare items are not wall-clock anchors. The Claude SDK's `SessionMessage`
conversion omits original message timestamps and filters to its selected visible
chain. Its model response stop reason does not by itself qualify completion of
the controlling SDK query. Source inspection also confirms that Codex's history
projection omits token-count/usage-record events.

The same corpus contains native Codex `subAgentActivity` records with child
identity and activity kind. Some carry model/effort specifically for child
creation, not the parent's settings. Their child transcripts were not included
in the initial catalogue. Existing ingestion may expose additional clocks,
settings and usage; it is a distinct source, not an implied native history field.
See the [versioned audit](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-evidence-inventory.md).
The evolving [availability ledger](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-data-availability.md)
connects those observations to field provenance and future type design. In
particular, producer, reader and adapter versions are different facts; a reader
version on an export does not establish which features produced every record.

**Ingestion follow-up, 24 October (061):** the existing Claude ingestor synthesizes
`token_counts.last_total_tokens` from a response's input/cache/output counters.
That column is not independent evidence of measured context occupancy. The new
statistics view leaves Claude context unknown. Source inspection also found
joins in the existing question pack that omit `source_id`; a native thread may
be present in more than one ingested source, so those joins can multiply usage
or borrow another source's model. The 061 session query joins scoped identities;
its borrowed question runner refuses duplicate-thread multi-source input until
that toolkit path is qualified. This is a recorded toolkit limitation, not a
change to native provider behavior or a completed production query repair. See
[061](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/061-ingestion-statistics.md).

**Live/history comparison, 25 October (067):** one real browser file-read turn per
provider produced identical ordered conversation/tool content in the live and
saved projections, with different surrounding evidence. Codex's three native
item IDs matched across sources; its live token/context notifications were absent
from the saved projection. Claude's response counters agreed after deduplication,
while live SDK cost/model capacity were absent from saved helper messages. Its
response IDs and saved wrapper UUIDs differed. Codex input includes cached tokens;
Claude's raw input count is uncached, with cache counters separate. Preserve this
basis in shared measurement displays. This qualifies two selected simple turns,
not general transcript equivalence. [067 evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/067-live-session-workspace.md).

**Carry into implementation:** retain field provenance and actor identity.
Distinguish occurrence time, capture/receipt time and duration. Do not interpolate
missing event timestamps and present them as measured. A gap between parent turns
does not establish inactivity of children/jobs, and missing observations are a
different condition. Text mentioning steering is not request/acceptance evidence.
Preserve unfamiliar native activity until its semantics are qualified.

**Regression to retain:** join paginated item clocks by native identity; keep
unknown clocks/usage unknown; do not apply a child's model to the parent; retain
out-of-catalogue children; distinguish prompt images from tool images inside a
user-role container; compare gap compression with overlapping child activity.

**Open policy, needed before shipping time/health/accounting claims:** choose and
qualify optional enrichment sources, incomplete-coverage presentation and any
automatic gap rule. Thirty minutes is a mock example, not a runtime threshold.
This audit does not add an enrichment pipeline or a private recovery parser.

## RC-10 — Duration and completion have a scope

**Observed 24 October 2026:** a Codex 0.164.0 parent/five-child collection contains
5,785 fully paged native items. Reported command/MCP/sleep duration and differences
between producer start/end clocks are separately available and can differ by
milliseconds. All user-message items and image-view items have equal endpoints
but no reported execution duration. Those point-like records should not acquire
invented execution-time badges. One turn lacks an end/duration; it stays unknown.

The parent has 53 completion activities referring to captured child turns across
five children. This is recurring work completion, not 53 process terminations.
Source inspection shows that unified execution can emit a command completion
after its launching turn ends, while dynamic-tool duration includes awaiting an
external response. Earlier client captures separately demonstrate a late command
completion and started commands without observed completion. Receipt intervals
remain different from producer timing.

Claude SDK 0.2.165 returned selected families and background tool requests without
message-wrapper timestamps or structured execution durations. Collector read
latency is not tool duration. See the [family evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/059-agent-family-evidence.md)
for native evidence, source-only qualifications, tests and remaining gaps.

**Carry into implementation:** label timing basis and actor/operation. Preserve
native reported elapsed, recorded interval, observed wait and background lifetime
separately. Missing is not zero; historical missing ends do not mean still running
today. Overlapping durations do not sum to wall-clock elapsed. Keep reusable
children discoverable after a work-completion event unless separate lifetime
evidence establishes otherwise.

**Regression to retain:** keep zero/null/different timing scopes distinct; join
paged clocks by native identity; preserve unmatched endpoints; never mix different
client monotonic clocks; distinguish child work completion from termination; keep
Claude parent identities and duplicate response IDs explicit across family views.

**Open policy, needed before automated health judgments:** define expectations
per operation/workload. Intentionally long-running jobs, sleeps and waits are not
unhealthy simply because their elapsed time is large. No generic duration timeout
or slow-tool threshold is selected by these observations.

## RC-11 — Authentication status is not model access

**Observed 25 October 2026**, Claude Code 2.1.310 with official Node SDK 0.3.296:
an isolated profile supplied a deliberately invalid `CLAUDE_CODE_OAUTH_TOKEN`.
Native `claude auth status --json` returned `loggedIn: true`, `oauth_token` and
exit 0. Two official SDK clients also initialized and listed isolated profile
commands without submitting any model request. [066 evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/066-claude-setup-token.md).
The initially supplied operator token was then rejected by both an SDK request and direct
native CLI request with a 401, despite positive status. Both native results had
`subtype: success` with `is_error: true` and zero usage. The result subtype alone
is therefore insufficient too. A later operator-supplied replacement passed three
Haiku replies plus one intentional invalid-token rejection. The already-running
worker retained its original injected credential when the reference changed;
new allocations used the changed value. Restoring it allowed a fresh worker to
succeed. This is an allocation-time environment snapshot in our harness, not
evidence of native refresh or server-side revocation behavior.

**Carry into implementation:** show credential source/presence separately from
last successful model access. A native status result or initialized SDK transport
must not be labelled verified entitlement, working inference or successful token
renewal. Check `is_error` as well as the result subtype. Model validation is an
explicit bounded operation with its own usage. Keep credential assignment and
worker environment lifetime separate: changing a reference does not reconfigure
an already-running process.

**Regression to retain:** an invalid token may have positive status; the UI must
preserve unverified model access. Keep missing/failed live results visible. Use
the actual chosen model for a successful-access claim, rather than extrapolating
to all models or all future requests.

**Open policy:** when a production workflow should offer or require a paid check,
and how long its observation remains useful. This spike does not impose automatic
checks on profile creation or launch.

## RC-12 — Continuation preserves native boundaries and separates drafts

**Observed 25 October 2026 (064):** Codex 0.164.0 and Claude Code 2.1.310, official
browser SDK 0.3.296 and Python history SDK 0.2.165, passed selected native
resume/fork flows in lab profiles. Resume retained the original conversation ID
and recalled prior context. Fork created a new ID, cut at an earlier supported
boundary, excluded the later continuation-only marker, and preserved source
message content. Codex's boundary was an inclusive turn ID; Claude's was an
assistant-message UUID. Both drafts remained unsent until an explicit Send.
[064 evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/064-history-continuation.md).

**Carry into implementation:** carry provider/profile/conversation/cwd scope in
history references and distinguish native point kinds. A new runtime ID is not a
new conversation ID. Keep native history inspection separate from continuation,
and continuation separate from prompt submission. Persisted baseline and new
live output can share rendering while retaining source identities and measurement
scope. Native history does not depend on a saved live-event capture.

**Regression to retain:** verify source content around a fork, retained versus
new conversation IDs, the selected cutoff and inherited context; preserve the
unsent draft and detect a provider/source mismatch before launch. Reject native
unsupported operations without transcript surgery or automatic replay.

**Scope and open policy:** these checks continued ended histories in the same lab
profile and recorded working directory. They do not qualify active-source forks,
cross-profile/cross-host moves, arbitrary unfinished-tool cutoffs, generic stream
overlap reconciliation or filesystem restoration. Discuss those choices when an
implementation slice needs them. Saved-goal resume effects remain covered by RC-05.

## RC-13 — Claude feed replay can use native multi-client outcomes

**Observed 25 October 2026 (068), Claude Code 2.1.310:** a direct stream-JSON
process served two SDK-free clients through an opaque stdin/stdout relay. With
`--replay-user-messages`, native user echoes preserved prompt UUIDs; native
`command_lifecycle` events exposed queued/started/completed states. Concurrent
prompts from the two clients completed sequentially in the selected case.
A tool-producing turn finished after all clients disconnected. Later clients
received identical replayed stdout and continued receiving live output.
[068 evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/068-claude-feed-replay.md).

A native permission request was visible to both clients. A repeated initialize
request listed it among pending requests. Claude broadcast the accepted allow
`control_response` with its request ID and decision payload; a later conflicting
deny was not echoed and did not override it. The later pending snapshot was empty,
and a fresh replay had no outstanding permission. The output did not identify
which client supplied the accepted response. This qualifies one permission path,
not every hook, custom tool or simultaneous response race.

**Carry into implementation:** the host owns processes, raw input forwarding,
output ordering and replay. Clients correlate native identities, project pending
state and distinguish replay from new live requests. The journal records stdin,
stdout and stderr separately; the attached client feed replays/fans out stdout.
Recorded stdin is not a manufactured acceptance event. In 068 the shared journal
sequence includes other directions, so gaps between stdout sequence numbers are
normal, not evidence of lost output. Journal retention may end with the process;
native history remains the separate continuation source.

Malformed JSON input was forwarded unchanged and caused native exit code 1 with
stderr diagnostics, without a correlated stdout rejection. Clients must report
exit or uncertain outcomes where those are the observations. This does not
authorize adding semantic validation or acceptance arbitration to the server.
The client should serialize its own commands correctly and preserve native errors.

**Regression to retain:** two clients receive the same native echoes/results;
zero clients does not close process stdin; late join receives an ordered prefix
then live tail without replaying actions; split JSON/UTF-8 chunks assemble correctly;
final output precedes the exit marker; resolved permissions do not reappear as
actionable after replay. The spike exercised these with live Haiku, two actual
Chrome contexts and separate subprocess/transport checks. A stalled journal
writer did not block forwarding; memory/backlog remained visible.

**Scope and open policy:** production launchers still use the earlier RC-08
disconnect behavior. The new path has no owner-crash restoration, disk-backed
replay after owner loss, long-session scaling or general callback conflict UX.
Decide missing-feed presentation and unsupported callback behavior when the
production client first exposes them; do not promise universal native idempotency
or a distinct after-turn queue based on this small concurrent-input result.

**SDK reuse follow-up, 26 October (071):** official TypeScript SDK 0.3.296 worked
against the same independent Claude 2.1.310 process with a client-side replay
adapter. Actual browser reload/new Query, Node virtual-process attachment and
reattachment during a pending permission succeeded. Closing SDK connections did
not require ending the process. This qualifies SDK reuse without a server query
or copied SDK implementation; it is not transparent stock-query reconnection.

Naive replay invoked an already-resolved hook callback again. The tested adapter
kept the full raw view but withheld replayed control frames from executable SDK
callbacks; fresh initialization supplied still-pending permissions. A native
accepted response did not abort the other SDK callback automatically. Public
`awaitControlResponse` plus callback write suppression allowed client reconciliation.
WebSocket loss ended the Query, sometimes without an iterator error; the client
must retain transport evidence and create a replacement Query. SDK-hosted hooks
and MCP functions still need explicit JavaScript ownership, and repeated initialize
can re-register hooks. Keep these cases in SDK-upgrade regressions.
[071 evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/071-claude-sdk-replay.md).

## RC-14 — HP history restores context through host-independent storage

**Observed 25 October 2026 (070), research HP runtime, Node 26.10.0, Chrome 155,
OpenAI SDK 7.38.0:** the same archive/restore/fork TypeScript worked with filesystem
and IndexedDB adapters. Actual Luna conversation context, including opaque
compaction output, survived a Node process exit and browser page/Worker reload.
Resume retained conversation ID with a fresh owner. An earlier-checkpoint fork
retained only the earlier fact and preserved the latest source history. No prior
tool call was repeated. [070 evidence](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/070-hp-backend-parity.md).

**Carry into implementation:** keep async opaque-key/byte persistence separate
from codec, history projection and runtime import. Authentication, connections,
tool implementations and dynamic prompt callbacks are host bindings. A write
completion refers to the adapter's commit boundary, not universal power-loss or
browser-eviction durability. Exact fork references identify an owner/sequence
checkpoint; a turn ID alone can name context before or after compaction. Stable
source and response identities survive storage moves, resumed owners and forks.

Read/list/restore stay passive until explicit input. The first prototype rejects
unfinished saved turns for executable restoration and offers completed checkpoints;
the unfinished evidence remains readable. Saved queued mail becomes uncommitted
evidence rather than a new delivery queue. Saved jobs/output remain historical,
not recovered Promises or processes. These are qualified narrow mechanics, not a
complete production recovery policy or a new distributed locking requirement.

**Accounting finding:** both actual archives entered the existing schema v5 writer
and DuckDB. Portable totals, production TypeScript prices and SQL agreed; unchanged
re-imports added no rows/cost. Each final database passed eight selected invariants
and exposed one `responses-without-turn` failure for a real compact response.
The schema permits nullable turn identity, but the invariant assumes all responses
have turns. Correct that assumption before production HP ingestion; do not invent
a turn or discard compaction usage to make the check pass. Production pricing
also needs its pure calculation separated from its Node-only table-refresh import.

**Regression to retain:** same storage contract tests on memory, filesystem and
actual browser storage; reload then passive read and explicit resume; exact fork
cutoff/source preservation; cross-adapter byte identity; failed commit preserves
previous data; no repeated tool/mail delivery; unchanged export deduplication;
parent/child/fork and out-of-turn usage attribution. The live check covered 12
model responses and two compactions, not every tool or interrupted recovery case.

**Scope and needed-by decisions:** before production storage promises, decide
automatic save scheduling, partial/paged reads, multiwriter conflicts and durability
requirements. Before exposing general recovery, decide how unfinished input/jobs
are reconciled. Browser-host survival, cross-tab hosting and crash adoption remain
separate from persistence. Production HP management/RPC/ingestor integration is
still unimplemented; the spike supplies working helpers and measured boundaries.

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
