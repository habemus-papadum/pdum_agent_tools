# 030 — Files and terminals without a conversation

**Observed, 2026-10-14:** installed Codex 0.162.1 exposes working host filesystem,
streaming command and experimental process operations without credentials, a
thread or inference. A browser can use these through the existing Python launcher
relay. Shell commands explicitly associated with a thread create stored command
items; standalone commands/processes do not create conversation history.

## What worked

The disposable macOS probes read UTF-8 text and binary `00 ff 80 0a` exactly through
`dataBase64`; read through a symlink; reported both `isSymlink:true` and target
`isFile:true`; listed directories; and completed write/copy/remove round trips.
A 5 MiB file round trip was exact. Relative paths fail deserialization; missing
absolute files return an I/O error. Watch notifications arrived after modification
and stopped after unwatch. A symlink watch response retained the symlink path.
These tests establish no maximum file size.

| Execution surface | Observed behavior | Client implication |
| --- | --- | --- |
| `command/exec` | Reply waits for exit. Stream deltas precede reply; streamed final stdout/stderr are empty. | Start the RPC without awaiting it before sending stdin/control. |
| `process/spawn` (experimental) | Immediate `{}` reply, output deltas, then `process/exited`. Streamed exit stdout/stderr are empty. | Natural independent process lifecycle; opt into experimental API. |
| Pipe mode | Separate stdout/stderr labels, base64 stdin/output, stdin close, nonzero exit 7. | Preserve bytes and per-stream ordering; inter-stream arrival order can differ from write order. |
| PTY mode | Initial `stty size` 20 × 70, observed post-resize dimensions 30 × 90 (command) / 25 × 85 (process), terminate/kill and exit. | PTY combines streams and changes line endings to CRLF. |
| Timeout | Both standalone surfaces returned exit code 124. | Distinguish timeout from transport loss. |
| Native caps | Explicit 12-byte caps truncate; deltas mark `capReached:true`; process exit includes per-stream cap flags. | Preserve native loss indicators. This experiment added no observation-pipeline cap. |
| Handle scope | B cannot kill A's handle; an active duplicate handle is rejected; a completed process handle can be reused. | Handles belong to a connection, not a thread or server-wide identity. |
| Disconnect | Closing A killed its real command/process child within the 500 ms observation window. | Reconnection does not recover an independent running terminal. |
| `thread/shellCommand` | Immediate acknowledgement, command item/deltas/completed turn, stored exit 7 and `aggregatedOutput:"shellerr"`. | Thread history repeats the final aggregated snapshot; reconcile it against prior deltas. |

Buffered command output is a JSON text string, not a binary artifact: the probe's
byte `ff` appeared as `ÿ`. Streaming retained the original bytes exactly. Native
standalone output is not repeated in its final reply/exit; thread command history
contains the final aggregated output.

## Representative wire

```json
{"id":1,"method":"command/exec","params":{"command":["/usr/bin/python3","/tmp/probe/child.py"],"cwd":"/tmp/probe","processId":"pipes","streamStdin":true,"streamStdoutStderr":true,"timeoutMs":3000}}
{"method":"command/exec/outputDelta","params":{"processId":"pipes","stream":"stdout","deltaBase64":"b3V0MQo=","capReached":false}}
{"id":2,"method":"command/exec/write","params":{"processId":"pipes","deltaBase64":"AP/DqQo=","closeStdin":true}}
{"id":2,"result":{}}
{"id":1,"result":{"exitCode":7,"stdout":"","stderr":""}}
```

Negative case: `command/exec` rejects simultaneous `outputBytesCap` and
`disableOutputCap` with `-32602`. Cross-connection control fails with `-32600`
and “no active command/exec” / “no active process”. Paths above are shortened;
full private captures retain actual disposable paths.

## Reproduce and evidence

From `experiments/`:

```sh
node spikes/030-codex-remote-operations/probe.mjs
node spikes/030-codex-remote-operations/large_file.mjs
/Users/nehal/src/pdum_agent_tools/.venv/bin/python spikes/030-codex-remote-operations/browser_harness.py
# Copy printed endpoint/cwd into the following command:
node spikes/030-codex-remote-operations/disconnect.mjs WS_ENDPOINT DISPOSABLE_CWD
```

The harness serves plain HTML and the production `pdum.codex_launcher.relay.Relay`.
It owns a foreground native process and isolated home/cwd. Add `--auth` only for
031 image submission; credential-free terminal checks need none.

Private evidence: `artifacts/030-codex-remote-operations/run-1792000684787/`
(13 successful cases, including observed resize), `disconnect-1792000417961/`, and `large-file-1792000657919/`.
The first run, `run-1792000298945/`, preserves an experiment error: `/bin/true`
was absent on this Mac; correcting to `/usr/bin/true` made handle reuse pass.
No model calls or API-equivalent model cost occurred in 030's standalone runners.
Actual Chrome 155 buttons passed connect/start, stdout `20 70`, stdin echo,
resize acknowledgement and terminate exit 1; see 031's `browser-check.json`
and the combined round evidence. The browser harness/native process and temporary
home were cleaned up after the checks.

**Source-inspected, clean 6c372fb:**
[filesystem processor](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/fs_processor.rs),
[process processor](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/process_exec_processor.rs),
[command execution](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/command_exec.rs),
and [PTY defaults](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/utils/pty/src/lib.rs#L25)
show local host filesystem operations with no thread sandbox, unsandboxed
`process/spawn`, and a 1 MiB default per-stream process cap. `command/exec`
uses server permissions; `thread/shellCommand` intentionally executes unsandboxed.
The same 13-case matrix passed against the clean source build
`artifacts/003-codex-control/target/debug/codex` in
`artifacts/030-codex-remote-operations/run-1792000703825/`; source-dependent
filesystem and process findings therefore have a matching runtime check.
This source pin is distinct from the installed release; see 025 for mapping.

**Unresolved:** Linux/remote-host qualification, very large files, watch overflow
or atomic-replace races, descendant cleanup trees, sandbox-on standalone commands,
and thread background-terminal interactive control.
