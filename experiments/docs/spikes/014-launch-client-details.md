# Spike 014: launch and client details

Observed on 2026-10-13 with Agent SDK **0.3.296**, its bundled Claude Code
**2.1.296**, Node **26.10.0**, and macOS arm64. These are launch/control findings;
they do not establish model, tool, or recovery compatibility by themselves.

## Observed boundary

The official Node SDK initialized an actual isolated Claude worker with no
credentials or model request. The spike's direct launch argv matched the SDK's
captured argv exactly for the deliberately small tested configuration. The
official browser export, running under Node's WebSocket implementation, then
initialized another direct worker over an unmodified newline-delimited JSON
relay. Two concurrent interrupt controls resolved. Closing that SDK connection
left the worker running.

The Node root SDK also initialized through its public `spawnClaudeCodeProcess`
hook when the hook returned a virtual process backed by the same WebSocket
relay. This required an adapter, without an SDK package patch. Closing the SDK
ended the virtual connection and left the actual worker alive. The adapter maps
connection closure to virtual process exit; it cannot infer a native worker's
actual exit status from raw WebSocket closure. Management events must carry
worker failure separately. The official Node SDK also surfaced cancellation as
`Claude Code process aborted by user` and an injected abnormal socket close as
`Claude Code process exited with code 1`; both left the manager-owned worker
alive. This verifies the adapter's failure semantics, not a worker exit code of 1.

Two SDK clients initialized simultaneously against one native worker, and their
concurrent controls completed. This did **not** establish safe shared ownership.
For one real `UserPromptSubmit` hook callback, both clients invoked their hook
and both replied with the same native request ID. The hook deliberately blocked
the input; the worker returned zero input/output tokens and an empty
`modelUsage`. This is an actual worker callback, without synthetic model output
or inference spending. A broadcast relay duplicates callback decisions; retain
one protocol controller until ownership and initialization are mediated.

## Configuration mapping

The tested argv contains stream-json input/output, verbose output, explicit
model, turn and spend bounds, `--permission-prompt-tool=stdio`, tools, settings
sources, strict MCP selection, permission mode, partial-message output, and
disabled slash commands. Persistence is enabled. Hook functions themselves are
not serialized: initialization registers hook callback IDs, and the owning SDK
keeps the JavaScript functions. The Node SDK's system prompt was supplied in its
initialize request, while the browser public options have no system-prompt
field. A production profile implementation must map instructions explicitly.
The spike does not claim exhaustive launch-option parity or SDK-hosted MCP parity.

The Node SDK adds `CLAUDE_AGENT_SDK_VERSION=0.3.296`,
`CLAUDE_CODE_SDK_READS_SESSION_STATE=1`, and `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, and
removes `NODE_OPTIONS` and `DEBUG` unless its own debug mode requests them. The
direct launch reproduces those SDK flags. New HOME, config, temporary, and work
directories are explicit. A populated profile root is rejected to catch
accidental reuse. Direct workers own a POSIX process group and stop using stdin
EOF followed, if necessary, by TERM and KILL, awaiting exit.

The browser WebSocket implementation consumes text messages and waits for
newline-terminated JSON. Its declared `headers` option is not used by the
implementation's `new globalThis.WebSocket(url)` call. Its `endInput()` is a
no-op, unlike the Node process transport's stdin EOF. Keep an explicit input
queue open for subsequent turns; socket detach and worker stop are distinct.
SSE is a separate remote-service envelope and was not tested here.

## Browser packaging finding

The published browser bundle contains unguarded module-scope accesses to
`process.platform` and `process.env`, and the query's debug logger captures
`process.argv`, `process.env`, and `process.on`. The first actual browser attempt
failed with `ReferenceError: process is not defined` before creating the query.
This is a browser environment assumption, not a WebSocket framing failure.
The browser harness's small empty process shim then enabled actual Chrome 155
initialization with `tokenSource: none` and no console errors. The published
package is unchanged, but a clean browser needs this environment adapter.
The final spike report records the browser callback and management checks.

## Reproduction and evidence

From `experiments/`:

```sh
pnpm exec tsx spikes/014-claude-app-server/src/launch-probe.ts \
  artifacts/014-claude-app-server/launch-unique-run
