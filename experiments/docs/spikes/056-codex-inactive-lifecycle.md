# 056 — What “Inactive” means in Codex agents

**Source-qualified for Codex 0.163.0, 19 October 2026.** In the native command
center, **Ready means the conversation's runtime is loaded and idle. Inactive
means it is not loaded in the app-server being queried.** Inactive does not mean
the task succeeded, failed, or was archived. The exact mapping is
[`idle` → Ready, `notLoaded` → Inactive](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/tui/src/app/agents_overview_view.rs#L76).

The app-server automatically unloads an ordinary thread after **30 minutes with
both no subscribed client and no active turn/interactive wait**. The timer starts
from whichever condition became true later. A client resubscribing or work
becoming active prevents that unload. The native setting is
`thread_unload_delay_secs`; the model does not decide to age itself out. Finishing
an answer usually changes Working to Ready first.
[Timer logic](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L59),
[30-minute default](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/config/mod.rs#L4031).

The command center can keep showing an inactive row because its membership is
independent of subscriptions. Listing/reading a task does not keep its runtime
alive. The screenshot's `Updated` ages do not show when unloading happened, and
we cannot identify the exact past cause from the screenshot alone.
[Overview discovery](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/tui/src/app/agents_overview_threads.rs#L1).

| Question | Finding |
| --- | --- |
| Can it unload while an active turn runs? | Normal automatic unload waits. It also rechecks the core running state at the deadline. |
| What if it needs an approval or answer? | Pending approval/user-input flags count as Active and prevent this timer from unloading it. A system error also appears under Needs you, but is non-Active and can eventually unload. |
| What about a background terminal? | **It can still unload.** A terminal left running after a turn is not an activity guard. Shutdown terminates the session's managed terminals. |
| What about subagents? | Each thread has its own state. V2 children have extra guards for active work, durable sleep and trigger-turn mail, plus a separate capacity-based eviction path. |
| What does unloading do? | Stops session resources, flushes persistence, removes the runtime, and emits `notLoaded` / `thread/closed`. This is real teardown. |
| How does it become Ready again? | Opening/resuming creates a runtime from saved history/settings and subscribes the client. Joining before unload reuses the existing runtime. |
| Is that a complete process checkpoint? | No. Persisted conversation history survives; terminated shells and arbitrary in-memory jobs are not resurrected. Untouched/unmaterialized threads need separate qualification. |
| Is archive just another inactive state? | No. Archive explicitly shuts down and hides stored tasks from the usual listing. Unarchive restores visibility without itself loading the agent. |

The background-terminal finding combines inspected 0.163.0
[shutdown code](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/handlers.rs#L290)
with [032's earlier real observation](032-codex-health.md) of an idle thread with a
live terminal. It is not a new live-model terminal-eviction measurement. External
services that detached from session ownership require their own lifecycle policy.

**Subsequent direct check:** [057](057-launcher-inactive-turns.md) reproduced the
managed-terminal shutdown on installed 0.163.0 through our actual launcher. Real
Luna left a heartbeat process running; automatic unload killed its verified OS
process after unsubscribe. It also checks unloaded `turn/start`, explicit resume,
new-turn success and the native timeout override.

**Resuming is not necessarily passive.** After reconstructing/attaching, Codex
invokes idle lifecycle extensions. A persisted active goal can start work; we
[observed that in 029](029-fork-details.md#goal-and-queue-side-effects). Use history
reads for inspection, and do not resume every fleet member simply to obtain
metrics.

For our orchestrator, this argues for showing **runtime loaded/unloaded**,
**turn state**, **archival**, and **observation freshness** separately. An explicit
“resume from history” action should explain that it starts a runtime; “inspect
history” should stay passive. Our own future background-job retention policy
remains a product decision, not an automatic consequence of adopting Codex labels.

Method: trace the exact TUI mapping through app-server subscription/timer code,
status reduction, resource teardown and warm/cold resume; compare the installed
release source with the old research pin; inspect relevant upstream tests and
cross-check earlier live findings. Primary release commit:
`83086188ae0614bd882818ff1aa23f3194962012`. The checkout stays at
`6c372fbef45f730b6d8aa727b0ec8332365588db`; release files were read with `git show`.
No user sessions/configuration were changed. Source tests were read, not run.

**Runtime check:** an isolated, credentialless 0.163.0 server passed **18 assertions**
with a two-second configured delay. The final unsubscribe unloaded after 2,067 ms;
a four-second local shell command continued without subscribers and unloaded
after 6,136 ms total. Warm resume cancelled unloading, another subscriber kept
the runtime alive, cold resume restored saved shell history, and unarchive did
not restart it. No model turn was submitted; estimated provider spend was **$0**.

One useful edge case: a full-history read racing with teardown sometimes reported
“not materialized yet.” The stored history was intact. Waiting for closure and
then reading succeeded; source ordering supports a disappearing live-writer race.
Also, shell-only fixtures with empty previews were omitted from ordinary history
listing despite remaining readable by ID. Both details are preserved in the
report rather than mistaken for history loss.

**Claude/HP boundary:** this does not establish an equivalent automatic expiry
rule in native Claude Code. Our [implemented Claude launcher](../../../docs/claude-handoff.md)
has a different, explicit rule: client disconnect ends that worker, and a later
resume starts a new worker from saved history. The HP runtime's future idle/job
retention policy remains ours to choose. Do not normalize those lifetimes into
a universal “Inactive” behavior.

Official [Codex SessionEnd documentation](https://learn.chatgpt.com/docs/hooks#sessionend)
also describes the idle/unopened 30-minute rule. The exact guards and resource
cleanup above come from the release source; the accelerated two-second probe
does not constitute a 30-minute wall-clock test. Experiment provider spend was
**$0** across all seven attempts; see the [usage ledger](../../spikes/056-codex-inactive-lifecycle/usage-ledger.md).

[Detailed state table, call graph, source anchors and reproduction notes](../../spikes/056-codex-inactive-lifecycle/README.md).
