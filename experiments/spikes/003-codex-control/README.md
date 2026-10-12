# 003 — Codex control and a local build

Question: can we keep the Codex harness while controlling it through a rich local API, and can we build a fork ourselves?

Result and reproduction: [one-page summary](../../docs/spikes/003-codex-control.md). The [source inspection notes](source-notes.md) compare the official SDKs, app-server, community clients, and Rust embedding.

```sh
git submodule update --init --depth 1 vendor/codex
pnpm install
pnpm --filter @agent-spike/003-codex-control build:codex
pnpm --filter @agent-spike/003-codex-control probe
```

`build:codex` builds the pinned submodule with Cargo on PATH, records the actual Rust toolchain, and writes logs and binaries under `artifacts/003-codex-control/`. The upstream toolchain request is in `vendor/codex/codex-rs/rust-toolchain.toml`; a Homebrew Cargo installation does not automatically honor that request. This experiment succeeded with Homebrew Rust 1.98.1.

`probe` uses the explicit locally built binary by default. It creates fresh child-process home/config/work directories, passes a small environment allowlist, forces file-backed credential storage, and verifies the absence of account credentials and existing threads. It performs the app-server handshake and executes a fixed `printf` command through `command/exec`. It requests no model inference. Each request has a deadline, and the subprocess is stopped on success or failure. Invocation and protocol artifacts are local, ignored files. Use `SPIKE_CODEX_BIN=/absolute/path/to/codex` to probe an explicitly selected alternative binary; that does not establish that it matches the submodule revision.

`build` and `typecheck` only compile/check this spike's TypeScript. The Rust build is intentionally separate.

## Raw-protocol isolation follow-up

```sh
pnpm --filter @agent-spike/003-codex-control isolation
```

This smaller follow-up uses `~/.local/bin/codex` by default, or `SPIKE_CODEX_BIN`. No SDK is involved. It reads only the existing ChatGPT access token and account ID from `${CODEX_HOME:-~/.codex}/auth.json`, injects them through the experimental app-server login RPC, and makes an authenticated rate-limit request, not a model call. It never refreshes tokens or copies the auth file. A keychain-only installation is not handled by this probe.

Fresh `HOME`, `CODEX_HOME`, and working directories live outside the repository in a private temporary directory. The probe disables bundled skills, plugins, and apps; checks empty initial MCP/skill inventories; then adds an inert MCP fixture to just one of two threads and checks working-directory-scoped skill discovery and isolated-home skill settings. Redacted transcripts and results remain in ignored `artifacts/003-codex-control/isolation-*/`; temporary homes are retained for inspection. This is configuration isolation, not an OS security boundary. See the [follow-up results](../../docs/spikes/003-codex-isolation.md).