```

Use a new output directory. `runLaunchProbe(outputDirectory, options)` also
accepts explicit server-side `authEnv`, `model`, and `live` options. The optional
live phase compares browser-export-under-Node, virtual-process Node SDK, and
server-owned Node SDK. Each query has a USD 0.05 SDK estimate cap, six model-turn
cap, bounded waits, and three user inputs: a brief reply, a hook-forced
permission decision for Bash `printf`, and interruption of Bash `sleep 20`.
It stops subsequent variants after failure and never changes models. Raw usage,
model usage, SDK cost estimates, callback logs and messages are retained even
on failure. The final report distinguishes executed probes from this harness's
capabilities.

Credential-free evidence was captured in ignored
`artifacts/014-claude-app-server/launch-check-20261013-d/`: SDK recipe, initial
handshake, both worker transcripts, client frames, and the duplicate hook replies.
Later runs also record version-checked browser source markers. Package and
executable hashes identify the distribution bytes, not a private source revision:

| Artifact | SHA-256 |
| --- | --- |
| Node SDK bundle | `5cf6f15237f9c84e6e5b724a10180478732457168921d7aa3e02632037cce299` |
| Browser SDK bundle | `7f5d8dc0108929f15215b17e8bb4fbdb944d0ec4303e76c562643206988d0536` |
| macOS arm64 Claude executable | `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937` |

Credential-free results incurred no model tokens. Inspection of the pinned CLI's
result schema confirms `total_cost_usd` is cumulative across streaming turns,
while turn usage is initialized separately for each invocation. Read the latest
result's cost instead of adding cumulative totals. Resumed or forked sessions
can inherit a saved total; `/clear` resets it, and `maxBudgetUsd` applies to
spending since query start or `/clear`. The native cost ledger supplies
`modelUsage`. The supporting source excerpts are in ignored
`artifacts/015-claude-agents-discovery/cost-semantics-source-excerpts.json`.
These are price-based estimates, not invoices or actual subscription billing.

## Actual manager restart and worker crash

`runRecoveryProbe(outputDirectory)` launches an actual child manager with a
native worker, initializes it with a credential-free profile, and sends one
input held at a real `UserPromptSubmit` callback. The parent asks that manager
to SIGKILL its owned worker process group while the callback is unresolved.
The manager records the exit, reports the lost callback ID, and retains
`execution: unknown` for the accepted input. No callback decision is sent and no
model execution is reached.

The first manager then exits completely. A second manager process starts with
the identical explicit isolated profile specification and logical conversation
ID. In the observed run, manager PIDs changed from 29969 to 29989, native worker
PIDs from 29971 to 29990, and the manager's worker ID changed. History, input
receipts and callback state were empty; the old cursor 6 was rejected against
the new cursor 0, and new event numbering began at 1. The manager sent no user
input automatically. Evidence is in ignored
`artifacts/014-claude-app-server/recovery-20261013-b/`.

This demonstrates actual process restart and state loss, not native transcript
resume or conversation-context recovery. Stable logical identifiers alone do
not restore a native conversation. Abrupt manager SIGKILL while its worker
continues running was not tested; detached workers can be orphaned, and the
probe's parent retains only its own reported worker PID for forced cleanup.
Both observed managers exited successfully and their owned workers stopped.

## Live qualification

The authorized Keychain-backed Haiku 5.5 run at `run-9TAxoR/launch/`
passed all three launch variants. Each produced streamed text, executed Bash
through hook-forced permission callbacks, accepted another input after a result,
and returned promptly when an active sleep tool was interrupted. Interruption
ends with the native `error_during_execution` result in this pin; the test
expects that cancellation result, not a fabricated successful answer.

Actual Chrome 155 with the empty process shim also completed Bash, streaming,
UserPromptSubmit/PreToolUse hooks and canUseTool, then an active interruption.
Evidence is `browser/run-oGK57W/`; the first interruption was after completion,
so a subsequent third input tested interruption while active. All usage remains
in its cost record. Closing the browser afterward left the owned worker alive.
The runtime recommendation still retains a server-owned SDK query: these
compatibility results do not restore JavaScript callbacks after a browser reload.
