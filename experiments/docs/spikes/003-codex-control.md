# 003 — Codex SDKs, app-server and a local fork

## Question and main result

Can we control the Codex CLI harness through a rich local interface, and can we build a fork locally? **Yes to both.** The [official OpenAI documentation](https://learn.chatgpt.com/docs/codex-sdk) already describes TypeScript and Python SDKs. Their control surfaces differ: the TS SDK wraps `codex exec`; Python wraps the bidirectional app-server. The [app-server protocol](https://learn.chatgpt.com/docs/app-server) is the strongest starting point for our TypeScript copilot: no Rust wrapper is required to access it.

We created the public upstream fork [habemus-papadum/codex](https://github.com/habemus-papadum/codex), added it as the pinned `vendor/codex` submodule, built its CLI without patches, and drove its app-server from a small local TypeScript client. The spike code remains in this private repository.

## Observed experiment

On macOS 26.6.2/arm64, `cargo build --locked -p codex-cli --bin codex` succeeded in **3m 58s**, with six jobs and an external target directory. Actual tools were Homebrew Cargo/rustc **1.98.1**; upstream requests **1.95.0**, but Homebrew Cargo does not honor rustup toolchain pins. The debug binary is about 876 MiB and build output about 15 GiB. The linker emitted an unwind-table size warning; build and smoke execution succeeded.

The explicit built binary reports `codex-cli 0.0.0`; its real source identity is **`6c372fbef45f730b6d8aa727b0ec8332365588db`** (upstream 2026-10-12). The probe successfully performed `initialize` → `initialized`, verified an empty account and thread list in fresh home/config directories, and executed a fixed `printf` through `command/exec` using `dangerFullAccess`. It requested **zero model calls**. This verifies local control and these isolation checks, not long-running sandbox behavior or agent effectiveness.

## Reproduce

From the repository root:

```sh
git submodule update --init --depth 1 vendor/codex
pnpm install
pnpm --filter @agent-spike/003-codex-control build:codex
pnpm --filter @agent-spike/003-codex-control probe
```

The [probe](../../spikes/003-codex-control/src/probe.ts) has bounded request timeouts, cleans up its child process, supplies an environment allowlist, and uses isolated file-backed auth storage. `SPIKE_CODEX_BIN` can explicitly select another binary. Build/probe output lives under ignored `artifacts/003-codex-control/`: `build-initial.log`, `build-invocation.json`, `build-result.json`, and `probe-*/{level-0.json,level-1.jsonl,result.json,stderr.log}`. The initial successful probe directory is `probe-2026-10-12T12-44-35.803Z`. TypeScript typecheck/build and the incremental build helper also passed.

## Source findings and choice

- **Official TS SDK:** small, official, and suitable for jobs and streamed results; its one-prompt subprocess interface does not provide the full interactive control surface. **Official Python SDK:** materially richer, including fork, steer, interrupt and concurrent turn routing. Registry metadata reported both SDKs at `0.162.1`; this spike inspected the pinned source, not those published archives.
- **App-server:** source exposes steering, compaction, fork, custom tools, user questions, approvals, cached-token usage and background-terminal APIs. Some are experimental. Generate bindings from the actual executable. `thread/rollback` is already removed at our pin; `thread/revert` replaces it for paginated threads.
- **Community clients:** `codex-app-sdk` has substantial typed transport, lifecycle, UI and test implementation, but targets older protocol `0.154.0`; `agentclientprotocol/codex-acp` is a strong ACP adapter with scenario tests. A community Python SDK still exposes removed rollback calls. These are code-inspection assessments, not runtime quality benchmarks. See the [comparison and pinned evidence](../../spikes/003-codex-control/source-notes.md).
- **Our own wrapper/fork:** a thin TS app-server client can preserve the harness and expose its controls directly. Rust crates can be consumed as dependencies—an older ACP implementation does this—but internal API/dependency churn adds work. Keep the fork for demonstrated internal changes such as tracing or a reproducible policy issue.

## Limits and next useful question

The [raw-protocol isolation follow-up](003-codex-isolation.md) now tests existing authentication separately from developer configuration, per-thread MCP overrides, and skill discovery/settings on the installed CLI.

The original build probe did not test model inference, mid-turn steering, fork/revert semantics, dynamic tools, human approvals, compute sleep/wake, or long-running sandbox persistence, and did not reuse developer credentials. A successful resume is not proof that background processes survive suspension. A focused next spike should exercise these lifecycle and interaction controls before deciding whether any Rust patches are necessary.
