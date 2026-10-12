# 006 — Codex permissions across lifecycle boundaries

Question: does setting full access once keep an app-server agent unsandboxed across later turns, forks, resumes and other clients?

**Result: it depends on the boundary and version.** We reproduced policy fallback on fork, cold-resume fallback in the installed release, and persistent changes by another client. We also reproduced a CLI flag that does not configure app-server and a silently ignored protocol field. See the [one-page result](../../docs/spikes/006-codex-permissions.md) and [source analysis](details.md).

```sh
pnpm --filter @agent-spike/006-codex-permissions probe
SPIKE_CODEX_BIN="$HOME/.local/bin/codex" pnpm --filter @agent-spike/006-codex-permissions probe
```

The default uses the explicit binary and build metadata from spike 003. Run `pnpm build:codex` first if they are absent. `SPIKE_CODEX_BIN` selects an alternative binary explicitly; the probe records its resolved path and version and does not infer that it matches the submodule.

The probe starts an isolated local app-server with two real WebSocket clients. A deterministic loopback HTTP/SSE server replaces the model API and asks the real Codex tool implementation to write a known string into a throwaway file outside its working directory. It records whether the file exists and the actual tool continuation, including OS permission-denied errors. It does not call a paid model, load developer auth, edit developer configuration, or change host sandbox policy. Temporary homes are outside the repository, avoiding parent project configuration; only the isolated config and explicitly created probe files are changed.

Each RPC/notification wait has a 30-second deadline. Processes and sockets close in `finally`. Artifacts are ignored under `artifacts/006-codex-permissions/run-*/`; their invocation record contains the scratch-directory location. Level 2 here is fixture traffic, not captured live provider traffic. No SDK is used.

`typecheck` and `build` validate/compile the TypeScript. Runtime results are assertions about the actual subprocess, not unit tests mirroring an implementation.

## Runtime configuration follow-up

`pnpm --filter @agent-spike/006-codex-permissions probe:config` tests real configuration writes, new-thread defaults, existing-thread settings, CLI override precedence, and direct-command permissions. It defaults to the installed executable; `SPIKE_CODEX_BIN` selects the built one. This is a control-plane-only probe: no model turn, credentials, or synthetic model response is needed. Results are under ignored `artifacts/006-codex-permissions/config-*/`.

See [runtime configuration findings](../../docs/spikes/006-codex-runtime-config.md). In particular, writing config is not a process-wide settings reset: existing threads retain their policy/model, command execution retains its startup policy, and CLI overrides still beat the written file.
