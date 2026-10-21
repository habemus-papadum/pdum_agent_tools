# HP Agent: parallel tools, background work and AIUI

**Completed 18 October 2026.** The experimental HP runtime now runs eligible
tools concurrently and manages background work independently of the turn that
started it. Ordinary async JavaScript calculations and Node shell processes
share a job registry. The portable implementation runs unchanged in Node and a
browser Worker; this remains research code, not a new production library.

The next integration should use that foundation to connect AIUI calculations to
agents. The [AIUI integration contract](specs/hp-aiui-integration.md) treats the
young upstream library as changeable: improve calculation identity and lifecycle
evidence upstream, with tests and modest demo migrations, instead of building
layers of workarounds in HP. The cell adapter and its visualization remain deferred.

## What now works

| Capability | Result |
| --- | --- |
| Parallel tools | A tool explicitly declares that it can overlap other eligible tools. Exclusive tools wait their turn and prevent later calls overtaking them. Each result retains its original call identity and order in model input. |
| Background JavaScript | An application starts a job and receives its ID immediately. The job can emit progress/output, accept structured input, and finish after the initiating agent turn. |
| Shell lifetimes | Interrupting the turn, cancelling a poll, or abandoning the initial wait preserves the process and its captured output. Explicit termination and tool-owner cleanup stop the owned process group. |
| Independent observation | Two clients can inspect and wait for the same job. Cancelling one wait or gracefully detaching that client leaves the job and the other client running. |
| Completion delivery | Completion queues a notice for the originating agent. An idle agent stays idle; the application or user explicitly starts further work. Progress does not trigger model calls. |
| Historical inspection | Completed jobs, results and sequenced output remain readable without invoking a model. This history is in memory; it does not restore executions after a page or process closes. |

This separates four actions that previously risked sharing one abort signal:
interrupt the agent turn, stop waiting for a result, cancel the underlying work,
and close the owner of that work. A fork copies conversation state without
duplicating running jobs.

The runtime also has explicit disposal. It interrupts its turns, requests
cancellation of jobs it owns, and releases its subscription to a shared job
registry. A separately owned shell adapter still needs its own `close()` call.
Graceful client closure sends a detach notification; abrupt transport loss needs
the host to invoke the connection's cleanup callback.

## What the real model did

The same application test ran under Node and inside Chrome:

1. Luna selected two independent application reads in one response. Their
   executions overlapped, and it correctly added **19 + 22 = 41**.
2. Luna started an async job, received its ID, and finished its turn while the
   job was still running. The host then supplied structured input with a result
   of **73**. Completion did not restart the model. On a later explicit turn,
   Luna inspected the retained job and returned **73**.

Each environment used six real responses. The browser's agent loop, scheduler
and job registry ran inside its Worker; the development host only supplied the
credentialed upstream connection. The test uses async application work, not
CPU-intensive computation or an AIUI cell. Its host deliberately supplies the
job input; the model selects the tools.

## Important limits and design consequences

**Cancellation is a request, not proof of termination.** A JavaScript callback
that ignores cancellation remains visibly cancelling until it actually settles.
If it later succeeds or fails, that outcome is retained. Work cancelled before
its callback starts has an admission record but no execution-start record.
Interrupted tool results separately distinguish work that never ran from work
whose effects are uncertain.

**Parallelism is explicit and scoped to a model step.** Existing tools remain
exclusive unless their adapter opts in. The scheduler does not infer safety from
a read/write label or coordinate arbitrary shared resources across agents.
HP still waits for the model's complete response before dispatching its tools;
native Codex can begin dispatch while later response events are streaming.
Steering queued during tools is applied after the whole batch settles.

**Reactive calculations need an additional identity.** An AIUI cell represents
a calculation rule, while a job represents a particular request. If dataset B
supersedes a calculation for dataset A, A must report supersession rather than
return B's result. The contract proposes public calculation identity and
lifecycle evidence upstream. Displayed progress and last-good values must not
be mistaken for a complete execution history or the requested result.

**The mode engine fits standing settings, not every task queue.** Its resource
claims reconcile to the newest desired state. Separate submitted tasks usually
both need execution. Keep that distinction while sharing the framework-free
primitives where appropriate. The source review also corrected an outdated skill
reference: AIUI's old Solid mode-engine adapter was retired; its core remains.

Still outside this round: actual AIUI cell integration, Worker CPU execution
adapters, persistent job recovery, remote terminal fan-out, PTYs/Ctrl-C semantics,
user submission queues, and human/MCP request arbitration. Native process cleanup
was qualified on macOS; Windows descendant cleanup was not.

## Evidence and where to read next

| Report | Detail |
| --- | --- |
| [050: parallel tools](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/050-hp-parallel-tools.md) | Source alignment, fair scheduling, per-step tool snapshots, ordered results and interrupted-call repairs. |
| [051: background jobs](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/051-hp-background-jobs.md) | Job lifecycle, independent waits, structured input, real subprocess ownership and final-output draining. |
| [052: integration and live checks](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/052-hp-work-integration.md) | Multiple clients, runtime disposal, real browser execution, live provider results and the usage ledger. |
| [AIUI integration contract](specs/hp-aiui-integration.md) | Responsibility boundaries, concrete upstream changes and the later cell/demo qualification plan. |

The combined relevant Node run passed **90 tests**. Chrome passed the same
**23 portable scenarios**: nine scheduling cases, ten job cases, and four
runtime/client integration scenarios. These local tests include scripted model
events and real MessagePorts; the twelve live responses are separate provider
evidence. Relevant typechecks, browser builds and strict documentation checks
also passed. The Codex source reference remains
`6c372fbef45f730b6d8aa727b0ec8332365588db`.

Observed experiment usage is estimated at **USD 0.001098935**: Node
USD 0.000771220 plus browser USD 0.000327715. All twelve observed responses had
usage records. This uses the dated Luna rates in the detailed ledger; actual
billing and the assistants' implementation costs are unavailable. Local tests
and source inspection made no provider calls.

The follow-up discussion clarified that agents change published controls and
observe resulting application values; they do not schedule cells directly.
Before implementing an adapter, use one slow application example to decide
readbacks, completion, intervening changes and cancellation. The
[recorded clarification](specs/hp-aiui-integration.md#discussion-clarification-change-controls-observe-consequences)
keeps this as design work while the portable client/runtime foundation continues.
Measure demo migration scope before expanding the integration. No commit, push,
package publication or upstream AIUI edit was performed in this round.
