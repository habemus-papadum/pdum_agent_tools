# 013 — Browser Origin allowlist

Question: how much work is needed to let an actual browser initialize the pinned native Codex app-server directly over WebSocket?

This is a deliberately narrow, local-only source patch, not an SDK, authentication redesign, or production gateway. See [the result](../../docs/spikes/013-codex-browser-origin.md).

## Reproduce

In the original research checkout the patch was applied. The imported workspace
contains the patch file, **not** that checkout or its built binaries. First follow
[vendor setup](../../vendor/README.md) and build the clean baseline. On a **clean**
`vendor/codex` at `6c372fbef45f730b6d8aa727b0ec8332365588db`, apply it once:

```sh
git -C vendor/codex apply "$PWD/spikes/013-codex-browser-origin/browser-origin.patch"
```

Prerequisites: pnpm dependencies installed and the [Spike 003 native build](../003-codex-control/README.md) already completed, producing `artifacts/003-codex-control/target/debug/codex`. The runner intentionally requires that baseline so it can verify the original CLI remains untouched. From the repository root:

```sh
pnpm --filter @agent-spike/013-codex-browser-origin build:native
pnpm --filter @agent-spike/013-codex-browser-origin probe
```

The build runs six focused Rust tests and compiles the separate `codex-app-server` executable. It reuses Spike 003's native Cargo target but does not rebuild or replace its baseline `codex` binary; before/after hashes verify this. The default toolchain paths are `/opt/homebrew/bin/cargo` and `/opt/homebrew/bin/rustc` (1.98.1 in the observed run); set `SPIKE_CARGO` and `SPIKE_RUSTC` if needed. Each native command has an eight-minute timeout and bounded retained logs.

The probe creates fresh local homes with file-only credential storage, disables plugin startup and remote control, and uses no account credentials or model turns. It checks twelve raw upgrade cases, then prints two HTTP page URLs. Open **both** URLs in a real browser within four minutes. One page must initialize successfully; the other must be denied before opening. Both auto-report their results to the local runner, which then stops its listeners and child processes. The pages do not need developer-tool scripts to run. Evidence and raw local logs are under `artifacts/013-codex-browser-origin/`.

## Patch contract

```sh
CODEX_SPIKE_ALLOWED_BROWSER_ORIGINS='["http://127.0.0.1:5173"]' \
  artifacts/013-codex-browser-origin/codex-app-server --listen ws://127.0.0.1:4500
```

- Unset/empty-array allowlist preserves browser denial; clients without `Origin` retain the upstream behavior.
- Configured origins must be exact canonical HTTP(S) origins, with no paths, wildcards, or `null`. Origin scheme, host, and port must match exactly; duplicate/multiple values are rejected.
- The opt-in is accepted only on a loopback listener. An invalid configuration fails startup.
- Existing WebSocket authorization is unchanged. The demonstration uses upstream's **unauthenticated loopback** mode. Browser JavaScript cannot set an arbitrary `Authorization` header, so an authenticated deployment still needs a compatible ingress/auth design. This patch does not solve that problem.
- An origin is not an identity or an authorization credential. Trust every script served from an allowlisted origin, and do not run untrusted content on its port. Non-browser clients can omit/spoof `Origin` just as before.

No installed Codex executable, user configuration, credentials, or upstream commits are changed. The vendor source intentionally remains dirty. The standalone patch file captures that change independently of the submodule's unchanged gitlink. To remove only this patch:

```sh
git -C vendor/codex apply --reverse "$PWD/spikes/013-codex-browser-origin/browser-origin.patch"
```
