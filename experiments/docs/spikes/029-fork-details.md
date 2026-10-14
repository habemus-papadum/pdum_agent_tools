# 029 inheritance, lifecycle and accounting

## What the run actually did

The runner continued the paginated 027 corpus. It cold-resumed its parent, tried
warm permission overrides, forked full/before/through/ephemeral variants and sent
distinct tiny `PARENT_ONLY` and `FORK_ONLY` prompts. It then forked during a real
one-second local command appending `ACTIVE_PARENT_ONLY` to a disposable file,
reverted that command's turn, compacted the completed fork, inserted one queued
message, and tested deferred and cold-resumed goals. Captures record every attempt,
including expected protocol errors and automatic work.

| Property | Full fork observation | Boundary / active differences |
| --- | --- | --- |
| Thread/session identity | Fresh thread ID and matching session ID | Same fresh identity rule |
| Fork ancestry | `forkedFromId` source; `parentThreadId:null` | Not a spawned child |
| Turn/item IDs | Original prefix IDs retained | Before excludes boundary, through includes it |
| Name | Source name inherited | No separate naming test on every variant |
| Project/attachments | No non-null project in this corpus; attachment inheritance untested | Do not infer from name inheritance |
| Cwd | Same filesystem directory, sometimes canonicalized | No clone; override supported separately in 026 |
| Model/effort/provider | Luna / low / openai retained | No mixed-model provider claim |
| Sandbox/approval | Full access / never retained | Warm resume did not apply requested overrides |
| Command/file history | Completed prefix retained | In-progress local turn became interrupted with empty items |
| Active processes | No command duplication | Parent append occurred once; fork did not rerun it |
| Usage | Inherited cumulative snapshot emitted | New thread ID with original historical turn ID |
| Goals | Deferred fork inherited active goal snapshot | No initial continuation in 750 ms observation window |
| Queue | Added input on idle parent was consumed immediately | Fork queue empty after the source had already consumed it; not proof unconsumed queues never inherit |

The parent and fork each retained original history and their own distinct second
answer; neither received the other's continuation. The active fork was taken after
turn/start but before the local command completed. Its copied active turn remained
interrupted even after the source finished. File contents were exactly one marker
after fork and unchanged after revert. This is concrete local filesystem evidence;
external service side effects were not triggered.

Cold resume restored saved effective settings. Sending read-only/on-request while
the thread was already loaded returned full-access/never; the subsequent warm
restore request returned the same. Clients should inspect responses and use the
appropriate settings mutation path rather than assume resume overrides apply to
running threads. No assertion is made that every setting is ignored on every version.

## Compaction and money

The inherited full fork emitted total input 30,911 / cached 28,928 / output 94 under
its **new thread ID** but the **original turn ID**, immediately following fork.
Resume emitted the same counters repeatedly. These are historical restatements,
not additional completed provider responses. Counting per-thread lifetime totals
across a fork double-counts the prefix unless provenance/baselines are retained.

New response increments, 2026-10-14 Luna rates from [official model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna):

| Response | Input | Cached subset | Output | API-equivalent estimate |
| --- | ---: | ---: | ---: | ---: |
| Parent continuation | 10,397 | 9,984 | 7 | $0.00014464 |
| Fork continuation | 10,569 | 8,960 | 7 | $0.00025400 |
| Automatically consumed queue | 10,347 | 8,960 | 8 | $0.00023230 |

The arithmetic total is **$0.00063094**. Cache-write and reasoning counters were
zero. Billing coverage excludes unobserved provider-side activity. The runner's
`usage.json` preserves every snapshot, including restored duplicates.

Manual compaction emitted a contextCompaction item and completed turn. The history
kept the prior visible transcript and appended that marker. Cumulative counters
stayed input 41,480 / cached 37,888 / output 101; `last` changed to totalTokens 6,026
with input/cached/output all zero. This is a context recomputation signal, not
evidence of a free or paid provider response. No upstream traffic capture was made
for this compaction, so billable compaction usage is unresolved. The interrupted
automatic goal similarly has no completed usage increment and cannot be called
zero-cost with certainty.

## Goal and queue side effects

Setting an active goal on an unloaded materialized parent stored the objective
without loading it. A fork with `deferGoalContinuation:true` copied the active goal,
budget 64 and zero used counters. It remained idle for the 750 ms probe window;
then the probe explicitly paused it. The subsequent cold parent resume started a
turn automatically. The probe paused the goal and interrupted that turn as soon as
its start was observed, then cleared the parent goal. A paused inherited goal remains
in the disposable fork; no runtime was left running.

Queue insertion returned a submission ID, but the very next queue list was empty
because idle-thread execution had started. Text saying “do not execute until
explicitly started” is model input, not a protocol deferral control. The queue
test therefore established immediate execution; it did not establish persistence
of an unconsumed queue across restart. The runner and ledger now describe the
queued submission as potentially paid work.

Source-inspected anchors at clean pin: [fork boundary and incompatible options](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_processor.rs#L5084),
[deferred goal inheritance](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_processor.rs#L5543),
[restored usage after fork](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_processor.rs#L5683),
[active-goal runtime effects](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_goal_processor.rs#L133).
Source explains the mechanisms; installed runtime results above stand independently.
