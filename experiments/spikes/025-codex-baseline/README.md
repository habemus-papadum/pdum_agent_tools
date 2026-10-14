# 025 — Version/build/protocol baseline

This runner exports normal and experimental JSON Schema/TypeScript, records the
exact executable path/version/hash, compares method kinds/top-level fields with
the stored inventory, and tests the experimental handshake against real app-server
processes. It uses fresh temporary homes/cwds, no credentials, no threads and no
inference. Baseline artifacts are ignored local output.

Run from `experiments/`. Restore the clean exact source as described in
[vendor setup](../../vendor/README.md); the imported workspace is not a submodule.
Do not apply the browser-Origin patch for this baseline.

```sh
git -C vendor/codex rev-parse HEAD
git -C vendor/codex status --porcelain
git -C vendor/codex rev-parse 'rust-v0.162.1^{commit}'
PATH="/opt/homebrew/bin:$PATH" CARGO_BUILD_JOBS=6 pnpm --filter @agent-spike/003-codex-control build:codex
uv run --frozen python spikes/025-codex-baseline/probe.py --binary /Users/nehal/.local/bin/codex --label installed
uv run --frozen python spikes/025-codex-baseline/probe.py --binary "$PWD/artifacts/003-codex-control/target/debug/codex" --label built
```

Expected source is `6c372fbef45f730b6d8aa727b0ec8332365588db`, status empty;
release tag resolves to `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`.
The recorded build used Homebrew Cargo/Rust 1.98.1 instead of upstream's requested
1.95.0. Its `--locked` build uses the existing native Cargo.lock, six jobs, the
development profile and `artifacts/003-codex-control/target`. It does not run tests.
The PATH prefix reproduces the macOS toolchain selection; other machines should
record their actual tools rather than claiming this environment was reproduced.

For direct export inspection, choose an explicit executable and fresh output paths:

```sh
/Users/nehal/.local/bin/codex app-server generate-json-schema --out artifacts/025-manual/schema-stable
/Users/nehal/.local/bin/codex app-server generate-json-schema --experimental --out artifacts/025-manual/schema-experimental
/Users/nehal/.local/bin/codex app-server generate-ts --out artifacts/025-manual/types-stable
/Users/nehal/.local/bin/codex app-server generate-ts --experimental --out artifacts/025-manual/types-experimental
```

`probe.py` performs those exports with isolated HOME/CODEX_HOME/TMPDIR and stores
per-JSON-file hashes. Each RPC has a 15-second deadline; process exit notification
has a 10-second deadline; child shutdown has a 5-second deadline before kill.
`process/spawn` must fail without experimental capability and execute
`/usr/bin/printf BASELINE_OK` successfully with it. It verifies empty thread lists
before/after. This one runtime check is not an all-method compatibility claim.

Recorded successful runs:

- `artifacts/025-codex-baseline/installed-1792000372057493000/`: release 0.162.1,
  experimental named-message count 266, unchanged stored inventory.
- `artifacts/025-codex-baseline/built-1792000637463418000/`: clean pin's debug build
  reports version 0.0.0, named-message count 269; actual identity is its hash/revision.
- `artifacts/003-codex-control/build-invocation.json`, `build-result.json`, `build.log`:
  successful source build in 3 minutes 42 seconds.

See the [result](../../docs/spikes/025-codex-baseline.md). Runtime findings for
new read state are in 026; additional credential-free process/filesystem execution
on both binaries is in 030. No lockfiles/manifests or upstream source were edited
for this baseline.
