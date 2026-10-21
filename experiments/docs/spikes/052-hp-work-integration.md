# 052 — Parallel work across Node, browser and clients

**Observed 18 October 2026:** the common HP runtime and job registry work in Node
and Chrome Workers. Four integration scenarios prove that a job outlives an
interrupted turn, completion remains queued for an idle agent, forks do not clone
execution, clients can cancel/detach their own waits independently, and runtime
disposal releases observation without closing another owner's jobs. Disposal
also suppresses a follow-up already scheduled beyond the answer boundary.

Two live scenarios passed in each environment. Luna selected two application
read tools in one response; their execution overlapped and it returned **41**.
It then started a job, finished the initiating turn, and on a later explicit
turn inspected the completed result **73**. The host supplied the job's structured
input after the initial turn ended. No automatic completion-triggered model turn
occurred. This is async JavaScript work, not yet an AIUI cell or CPU Worker adapter.

The public experimental RPC extensions include `hp/job/list`, `read`, `events`,
`send`, `wait`, `cancelWait` and `cancel`. A wait ID belongs to its connection;
cancelling it leaves the producer and other waiters untouched. Graceful client
close sends `hp/client/detach`; abrupt transport loss still needs host cleanup.
Job completion queues a correlated notice, not the entire output stream. A host
tool can inspect results when the model needs them.

The final relevant Node run passed **90 tests** across 039, 042 and 047–052.
Chrome passed **23 shared scenarios** (nine parallel, ten jobs, four integration).
Those fixture-based control checks and real local process/MessagePort checks are
distinct from the **twelve live Luna responses**. Typechecks and browser builds
passed. Node 26.10.0, Chrome 155, pnpm 11.9.0, OpenAI 7.38.0;
Codex reference `6c372fbef45f730b6d8aa727b0ec8332365588db`.

Estimated reported provider usage: **USD 0.001098935**, with all observed
responses represented. Actual billing and implementation-assistant costs are
unavailable. Raw histories and wire captures stay under ignored `artifacts/`.
See the [runbook, protocol details and usage ledger](../../spikes/052-hp-work-integration/README.md)
and the [overall findings](../../../docs/hp-agent-work.md).

The [AIUI integration contract](../../../docs/specs/hp-aiui-integration.md)
defines later cell/generation correlation and pragmatic upstream changes. AIUI
was inspected, not modified; no new production package was created.
