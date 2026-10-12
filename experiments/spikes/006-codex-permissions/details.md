# Permissions: source explanation and launcher invariants

Inspected and tested 2026-10-12. The executable built in spike 003 is pinned to [6c372fbef45f730b6d8aa727b0ec8332365588db](https://github.com/openai/codex/tree/6c372fbef45f730b6d8aa727b0ec8332365588db). The installed release reports `0.162.1`; its matching upstream tag resolves to [092d3acd6bec3e3a14bdc7e7a2810ab628ab759d](https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d). Source evidence below is pinned rather than assumed from current documentation. We did not rebuild the release from that tag or verify its binary byte-for-byte against an upstream artifact.

## What the experiment actually executes

Each run creates its own home, Codex home, work directory and temporary directory, outside this Git repository. The child environment contains only those locations, a system-only PATH and LANG. A local config chooses a custom Responses provider at a fresh loopback port with `requires_openai_auth=false`, disables telemetry/apps/plugins/bundled skills and avoids developer credentials. `account/read` returns no account. `configRequirements/read` is recorded so the observed environment can be inspected.

The local fixture emits a genuine Responses SSE function call to `exec_command`, waits for Codex's continuation request containing the tool result, then completes the turn. The tool attempts one fixed string write to a newly created artifact path outside the thread's working directory and TMPDIR. Denied cases contain `operation not permitted` from the command, not merely a policy label. We also independently test `command/exec`; it is never used as a substitute for the thread-tool probe.

The model is simulated. These are real subprocess, RPC, persistence, multi-client and OS sandbox observations; they are not live-model behavior measurements. The fixture follows upstream [test response shapes](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/tests/common/responses.rs).

An incidental preparation failure clarified the lifecycle boundary: attempting `thread/resume` on a newly started thread before it had a rollout returned “no rollout found” in both binaries. The final probe completes a fixture turn before using resume to inspect that independent thread.

## Why policies can differ

### Process configuration supplies defaults; each thread has effective state

Two threads in one app-server returned different effective policies: the explicit full-access thread could write, while an omitted-policy thread selected the server's read-only default. Explicit read-only `turn/start` narrowed even a thread created under full-access **process** defaults. Process defaults therefore do not enforce “always full access.”

The [app-server documentation](https://learn.chatgpt.com/docs/app-server) states that turn overrides become defaults for later turns. Our two real WebSocket clients confirmed this on one shared thread: client B's read-only turn changed client A's subsequent omitted-policy turn. This is shared thread state, not a per-connection preference. It did not change a different thread's state or the server default.

### Ordinary fork falls back for the tested legacy policy

The pinned [thread processor](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_processor.rs#L5306) restores the approval policy/reviewer and, when present, an active named permission-profile ID. It then reloads config for the fork. Our explicitly supplied legacy sandbox had `activePermissionProfile: null`. Its full-access policy did not become the new fork's config; the fork returned read-only and the write failed in both binaries. Supplying `sandbox: "danger-full-access"` to `thread/fork` fixed it. Giving the server full-access defaults also made an omitted-policy fork full-access.

This experiment does not establish the same fallback for named permission profiles or the experimental prediction-fork mode. Those follow additional paths.

### Cold resume differs between release and main

The [0.162.1 processor](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server/src/request_processors/thread_processor.rs#L3910) reloads config and restores named profile identity when available. In the tested legacy-policy case, omitted-policy cold resume returned the server's read-only default.

The newer [pinned main resume path](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_processor.rs#L4134) additionally extracts the persisted permission profile from the thread's owned settings snapshot and passes it into `StartThreadOptions`. That explains the observed preservation of full access in this build. Explicit cold-resume policy worked in both. The comparison is version-specific; “Codex always loses sandbox settings on resume” would be incorrect.

### Warm resume rejoins; it is not a reliable settings setter

The [loaded-thread path](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_processor.rs#L4565) compares requested overrides to active settings. If another subscriber still observes the loaded thread, it preserves rejoin semantics and ignores conflicting overrides. It logs a warning and returns the actual effective settings. Our client A requested full access after client B restricted their shared thread; the returned policy remained read-only. An explicit new turn restored full access.

For an idle loaded thread with no subscribers, current main may instead shut down the cached instance and perform a cold resume. Thus “warm resumes ignore overrides” needs the subscriber/running-state qualification; the tested case has two subscribers.

### CLI and protocol shapes are different boundaries

The [CLI app-server dispatch](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/cli/src/main.rs#L1237) passes root config overrides into app-server. The terminal UI's bypass flag does not become those overrides. Both binaries accepted our root bypass flag, yet returned read-only and denied the tool write. The appropriate process configuration is:

```sh
codex app-server --listen stdio:// \
  -c 'sandbox_mode="danger-full-access"' \
  -c 'approval_policy="never"'
```

Thread start/resume/fork use `sandbox: "danger-full-access"`. Turn start and direct command execution use `sandboxPolicy: {"type":"dangerFullAccess"}`. Both binaries silently ignored an incorrect `sandboxPolicy` field on `thread/start`; a successful RPC alone is insufficient validation. The [thread schema](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L62) and [turn schema](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L170) specify the actual shapes.

The [direct command processor](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/command_exec_processor.rs#L242) starts from `self.config.permissions` when its request omits a policy. It has no selected thread whose policy could be inherited. Our direct command failed under read-only defaults while the agent's thread tool succeeded under full access.

## Subagents and constraints: inspected, not executed

Current [child config construction](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/agent/child_config.rs#L61) applies role/model settings and then copies the live parent's approval policy, reviewer, cwd and permission-profile snapshot. The [child resume path](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/agent/control/spawn.rs#L395) also rebuilds from current parent state and reapplies those runtime settings after role configuration. These mechanisms are designed to avoid stale-policy inheritance. We did not execute a child-agent tool in this spike, so this is not a blanket guarantee across every child mode and release.

Managed requirements form a separate constraint layer. [Permission selection](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/config/mod.rs#L4930) can replace a disallowed configured named profile with a required default and emit a startup warning. An [explicit settings update](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/turn_processor.rs#L872) rejects that fallback rather than pretending the requested setting applied. We inspected these paths without modifying machine policy or testing a managed deployment.

## Practical invariants before considering a fork

1. Pin the executable and generate its schema; do not infer app-server behavior from TUI flags or a different release's docs.
2. Supply process defaults explicitly. Supply the correct full-access shape and `approvalPolicy: "never"` at start, fork, cold resume and every new turn that must maintain that invariant.
3. Check returned effective `sandbox`, `approvalPolicy` and, where available, permission-profile provenance. A warm-resume request may succeed with different settings than requested.
4. Serialize writers to a shared thread. Opt into and record `thread/settings/updated` if using that experimental surface. Its payload includes the effective sandbox and approval policy; queued settings updates should be observed before dependent requests.
5. Treat direct commands, thread tools and subagents as distinct execution paths. Record the effective policy next to failed tools so a permission denial can be traced to a specific boundary.
6. Record config layers, startup warnings and applicable managed requirements. Fail our launcher on a mismatch instead of assuming configuration won.

These invariants handled the tested cases without changing Rust. A fork may be worthwhile for an immutable policy assertion inside the harness or a focused fix to legacy-policy fork inheritance, but the spike does not justify deleting all sandbox implementation. No unexplained time-dependent re-enablement was reproduced; compaction, long-running work, named profiles and spawned children remain additional experiments.
