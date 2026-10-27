# Session lifecycle and owner boundaries

**25 October 2026 — selected active and owner-lifetime cases qualified.** This is
the focused 065 lifecycle study alongside 064 continuation and the working 067 UI.
It measures existing owners rather than selecting a new production survival policy.

The seven no-inference owner checks below and the two authenticated browser
interruption cases are separate evidence sets. The no-inference probe never sends
a prompt; paid active checks were coordinated by the main integration run.

## What was measured

| Action | Codex | Claude through our launcher |
| --- | --- | --- |
| Interrupt a live sleep-tool turn | Turn reports `interrupted`; the managed sleep PID remains alive. | Error-shaped SDK result plus a matching `command_lifecycle: cancelled`; the selected sleep PID is already gone. |
| Close one client connection | Native app-server remains alive. The new empty thread was still loaded in the immediate observation. | Closing the official SDK query ends and reaps its native worker. |
| End one owned run | That native PID exits; another Codex run remains controllable. | Individual worker stop remains manager-scoped. |
| Graceful owner stdin EOF | Remaining native processes are reaped before owner exit. | Remaining worker is reaped before owner exit. |
| SIGKILL the isolated Python owner | Both native Codex PIDs survived the two-second observation. One native Unix socket still accepted initialization; the public relay endpoint was gone. | Native worker exited; the SDK observed a connection error. |

The owner is the actual 067 Python service, launched as an isolated child of this
probe. Its profile directories and source credential files are new local test
artifacts. Credentials are deliberately invalid, so initialization/control is
real but authenticated inference is not being claimed. There is no prompt API in
the Node helper, and the Python RPC helper refuses every `turn/*` operation.

Seven checks passed across the graceful and abrupt scenarios. The final run
explicitly checks the loaded thread identity after Codex disconnect and the
surviving run's identity after ending its peer. The SDK recorded no assistant or
model-result frames. All recorded child processes were stopped after the probe;
the crash scenario needed explicit SIGTERM cleanup of its two surviving Codex
processes, using PID **and process creation time**. No process is selected by
executable name or port.

## Selected active interruption cases

Each provider launched a real Python process that wrote a start marker and PID,
slept for 20 seconds, then would write a finished marker. The browser sent an
interrupt after the start marker appeared. Process PID and creation time were
checked independently of the conversation status.

- **Codex:** run `1d7b682c3615499184d39b142b865a3c`, sleep PID 54959. Native
  `turn/completed` carried status `interrupted`, while the sleep process was still
  alive and its finished marker absent. Disconnect left server PID 54792 alive.
  End runtime reaped the sleep process before normal completion; the finished
  marker stayed absent.
- **Claude:** run `c955e900eae0438e866c112cef27094e`, sleep PID 55574. The official
  SDK returned `error_during_execution`, `is_error: true`, and a later cancelled
  command-lifecycle record with the same UUID as the submitted prompt. The sleep
  process was already gone before its finished marker. The worker was still
  connected; disconnect moved it to `stopping`, and End completed cleanup.

The native terminal/cancellation events arrived roughly six seconds after each
local tool PID was created, well before its requested 20-second sleep. That is a
same-host receipt/PID timing comparison, not a provider-reported execution duration.
It helps rule out treating ordinary sleep completion as the cancellation result.

An intentional cancellation may arrive in an error-shaped SDK result. The UI
should correlate user intent and the native command UUID, preserve the original
result in inspection, and keep tool liveness separate. It should not assume all
tools behave like this selected Python sleep, or that an interrupt means every
background job stopped.

Evidence: `experiments/artifacts/064-history-continuation/browser-evidence.json`,
065's `codex-tool-identity.json` / `claude-tool-identity.json`, and the corresponding
067 `runs/<id>/live.json`, `history.json` and `run.json`. The browser evidence's
initial Claude notice describes the earlier generic error display; the native
cancelled record is retained for the subsequent intent-aware UI refinement.

## Why this matters for architecture

- Connection state, native process liveness, owning service liveness and task
  completion need separate fields. An empty initialized runtime is not a
  completed task, and a completed interruption is not universal tool termination
  (RC-01/04).
- Native process survival is insufficient for a usable client endpoint. The
  Codex relay lived in the killed owner even though Codex itself survived. Moving
  the endpoint URL into another object does not make it independently hosted.
- Graceful cleanup is a useful initial policy supported by the existing libraries.
  Abrupt-loss recovery should reconcile recorded identities and expose uncertainty.
  It should not pretend to recover asyncio pipes or blindly replay a prompt (RC-07).
- Keep provider-specific disconnect semantics (RC-08). Codex idle retention and
  background-job lifetime remain native concerns (RC-02/04); a two-second empty
  runtime observation does not qualify long-running work survival.

The native Unix initialization after SIGKILL is an explicit test affordance. It
does not implement reconnection, re-adoption or recovery for the application.

## Reproduce

From the repository root, using the existing root Python environment and installed
`examples/claude-client` Node dependencies:

```sh
.venv/bin/python experiments/spikes/065-session-lifecycle/probe.py
```

The helper imports the official Node Agent SDK through that example's package
installation and reuses its public `SpawnedProcess` WebSocket adapter. It creates
one isolated backend for each scenario, uses dynamic ports, and writes reports
under ignored `experiments/artifacts/065-session-lifecycle/<timestamp>-<pid>/`.
No ordinary home, real login token, existing agent or shared preview is used.

Final evidence: `20261025T191957Z-49379/report.json`; the preceding
`20261025T191905Z-48637/report.json` run measured the same outcome before the final
identity/frame-count assertions were added. Runtime versions: Codex 0.164.0,
Claude Code 2.1.310, official Node SDK 0.3.296, macOS 26.6.2 arm64.

**No-inference probe: USD 0; model inputs: 0.** This does not include the
parent agent's separately coordinated paid interruption/continuation checks.
Claude's selected interrupted result reports USD 0.00124618. See the combined
[064/065 usage ledger](../064-history-continuation/usage-ledger.md) for paid totals
and their interpretation; these are not measured subscription bills.

## Limits

The no-inference probe does not establish active behavior; the two browser cases
above add a deliberately narrow tool-interruption qualification. Pending prompts,
escaped/detached children, other tools' cancellation, idle expiration, remote
hosts and seamless crash recovery remain outside these checks. In-memory owner
status can disappear on crash while saved history and
launcher records remain; those are evidence for reconciliation, not restored
execution handles. Further UI and production policy decisions remain with the
backend/client architecture review.
