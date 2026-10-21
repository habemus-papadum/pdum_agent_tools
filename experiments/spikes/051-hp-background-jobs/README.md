# Background work with an independent lifetime

Can a shell process and an ordinary async JavaScript calculation share execution
ownership, inspection and cancellation, while remaining independent of a model
turn and the client waiting for the result? **Yes, for the tested in-memory
contract.** The same framework-free registry runs in Node and a browser Worker.
Shell processes use that registry rather than a separate cancellation lifetime.

This is research code under 039 and 042, not a new production package. The portable
registry is [039/src/jobs/registry.ts](../039-hp-agent-runtime/src/jobs/registry.ts).
The real subprocess adapter remains
[042/src/exec.ts](../042-hp-tools-skills/src/exec.ts).

## Run the checks

From `experiments/`:

```sh
pnpm --filter @agent-spike/051-hp-background-jobs test
pnpm --filter @agent-spike/051-hp-background-jobs typecheck
pnpm --filter @agent-spike/051-hp-background-jobs build
pnpm --filter @agent-spike/042-hp-tools-skills test
pnpm --filter @agent-spike/042-hp-tools-skills typecheck
```

Serve `spikes/051-hp-background-jobs/dist/` over localhost and open `index.html`
to run the **same ten scenarios** inside a real browser Worker. The page exposes
`window.hpJobResults`; bundling alone is not browser evidence. The integration
round records the browser and agent-protocol checks separately in 052.

Observed locally on 18 October 2026: ten portable job checks passed in Node,
the twenty-four 042 tests passed with real processes, both typechecks passed, and
the Worker bundle built. Node was 26.10.0 and pnpm 11.9.0 on macOS. This track made
no provider requests: experiment provider spend was **USD 0**. Development-agent
cost is not exposed here and is not included in that figure.

## Execution contract

`JobRegistry.start({ownerId, threadId?, turnId?, name?, acceptsInput?, run})`
returns an identity and an initial snapshot. `accepted` records admission;
`started` records entry into the callback. `executionStarted` distinguishes these
even if cancellation occurs before the callback can run. The callback receives
an independent AbortSignal plus `output(value)`, `progress(value)` and optional
FIFO `nextInput()`. No browser, Node, Solid or provider import exists in this core.

| Operation or outcome | Meaning |
| --- | --- |
| `inspect`, `list`, `events` | Copies of snapshots and globally sequenced append-only events; owner/thread/turn provenance remains attached. |
| `send` | Queue structured input only for jobs that advertise it. It does not restart settled work. |
| `wait` | Wait for settlement, optionally with a caller signal or timeout. Neither interrupts the job. |
| `cancel` | Request cancellation and transition to `cancelling`; this is not evidence of termination. |
| `cancelled` | The callback rejected with its own cancellation signal's reason, or cancellation prevented it from beginning. |
| `completed` after cancellation | An uncooperative callback actually returned; result and late output remain visible with cancellation metadata. |
| `failed` after cancellation | A distinct failure remains a failure, rather than being relabelled as successful cancellation. |
| `closeOwner` or registry `close` | Prevent admission for that owner/scope and request cancellation. Return without pretending uncooperative JavaScript has stopped. |

There is no execution timeout, default job quota, output truncation or event
retention cap. Callers may bound individual waits. Completed jobs stay available
for inspection in memory. Storage across runtime/page destruction is absent.

Observers run asynchronously and are never awaited by execution. Synchronous and
asynchronous listener failures become journal entries; they are not recursively
rebroadcast. Repeated timed-out/aborted waits remove their completion listeners,
so polling a long-lived job does not accumulate stale waiters. Job events preserve
each submitted progress/output record; a future reactive view may coalesce its
display without erasing that history. Values must be structured-cloneable; a
JSON transport also requires JSON-serializable values at its own boundary.

## Shell alignment

Native Codex explicitly persists unified-exec sessions before the initial wait,
so interrupting a turn cannot drop the final process reference. This is the
contract inspected in `core/src/unified_exec/process_manager.rs` at source revision
`6c372fbef45f730b6d8aa727b0ec8332365588db`, around its “Persist live sessions” comment.
It is distinct from the app-server's raw command-pipe interface. See the
[046 audit](../046-hp-power-user-audit/feature-matrix.md).

HP now preserves a yielded process after the originating turn signal is aborted.
Cancelling the initial collection or a later `write_stdin` poll also preserves
the process and unconsumed output. If the initial call never returned its session
ID, `sessions()` still exposes it, its PID and corresponding generic `job_id`.
Aborting a backpressured write stops that caller's wait; it cannot retract bytes
already accepted by the operating system.

`createNodeTools({cwd, jobs?, ownerId?})` retains its `Tool[]` API and additionally
exposes `jobs`, `ownerId` and `terminate(sessionId)`. The tool callback adds thread
and turn provenance. An injected registry can be shared with the runtime, making
shell output and settlement inspectable alongside ordinary async tasks. Shell
stdin remains the existing `write_stdin` operation; shell jobs do not advertise
the generic structured-input capability.

`terminate` and tool-owner `close()` signal only groups spawned by this executor.
Cleanup escalates TERM to KILL for uncooperative descendants. A process leader's
exit does not itself retire an owned group. The adapter waits for stream close,
records final stdout/stderr with their channel names, and preserves that output
in job events even if no caller remains to collect a final response. Generic
registry cancellation connects to this cleanup. A cancelled shell job settles
only after cleanup and stream draining. Closing the tools cancels their own
shell jobs, not every job in a shared registry.

The Node tests exercise independent owners, a TERM handler's final output, a
TERM-ignoring descendant, interruption before the first result, later polling,
stdin backpressure, immediate owner close, Unicode and startup failure. Existing
patch, skill and local MCP checks still pass. No mocked provider response is used
as evidence for process behavior.

## Boundaries left for later work

- A JavaScript promise cannot be forcibly stopped by an AbortSignal. A task that
  blocks its event loop also delays cancellation delivery. A Worker adapter can
  add worker termination, but this registry does not claim to do so.
- Jobs survive turn interruption, not browser closure or runtime destruction.
  There is no persistent scheduler or process reattachment.
- Pipe mode remains explicit. `tty:true` is unsupported and `\u0003` written to
  a pipe is ordinary input, not a PTY interrupt. POSIX process-group cleanup is
  tested on macOS; Windows descendant cleanup is not qualified.
- Multiple collectors share the shell's pending-output buffer: one collection
  consumes a chunk. Generic job history remains independently replayable. No
  terminal fan-out or remote-PTY protocol is claimed.
- AIUI cell generation identity, supersession, shared cancellation ownership and
  adapters remain design work. The new contract does not require the young AIUI
  library to remain unchanged; pragmatic upstream improvements are allowed.

Agent notification and RPC integration belongs to the runtime/protocol boundary,
not to this generic registry. Completion can queue an attributed message without
automatically creating a new model turn. Progress should not itself trigger
model calls.
