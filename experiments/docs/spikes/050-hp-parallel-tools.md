# Spike 050 — Parallel tools with explicit execution boundaries

## Question and result

Can HP run independent tools concurrently in the same agent turn, preserve Codex's
exclusive-tool behavior, and retain truthful history when execution is interrupted?

**Yes, at the runtime scheduling boundary.** A tool opts in with
`supportsParallel: true`. Consecutive eligible calls overlap; an exclusive call
waits for earlier calls and prevents later eligible calls from overtaking it.
Omitted or false means exclusive. This policy is local to one model step, not a
global lock across agents or a resource-permission system.

Completed items are published as soon as each handler settles. The next model
request receives tool outputs in the model's original call order. A failed tool
becomes its own failure result and does not discard successful siblings.
Steering and agent mail remain pending until the entire batch settles.

Each model request captures its tool schemas, handlers, and parallel flags before
request preparation. Changing the registered tool object later affects a later
step, not a call made against the previously advertised schema. This snapshots
the function reference, not mutable external state that its closure accesses.

## Source alignment and implementation

The inspected Codex checkout is
`6c372fbef45f730b6d8aa727b0ec8332365588db`.
[`core/src/tools/parallel.rs`](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/parallel.rs)
retains the advertising `StepContext`, uses a shared Tokio lock for parallel
handlers and an exclusive lock for others, and distinguishes handler execution
from waiting for admission. HP now follows those responsibilities through:

- [`tools/parallel.ts`](../../spikes/039-hp-agent-runtime/src/tools/parallel.ts):
  per-step snapshot and cancellable FIFO shared/exclusive admission.
- [`tools/execute.ts`](../../spikes/039-hp-agent-runtime/src/tools/execute.ts):
  handler execution, completion notifications, ordered output collection, and
  cancellation repairs.
- [`session/turn.ts`](../../spikes/039-hp-agent-runtime/src/session/turn.ts):
  captures the advertised tool set and supplies it to the batch.

These files import no Node or browser APIs specific to either host. Async
handlers overlap in one JavaScript event loop; CPU-intensive work still needs a
Worker or another execution host to avoid blocking that loop.

## Interruption evidence

Nine deterministic scenarios execute the actual `AgentRuntime` with scripted
model events. These are scheduler and failure-injection checks, not evidence that
a provider will select particular calls. They cover:

1. Overlapping handlers, immediate completion notifications, and ordered context.
2. A fair exclusive barrier between two parallel groups.
3. Synchronous failure, successful custom-tool output, and unknown-tool failure.
4. Interruption with one running, one completed, and two queued calls.
5. Interruption between item-start notification and actual callback invocation.
6. Schema/handler/parallel-policy mutation after the step snapshot.
7. Steering during the batch without bypassing its remaining work.
8. Removal of a cancelled admission without stealing another handler's lease.
9. A late handler rejection without an unhandled Promise or overwritten output.

On interruption, completed siblings retain their actual outputs. Calls that
never entered their callbacks receive `NOT EXECUTED`; already running callbacks
receive `INTERRUPTED / OUTCOME UNKNOWN`. Every call gets one output in call order.
A noncooperative callback's later result is journaled separately and cannot
modify the interrupted turn or a subsequent turn's model context.

JavaScript cannot forcibly stop an arbitrary Promise or undo its side effects.
Such a callback can continue after interruption, including alongside a later
turn. Exclusive admission is therefore not a guarantee that an ignored
cancellation has stopped external work. Tools needing independently managed
lifetimes should use the explicit background-job mechanism, and CPU-bound tools
need an execution host capable of termination.

## Reproduction and validation

Run from `experiments/` after the normal workspace install:

```sh
pnpm --filter @agent-spike/050-hp-parallel-tools test
pnpm --filter @agent-spike/050-hp-parallel-tools typecheck
pnpm --filter @agent-spike/050-hp-parallel-tools build
uv run --frozen python -m http.server 8050 --directory spikes/050-hp-parallel-tools/dist
```

Open `http://localhost:8050` and select **Run checks**, or call
`window.runHPParallel()` in the browser. The Worker runs the identical scenario
module used by Node.

Observed on 2026-10-18 with Node 26.10.0: nine Node scenarios passed, TypeScript
checking passed, and the browser Worker bundle built. The 35 existing tests in
spikes 039, 047 and 049 also passed. A browser build alone is not browser execution
evidence; the coordinating integration run records the real Chrome result and
any bounded live provider qualification separately.
The completed [052 integration run](052-hp-work-integration.md) passed all nine
cases in real Chrome and model-selected parallel calls in both Node and Chrome.

No provider calls were made by these fixtures, so their provider cost is **$0**.
This excludes assistant development usage, which is not available to the spike.

## Remaining boundaries

HP still collects the completed model response before dispatching its selected
tools. Native Codex can begin tool work while later response events stream in.
No per-resource conflict scheduler, configurable concurrency limit, or automatic
parallel classification is added. Existing tools remain exclusive until their
adapters deliberately opt in. The direct provider request itself must also
permit multiple tool calls; this scheduler does not change provider selection.
