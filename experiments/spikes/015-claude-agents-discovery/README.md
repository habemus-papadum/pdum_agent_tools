# Native Claude discovery and terminal transport probe

This macOS-only probe answers whether `claude agents` is live-session discovery and whether the unmodified native terminal can attach to the proposed SDK app server. See the [result](../../docs/spikes/015-claude-agents-discovery.md).

Run from `experiments/`:

```sh
pnpm --filter @agent-spike/015-claude-agents-discovery probe
```

The pinned SDK supplies the executable. The probe asserts SDK 0.3.296, inspects narrow embedded-source markers, records executable and SDK hashes, then launches only owned processes. It takes about 15 seconds, submits no model prompt, and requires no credentials. It uses the experiments uv environment for a small standard-library Python PTY helper. Generated evidence stays under ignored `artifacts/015-claude-agents-discovery/run-*/`.

## Isolation and instrumentation

The child environment has a temporary HOME, explicit `CLAUDE_CONFIG_DIR`, disabled nonessential traffic and auto-updates, and bare/simple mode. Neither normal sessions nor credentials are imported. Only the fresh empty workspace receives a local trust record so native background launch can proceed.

The SDK worker gets a real `initialize` control request over stream-json without user input. The probe compares discovery before/during/after its lifetime, verifies a second profile and cwd filter, reads its own `sessions/<pid>.json`, and attempts native attach by its conversation UUID. That last call fails because the SDK worker has no native background-job identity.

For the native terminal case, the probe starts an explicit foreground supervisor. It temporarily renames **its own** Unix socket and places a transparent socket relay at the original path. Both directions are recorded under the private artifact directory. The relay is removed and the original endpoint restored before supervisor shutdown. No global proxy, interception CA, launchd job, or foreign process is changed. The PTY helper sends only detach/exit keys; it never types a model prompt.

The attach request contains a local random authentication value. Raw socket and terminal captures are private evidence, even though this run carries no provider credential. `socket-summary.json` exposes only operation/field names, byte counts and acknowledgement facts. The foreground supervisor and created worker are explicitly stopped; the probe verifies the background PID is gone. Temporary state is preserved for local inspection.

## Evidence interpretation

The terminal-client connection starts with an NDJSON attach request and acknowledgement, then changes to raw terminal bytes. Source inspection additionally shows a separate length/type-framed supervisor-to-PTY transport. Do not use that internal framing to describe the terminal-client socket.

The registry's `kind: "interactive"` means this discovery category includes the SDK worker; it does not mean the process owns a terminal or accepts `claude attach`. A dormant background entry has a conversation/job identity before it has a live PID. Persisted transcripts, live registry records, daemon jobs, and SDK subagent definitions are four distinct things.

Source inspection finds that JSON discovery combines active registry records, job-state files and a live supervisor list/roster fallback. This probe proves the controlled examples, not every liveness failure mode or every platform. It does not alter records to simulate PID recycling and does not test concurrent terminal writers.

The local `--sdk-url` attempt stops at the pinned binary's host validation. A local listening HTTP/upgrade endpoint records zero connections. No allowlist bypass, host-file change, backend impersonation, or private server emulation is attempted.

## Optional Linux follow-up

No Linux machine is needed to accept these macOS findings. A useful follow-up would run the same pinned Linux distribution under `strace` as its launching user, with new isolated config/work directories and no inference prompt:

1. Trace `claude agents --json` using `strace -ff -ttt -s 256 -e trace=%file,%network,%process -o <private-artifact-prefix> ...`; verify the registry reads and local daemon connection. Save the Linux executable/package hashes.
2. Launch the owned `claude daemon run --origin transient` under the same trace, create one dormant `--bg --model haiku` job, and attach in a PTY. Correlate `execve`, `openat`, `connect`, `accept`, PTY ioctls and child lifetimes. Add `ioctl` explicitly to the syscall filter for terminal behavior.
3. Compare `/proc/<owned-pid>/fd` links with the captured socket namespace. Confirm detach preserves the worker and stop removes the owned process tree.

Tracing a child you launch normally avoids an attach-to-foreign-process privilege gate, though host ptrace policy can still constrain it. On this Mac, `fs_usage` exits with a root requirement and `dtruss` reports missing privileges plus SIP restrictions. We did not request sudo or change SIP.

## Cost-accounting source note

The binary's result schema explicitly describes cumulative `total_cost_usd`/`modelUsage`, restored totals and `/clear` resets. The implementation's `cost-state` transcript row stores `totalCostUSD` and per-model token/cost fields. Transcript parsing keeps the last schema-valid cost-state for each session ID; the resume path restores it, while absence resets the ledger. Individual result `usage` is initialized for each turn.

These facts supported the parallel spike 014 cost ledger investigation. Save restored baselines and per-turn usage; avoid counting previous conversations again on resume or treating cumulative totals as independent charges. Query-pipeline estimates exclude some helper calls, including permission-classifier and token-count calls, and are not billing statements.
