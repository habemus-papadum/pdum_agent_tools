# 006 follow-up — Config writes are not a global settings reset

## Question and result

Are there app-server, thread, and turn defaults, and can the server defaults change while the process runs? **Yes, with important qualifications.** There is layered config for constructing threads, effective state owned by each loaded thread, and overrides supplied when starting a turn. A turn override persists as that thread's new default; it is not a temporary scope that automatically unwinds.

The new probe uses real raw WebSocket app-server RPCs without starting a model turn. No authentication or model response fixture is involved. Results match in installed `0.162.1` and our built source `6c372fb`:

| Operation | Observed result |
| --- | --- |
| Start from isolated file defaults: Luna, read-only, never | New thread reports those settings. |
| `config/value/write` changes `sandbox_mode` to full access | A new thread receives full access. |
| `config/batchWrite` changes model to Sol and approval policy, with `reloadUserConfig: true` | A new thread receives Sol, full access, on-request. |
| Inspect the original loaded thread after both writes | Still Luna, read-only, never. |
| Run direct `command/exec` without a sandbox override after both writes | External write is denied: the direct-command path still has startup read-only policy. |
| Repeat with startup `-c` overrides for model, sandbox and approval policy | Config writes succeed on disk, but new threads still use the higher-priority CLI overrides. |

To inspect the loaded thread, the probe changes only reasoning effort to `low` via experimental `thread/settings/update` and awaits `thread/settings/updated`. It does not use warm resume as a settings setter. This probe measures config/settings and a direct OS write; the original spike separately exercised real thread tools and sticky turn policy with a model fixture.

## Implications for the launcher

Specify process defaults intentionally, and explicitly pass the desired policy when starting, forking or cold-resuming a thread and starting a turn. This protects a launcher invariant from omission, shared clients and version-specific defaults; it is not an immutable security constraint. Use `sandbox: "danger-full-access"` for thread lifecycle calls and `sandboxPolicy: {"type":"dangerFullAccess"}` for `turn/start`; both use `approvalPolicy: "never"`. Check effective settings and serialize writers to one thread.

If defaults must be administratively mutable, do not pin those same keys with startup `-c` and expect a lower-priority file write to override them. Conversely, pinning defaults does not prevent explicit thread/turn overrides. Existing threads need explicit thread/turn settings updates, not just a global config write. Model selection is available at thread and turn level; the live generation and telemetry experiment is [spike 009](009-codex-turn-telemetry.md).

## Source explanation, evidence and limits

The pinned [config processor](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/config_processor.rs#L163) distinguishes session-default-only writes and selective runtime reload. The [runtime refresh implementation](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/config/runtime_refresh.rs#L38) clones existing config and refreshes selected fields; it does not replace all thread settings with disk values. The [direct-command processor](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/command_exec_processor.rs#L242) uses its own configuration, not a selected thread's policy. These source links are the newer built revision, not presumed release internals.

```sh
pnpm --filter @agent-spike/006-codex-permissions probe:config
SPIKE_CODEX_BIN="$PWD/artifacts/003-codex-control/target/debug/codex" \
  pnpm --filter @agent-spike/006-codex-permissions probe:config
```

Tested 2026-10-12 on macOS arm64 / Node 26.10.0. Final successful artifacts: `artifacts/006-codex-permissions/config-1791818624411/` (installed), `config-1791818625341/` (built). Each stores the invocation, full control transcript and result. The initial preparation run had a test assertion spelling error (`onRequest` versus the actual `on-request`); it was corrected, not a server failure. No claim is made that every app-server setting is hot-reloadable, that managed requirements can be overridden, or that config reload changes an active turn midway through execution.
