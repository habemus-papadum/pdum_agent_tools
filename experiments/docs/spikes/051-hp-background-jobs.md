# 051 — Background jobs beyond terminal processes

**Observed 18 October 2026:** HP now has a portable background-job registry for
ordinary async JavaScript work, with shell execution attached to the same
ownership and event contract. Jobs have stable IDs, owner/thread/turn provenance,
structured progress and output, optional structured input, and an append-only
history. Ten lifecycle cases pass in Node; the same cases have a browser Worker
harness. The integration round reports actual browser execution separately.
The completed [052 run](052-hp-work-integration.md) passed the ten cases in real
Chrome and model-selected background work in Node and Chrome.

The most important change is that **interrupting an agent turn or cancelling a
wait no longer kills its background process**. HP now follows the inspected
Codex unified-exec lifetime: a process remains discoverable even when the first
caller disappears before receiving its session ID. Explicit job cancellation,
process termination and owner cleanup are separate operations. The real-process
suite also confirms that final output drains, another owner's process survives,
and cleanup reaches a TERM-ignoring descendant.

Cancellation is described honestly. A callback that cooperates with its signal
can settle as cancelled. An uncooperative callback remains visibly cancelling
until it actually finishes; a later result or independent failure is retained.
Cancelling one observer's wait leaves other observers and the job untouched.
Admission is recorded separately from callback execution, so work cancelled
before it begins is not presented as having run.

The registry contains no Node, browser or Solid branches. Node's subprocess
adapter supplies host-specific execution; the browser can supply an async
function, Worker or future cell adapter. Runtime destruction still ends the
in-memory registry. This is not durable scheduling, process recovery, PTY
support or an implemented AIUI cell integration.

**Validation:** ten portable Node checks and twenty-four existing/extended
Node-tool checks passed, along with typechecks and the browser build. Node
26.10.0, pnpm 11.9.0, macOS; inspected Codex source
`6c372fbef45f730b6d8aa727b0ec8332365588db`. Provider spend for this track was
**USD 0**; development-agent cost is unavailable.

The [runbook and detailed contract](../../spikes/051-hp-background-jobs/README.md)
include commands, tested edge cases, exact API boundaries and remaining limits.
