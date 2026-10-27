# Native continuation and owner observations

**25 October 2026.** These are disposable backend extensions to 067, supporting
the closing 064/065 studies. They compose the existing launcher and public native
history operations. No production package or persisted provider schema changed.

## API and ownership

| Route, beneath `/__session-lab` | Operation and limits |
| --- | --- |
| `GET /history?provider=codex\|claude` | Native catalogue within this lab's profiles. Claude covers the base workspace plus directories recorded by this lab's runs; it is not global machine discovery. |
| `GET /history/{provider}/{sessionId}?cwd=…` | Fresh native read and selectable branch boundaries. Returns `{reference, document, branchPoints}`. Does not resume, fork or issue a model input. |
| `POST /sessions` with `continuation` | Explicit resume/fork intent. The source profile and recorded working directory stay fixed. Nothing submits the draft. |
| `GET /sessions` and `GET /sessions/{id}/status` | Current-owner observations: actual Codex PID identity/liveness or current Claude worker state. This is separate from the run's `ready`/`ended` owner record. |
| `POST /sessions/{id}/end` | Stops a current-owned runtime. A prior-owner record is refused; no old handle is adopted. |
| `POST /sessions/end-all` | Enumerates current unended owned run IDs, then returns `targetIds`, successful `results` and explicit `failures`. It neither stops another owner nor establishes a future-launch prohibition. |

`HistoryRef.updatedAt` is an ISO timestamp normalized from the known native unit;
the original record, including its numeric fields, stays under `native`.
Codex's catalogue is the native default unarchived listing. Empty/unmaterialized
sessions and async native catalogue discovery retain their existing limitations.

Codex catalogue/history reads may launch a temporary owned app-server inside the
same lab profile. The reader's allowlist contains only initialize/list/read/page
methods; cleanup closes that helper. Its returned runtime status is local to that
reader, not a machine-wide liveness assertion. No implicit resume repairs a failed
read (RC-03/05/09).

Claude catalogue/info/messages/fork call the existing `History` adapter, which
uses public Python SDK helpers in a fixed profile/workspace environment. It does
not parse or rewrite native recovery files. Debug captures are not the history
source. Old lab run metadata supplies scope and ownership observations only.

## Continuation semantics

The request is `{kind: "resume" | "fork", sourceSessionId, pointId?, pointKind?}`.
Resume uses the latest saved context and rejects a supplied point. A fork can
select a listed point or omit it for a full/latest native fork. Point kinds are
provider-specific: Codex `turn` versus Claude `message`. Unknown IDs, mismatched
kinds and changed working directories are rejected before allocating a runtime.

For Codex, the backend returns a new owned server plus the continuation descriptor.
The browser performs native `thread/resume` or `thread/fork` and registers the
resulting native identity. It can then read a baseline before any explicit Send.
Listed branch points are ended native turns (`completed`, `interrupted`, `failed`).
The native `lastTurnId` boundary is inclusive.

For Claude, the backend uses `History.fork(up_to_message_id=…)` when requested,
then allocates a worker with `resume=chosenSessionId`; the official browser SDK
still owns its one live query. The selector exposes assistant-message boundaries
without a tool-use block, avoiding an unresolved tool-call cut in this first
study. Other SDK-supported cut points remain a future qualification. A successful
fork changes the conversation identity and preserves source content; it does not
copy or rewind the working directory (RC-09/10).

The explicit operation is not automatically retried if transport fails. A fork
could have been persisted before the caller lost its result, and resume can have
native side effects such as activating a saved goal (RC-05/07). The selected
qualification conversations have no saved active goal.

## Prior-owner records

Each new run records `ownerId` and `ownerPid`. On a later service instance, old
`run.json` rows are surfaced with `owned: false`. A recorded successful end remains
an ended observation; an otherwise unfinished row becomes `state: unknown` with
its `lastRecordedState` retained. No PID is signalled and no socket/pipe handle is
recovered from that record. Native history remains separately readable.

Current Codex runtime observations report `state`, `pid`, `processAlive`,
`observedAt` and their identity-check basis. Claude reports its manager's worker
`state`, `pid`, `exitCode`, `reason` and observation time. An allocated/waiting
worker need not have a PID. Runtime readiness, turn completion and saved history
are distinct (RC-01/07/08).

## Focused qualification

From the repository root:

```sh
.venv/bin/python experiments/spikes/064-history-continuation/backend_check.py
.venv/bin/python experiments/spikes/067-live-session-workspace/backend_check.py
```

The 064 check passed **eight real no-inference checks** over isolated copies of
the selected 067 Codex and Claude histories: native catalogue/read/branch identities
for both; actual native fork and unchanged source content for both; rejecting
resume-with-point for both; prior-owner refusal; and excluding prior owners from
end-all while preserving original source files. It uses intentionally invalid
credentials and never sends a model input. The original 067 eight checks still
pass, including native PID cleanup and close-during-startup ownership.

Codex test preparation copies only selected rollouts and SQLite-backed native item
projection. It lets Codex rebuild its catalogue so copied catalogue rows cannot
retain original rollout paths. Claude test preparation copies selected native
session files into the test profile, then uses official helpers. Raw source and
test artifacts remain local; these are not committed transcript fixtures.

The parent task owns paid continuation/interruption checks, actual browser results
and costs. A no-model fork/read result does not establish successful model access
or that every older history format can be resumed. The independent 065 lifecycle
probe owns graceful/abrupt parent-death observations; this backend introduces no
new survival or automatic-recovery guarantee.
