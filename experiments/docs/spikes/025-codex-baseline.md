# 025 — A clean, versioned Codex baseline

**Observed, 2026-10-14:** the clean pinned Codex source built successfully and both
it and installed 0.162.1 passed a credential-free protocol export/handshake probe.
The installed release exports 266 named messages with experimental export enabled;
the source build exports 269. This establishes binary identities and one working
experimental execution method, not compatibility of every exported method.

| Identity | Installed release | Clean source build |
| --- | --- | --- |
| Explicit entry point | `/Users/nehal/.local/bin/codex` | `artifacts/003-codex-control/target/debug/codex` |
| Reported version | `codex-cli 0.162.1` | `codex-cli 0.0.0` |
| Source identity | Release tag `rust-v0.162.1` resolves to `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | `6c372fbef45f730b6d8aa727b0ec8332365588db`, clean worktree |
| SHA-256 | `74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0` | `e40aeb592b458d689cb4b4a5c8cb5f50ff4135c0a852af35822ba0684515a10c` |
| Stable named messages | 200 | 201 |
| Experimental named messages | 266 | 269 |

The installed entry point resolves to
`/Users/nehal/.codex/packages/standalone/releases/0.162.1-aarch64-apple-darwin/bin/codex`.
Both baseline runs record macOS 26.6.2 arm64. The Python interpreter is 3.14.7.
The source checkout's revision is recorded alongside the installed executable for
comparison; it is **not** a claim that the installed executable was built from
that newer pin. The tag verifies the release mapping, not reproducible binary
provenance from an upstream release build.

## Build and protocol differences

The build used `cargo build --locked -p codex-cli --bin codex`, the development
profile, six jobs and an ignored target directory. It finished in **3 minutes
42 seconds** with exit 0. Homebrew Cargo/Rust **1.98.1** was on PATH, whereas
upstream `rust-toolchain.toml` requests **1.95.0**. This is an explicit toolchain
deviation; no default toolchain was changed. The browser-Origin patch was not
applied. Native build completion is not a Rust test-suite result.

Normal and `--experimental` JSON Schema and TypeScript exports were saved for
both binaries, with per-JSON-file hashes in each `result.json`. The installed
method-kind/top-level-field inventory matches the stored 007 inventory exactly.
The source build adds:

- Requests `thread/items/read` and `thread/readState/update`.
- Notification `thread/readState/changed`.
- Request fields `thread/list.excludedThreadIds`,
  `thread/fork.experimentalPredictionMode`, and `environment/add.websocketRequestId`.

The comparison examines named method kinds and top-level parameter field names;
it is not a complete semantic/type diff. Counts include requests and notifications
in both directions. Installed experimental counts are 170 client requests,
1 client notification, 11 server requests and 84 server notifications; built
counts are 172, 1, 11 and 85. Stable counts are respectively 105/1/10/84 and
105/1/10/85. Export visibility and runtime acceptance are separate facts.

## Representative runtime gate

Both binaries initialized on stdio in fresh unauthenticated homes. With
`experimentalApi:false`, this request failed:

```json
{"id":3,"method":"process/spawn","params":{"processHandle":"baseline","command":["/usr/bin/printf","BASELINE_OK"],"cwd":"/tmp/isolated","streamStdoutStderr":true}}
{"id":3,"error":{"code":-32600,"message":"process/spawn requires experimentalApi capability"}}
```

With `initialize.capabilities.experimentalApi:true`, the same request returned
`{}`; stdout arrived as base64 `QkFTRUxJTkVfT0s=` and `process/exited` reported exit
0 with empty buffered output. `thread/list` was empty before and after. There were
**no credentials, threads, inference calls or model cost** in these baseline runs.
The complete envelopes are private artifacts; the example shortens the cwd.

**Implication:** clients need capability opt-in and a native-protocol escape hatch.
An exported name proves neither runtime permission nor successful execution.
Use the release binary for continuity and the clean source build only for selected
comparisons. Later [026](026-codex-session-admin.md) qualifies new read-state behavior;
[030](030-codex-remote-operations.md) runs a broader credential-free filesystem and
process matrix against both binaries.

## Reproduce and evidence

From `experiments/`, after [vendor setup](../../vendor/README.md):

```sh
PATH="/opt/homebrew/bin:$PATH" CARGO_BUILD_JOBS=6 pnpm --filter @agent-spike/003-codex-control build:codex
uv run --frozen python spikes/025-codex-baseline/probe.py --binary /Users/nehal/.local/bin/codex --label installed
uv run --frozen python spikes/025-codex-baseline/probe.py --binary "$PWD/artifacts/003-codex-control/target/debug/codex" --label built
```

Build invocation/result/log: `artifacts/003-codex-control/build-{invocation,result}.json`
and `build.log`. Baseline exports/results:
`artifacts/025-codex-baseline/installed-1792000372057493000/` and
`built-1792000637463418000/`. The [README](../../spikes/025-codex-baseline/README.md)
includes source identity checks and standalone export commands.

**Source-inspected:** [toolchain pin](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/rust-toolchain.toml),
[protocol export declarations](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/common.rs),
and [experimental handshake enforcement](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/message_processor.rs#L978).
The local build runner is `spikes/003-codex-control/src/build.ts`; the baseline
runner is `spikes/025-codex-baseline/probe.py`.

**Unresolved:** the full upstream Rust test suite, a build using the requested
1.95.0 toolchain, Linux qualification, every-method runtime compatibility, nested
schema semantic differences, and direct native browser-Origin behavior. Browser
checks elsewhere use the unmodified native server through the production relay.
