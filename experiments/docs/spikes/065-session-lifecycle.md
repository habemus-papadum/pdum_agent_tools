# 065 — Session lifecycle and owner boundaries

**25 October 2026 — selected active and owner-lifetime cases qualified.** The
lifecycle study distinguishes interrupting a turn, closing a client, ending a
runtime and losing its owner. Seven no-inference checks exercised real processes
with deliberately invalid credentials; two separate authenticated browser turns
then exercised interruption of actual sleep tools. The
[runbook](../../spikes/065-session-lifecycle/README.md) contains reproduction and
exact evidence pointers.

The important finding is that **a surviving agent process need not have a usable
client endpoint**. After SIGKILL of the isolated Python owner, both Codex native
processes were alive two seconds later. One still accepted initialization on its
native Unix socket, but its public WebSocket relay was gone with the owner.
Claude's worker exited and the official SDK observed connection loss. This is an
observation of the current implementation, not a recovery guarantee or a new
policy to adopt orphan processes.

Graceful behavior was cleaner. Closing a Codex client left its server and loaded
empty thread alive. Closing the Claude SDK query reaped that worker. Explicitly
ending one Codex run left the other controllable. Closing the owner's stdin then
reaped its remaining Codex and Claude processes before the owner exited with code
zero. Seven checks across two scenarios passed. Crash-test survivors were cleaned
up by exact PID/creation-time identity; all recorded children stopped.

The active browser checks showed a further distinction: **interrupting a turn
does not establish that every tool process has stopped**. Each agent launched a
Python process that recorded its PID/start marker, slept for 20 seconds, and would
write a finished marker on normal completion. The user-facing interrupt was sent
after the tool had started, with process identity checked separately.

| Case | Observed interruption | Subsequent lifecycle |
| --- | --- | --- |
| Codex / Luna | Native turn status became `interrupted`; the sleep PID was still alive and its finished marker absent. | Client disconnect left the Codex server alive. Explicit End runtime reaped the tool before it wrote its finished marker. |
| Claude / Haiku | SDK returned `error_during_execution` with `is_error: true`, followed by `command_lifecycle: cancelled` for the submitted prompt UUID. The sleep PID was already gone and its finished marker absent. | The worker remained connected after interruption. Client disconnect moved it to `stopping`; explicit End completed cleanup. |

These are outcomes for the selected managed sleep tools, not universal kill
guarantees. The Claude result was initially displayed as an error by the prototype.
An application should correlate explicit cancellation intent and the native
cancelled UUID while retaining that original SDK error record; an error-shaped
result alone should not erase the fact that the operator requested interruption.

The architecture should retain separate connection, runtime and owner state,
including unknown outcomes and separately observed tool liveness. A shared UI
can present those facts without asserting uniform provider lifetimes. Foreground
ownership and graceful cleanup are a useful
first implementation; crash reconciliation and history-based relaunch can remain
explicit. There is no need to reverse-engineer private Claude recovery internals
to establish these boundaries. RC-01/02/04/07/08 connect this evidence to the
existing runtime-contract ledger.

Versions: Codex 0.164.0, Claude Code 2.1.310, official browser/Node SDK 0.3.296 on macOS
26.6.2 arm64. Final local report:
`experiments/artifacts/065-session-lifecycle/20261025T191957Z-49379/report.json`.
The preceding run had the same outcome. Both remain ignored local evidence. The
no-inference probe still has **zero model inputs and USD 0 inference spend**.

Active browser evidence is in
`experiments/artifacts/064-history-continuation/browser-evidence.json` under
`interruptions`, with process observations in 065's `codex-tool-identity.json`
and `claude-tool-identity.json`. Native captures live under 067 runs
`1d7b682c3615499184d39b142b865a3c` (Codex) and
`c955e900eae0438e866c112cef27094e` (Claude). Both run records are ended. Claude's
interrupted result reports USD 0.00124618; the combined paid continuation and
interruption accounting is in the [064/065 ledger](../../spikes/064-history-continuation/usage-ledger.md).
These are provider-reported/estimated amounts, not measured subscription billing
or implementation-agent costs.

These checks do not qualify escaped background work, every tool's cancellation
behavior, pending-question races, remote hosts, idle expiration or automatic
recovery. The selected live flows and owner-loss evidence are sufficient to inform
the backend/client architecture discussion without turning this disposable study
into a comprehensive lifecycle framework.
