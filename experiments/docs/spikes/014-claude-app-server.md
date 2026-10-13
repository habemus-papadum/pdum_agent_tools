# Claude Code app server: measured boundaries

> **Recommendation superseded:** [spike 016](016-claude-client-sessions.md)
> adopts client-owned SDK queries and disconnect-ended workers after the lifetime
> requirement was simplified. The findings below remain the historical 014 results.

**Result, 2026-10-13:** a direct launcher and small newline-JSON relay can reuse
the official browser and Node SDK control implementations. A production app
server should keep **one official SDK query in the manager per worker** and
expose an application session API. Two raw SDK controllers answer the same
callback; a browser disconnect also loses its callback functions. See the
[architecture and work plan](../proposals/claude-app-server-architecture.md).

The [proposal](014-claude-app-server-proposal.md) now has a runnable research
harness. Live Haiku qualification passed using authorized Keychain login reuse;
complete SDK parity and durable recovery remain follow-up work.

| Question | Evidence and result |
| --- | --- |
| Who launches? | Captured official Node SDK argv matches the direct launcher for the tested options. Unmodified Claude initializes over stream-json. No executable patch. |
| Browser / Node clients | Browser export under Node works unchanged. Node root SDK works through a virtual-process spawn adapter, including detach/cancel/abnormal socket closure. Actual Chrome 155 requires an empty `process` shim; live streaming, browser-hosted hooks, permission/tool callbacks and active interruption pass. |
| Sharing | Real worker accepts two SDK initializations and concurrent controls, but both clients answer one hook callback with the same request ID. Strongest safe measured mode is one controller plus observers. |
| Reconnect / concurrency | Two real workers initialize through WebSocket/stdio application adapters. Two live Haiku requests also overlap while their outputs, controls and profiles remain independent. Detach preserves worker; cursor replay keeps order; stopping one leaves the other alive. Failure-injection tests cover pending callback snapshots, duplicate/stale decisions and input receipts. A paused real WebSocket observer overflows without delaying the controller or losing canonical history. |
| Storage | Official helpers list/read/rename/fork two isolated profiles sharing a workspace. Full and selected-message forks remap IDs and preserve the source. Synthetic edge cases are supplemented by four live Haiku turns: two profiles, cold resume of a selected-message fork, and a launch-time fork with inherited context. An incomplete trailing record is omitted from a fork. |
| Recovery | A real worker is killed while a native hook callback is pending. The manager reports the lost callback. Restarting the actual manager process resets history/receipts, rejects the old cursor and does not retry input. No durable replay is implemented. |
| Live launch comparison | Browser export under Node, virtual-process Node SDK and server-owned Node SDK all pass streamed replies, actual Bash permission decisions and active interruption. A result ends a turn while the worker remains usable. |
| Native CLI | Headless worker passes. `agents --json` discovers it, but native `attach` rejects that SDK conversation. Native background terminal attach works through a separate Unix-socket/PTY protocol. Local `--sdk-url` is rejected before connecting. See [spike 015](015-claude-agents-discovery.md). |

## Reproduce

From `experiments/`:

```sh
pnpm install --frozen-lockfile
pnpm spike:014
pnpm --filter @agent-spike/014-claude-app-server test
pnpm --filter @agent-spike/014-claude-app-server probe:browser --block
pnpm spike:015
```

The browser command prints its URL. Its hook blocks inference while exercising
actual client callbacks. Explicit live mode is `pnpm spike:014 --live`, using an
injected API key/OAuth token, or `--live --keychain` to select macOS login reuse.
See the [probe README](../../spikes/014-claude-app-server/README.md) for controls,
budgets and shutdown. No model fallback occurs.

## Evidence, cost and limits

SDK **0.3.296**, bundled Claude **2.1.296**, Node **26.10.0**, Darwin **25.6.0**
arm64, Chrome **155.0.0.0**. Exact hashes and launch mappings are in the
[client details](014-launch-client-details.md); storage/cost-state findings are
in [storage details](014-storage-details.md). Raw protocol, profiles, PID/session
maps, traces and results stay under ignored `artifacts/014-claude-app-server/`.
The SDK hash identifies distributed bytes, not a private source revision.

Principal evidence: `run-9TAxoR/report.json` (seven live queries),
`browser/run-oGK57W/` (real Chrome), `run-GlnqRX/recovery/` (process restart),
and `concurrency-20261013/` (overlapping live requests). The client details also
record the unshimmed browser failure and a browser hook observed by a Node client.
The [source](../../spikes/014-claude-app-server/src/) reproduces the probes.

Across ten live query attempts (18 submitted inputs), the recorded SDK estimate
is **USD 0.00361993**, about **0.36 cents**. The independent model-usage estimate
is USD 0.00271948–0.00361993 because cumulative cache-write counts lack TTL.
The combined ledger is `artifacts/014-claude-app-server/cost-ledger.json`. Actual billing
was not inspected, and orchestration-agent usage is not exposed by these probe
APIs. The ledger records every attempt and subtracts restored transcript costs
to avoid double-counting forks. Some internal helper calls remain outside native
accounting; these are estimates, not invoices.

Validation: 12 focused integration/accounting tests passed, as did workspace
TypeScript checks/builds, the strict MkDocs build, the new Python helper
lint/format checks, lock checks and local documentation links. MkDocs validates
the production docs tree; the research Markdown links were checked separately.

Still unqualified: fresh-SDK reconnect with callback restoration, simultaneous
raw controllers, steering semantics, SDK MCP parity, durable manager-restart
replay, background-task quiescence and browser/native-terminal sharing of the
same worker. The browser shim qualifies the measured paths, not every browser
SDK method. Linux tracing is optional follow-up; it did not block the local
terminal/discovery findings.
