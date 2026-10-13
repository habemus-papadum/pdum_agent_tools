# Claude Code session discovery and native terminal attachment

**Result, 2026-10-13:** `claude agents` really is a terminal session manager in Claude Code 2.1.296. Its `--json` form discovers active sessions, including a headless SDK worker. Native `claude attach` also works, but it attaches to Claude's background-session supervisor through a terminal protocol. It cannot attach to the stream-json worker used by our proposed app server.

## Question and observed behavior

Can existing Claude commands supply live discovery or an unmodified terminal client for [spike 014](014-claude-app-server-proposal.md)? The credential-free probe used temporary configuration and working directories, a real worker, a foreground native supervisor, and two real pseudo-terminal clients.

| Probe | Observed result |
| --- | --- |
| `agents --json` | Empty before launch; exactly our SDK worker after initialization; empty after it exits. The headless worker is classified as `kind: "interactive"`, with `entrypoint: "sdk-cli"` in its registry record. |
| Profile and path scope | A second config root cannot discover the worker; an unrelated `--cwd` filter returns no entries. This is discovery within the selected configuration namespace, not an unconditional machine-wide process scan. |
| `attach <SDK-session-uuid>` | Exits with “No job matching”; appearing in discovery does not establish terminal attach support. |
| `--bg --model haiku`, without a prompt | Creates a named dormant background conversation. Its initial listing has no PID. |
| Native `attach <background-id>` | Starts a real background worker and displays its terminal UI. Ctrl-Z detaches; the worker remains listed. |
| Native `agents` TUI | Displays our named background conversation in a real pseudo-terminal. |
| `--sdk-url ws://127.0.0.1:…` | Exits 1 because the host is not an approved Anthropic endpoint. A listening local server receives zero connections. |
| Cleanup | Native supervisor stop followed by waiting confirms the owned supervisor and background worker exit. |

## How discovery and attachment work

The worker writes `CLAUDE_CONFIG_DIR/sessions/<pid>.json`. Our record contained process/start identity, conversation ID, cwd, kind, entrypoint, status, display name, and peer-protocol metadata. Embedded-source inspection shows discovery checks process existence/start identity and combines these records with persisted background jobs and the supervisor's live roster. `agents --json --all` additionally includes completed background sessions; it is not the standalone SDK transcript-history helper.

On this macOS build, the supervisor socket is `/tmp/cc-daemon-<uid>/<config-root-hash>/control.sock`, where the namespace is the first eight SHA-256 hex characters of the resolved configuration-root string. The probe relayed only its own socket and captured the actual exchange: a newline-delimited JSON request with `proto: 1`, `op: "attach"`, job ID, local authentication, terminal dimensions and capabilities; a JSON acknowledgement; then **raw terminal bytes**. The final run received 3,139 terminal bytes. The client source sends resize controls through separate control requests. A different internal supervisor-to-PTY transport uses length/type-framed messages; those are not the terminal client's wire format.

Native daemon help says persistent service installation is disabled in this version. We explicitly launched `daemon run --origin transient` as an owned foreground child; no launchd service was installed. The exact flags, registry layout and terminal protocol are version-specific findings, not a public SDK contract.

## Reproduce and evidence

From `experiments/`, after installing its locked pnpm/uv environments:

```sh
pnpm --filter @agent-spike/015-claude-agents-discovery typecheck
pnpm --filter @agent-spike/015-claude-agents-discovery probe
pnpm --filter @agent-spike/015-claude-agents-discovery build
```

All three passed. Latest complete evidence is under ignored `artifacts/015-claude-agents-discovery/run-O9SOc6/`: CLI help, initialization, owned registry record, local socket bytes, TUI output, per-PID `lsof`, trace failures, hashes, assertions and cleanup results. Raw captures and local authentication values remain unpublished. See the [probe notes](../../spikes/015-claude-agents-discovery/README.md) for isolation, interpretation and a Linux follow-up.

Environment: macOS Darwin 25.6.0 arm64, Node 26.10.0, Python 3.14 through uv, SDK 0.3.296 and Claude Code 2.1.296. Installed and SDK-bundled executables are byte-identical, SHA-256 `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`. SDK `sdk.mjs` SHA-256 is `5cf6f15237f9c84e6e5b724a10180478732457168921d7aa3e02632037cce299`. Source findings come from embedded JavaScript in that distribution; this is not a separately checked-out public source revision.

## Limits and architecture consequence

`fs_usage` required root; `dtruss` required additional privileges and reported SIP restrictions. Registry snapshots, owned-PID `lsof`, source inspection and our own socket relay answered the central questions without sudo. Linux tracing would strengthen syscall-level evidence but is not a blocker.

Use explicit manager-owned workers for the app server, and keep native session discovery as an optional inventory surface. Treat terminal-backed background sessions as a separate possible backend. This spike does **not** demonstrate an SDK browser and native terminal sharing one worker, nor does it establish simultaneous terminal-controller semantics. Native `attach` cannot be pointed at our WebSocket endpoint, and `--sdk-url` is an outward Remote Control worker path restricted to Anthropic hosts in this pin.

No user prompts or authenticated inference requests were submitted. Haiku was explicitly selected for workers; estimated inference cost is **USD 0.00**. Actual billing was not inspected. An incidental source finding relevant to spike 014's ledger: result `total_cost_usd` and `modelUsage` are cumulative, can inherit saved transcript totals on resume/fork, and reset on `/clear`. Never sum consecutive result totals; record the restored baseline. These estimates also exclude some helper calls outside the query pipeline.
