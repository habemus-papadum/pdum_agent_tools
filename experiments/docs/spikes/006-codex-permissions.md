# 006 — Keeping Codex permissions consistent

## Question and result

Does setting `dangerFullAccess` and approval policy `never` once keep a remotely controlled Codex agent unrestricted? **Not across every lifecycle boundary.** We reproduced specific fallbacks and caller-driven changes. This does not establish the cause of the previously observed long-running CLI problem.

The probe uses raw app-server JSON-RPC, two WebSocket clients, isolated home/config directories, and a local deterministic Responses fixture. The real Codex `exec_command` tool tries to write outside its working directory. File contents and tool outputs verify successful writes or OS permission denials. There are **zero paid model calls** and no developer credentials involved. The distinction between sandbox access and approval behavior agrees with the [official permissions documentation](https://learn.chatgpt.com/docs/sandboxing).

## Observed matrix

The initial server config is `read-only` + `never`; one thread explicitly selects full access. “Full” below means the actual external write succeeded; “read-only” means it was denied.

| Operation | Installed 0.162.1 | Built source `6c372fb` |
| --- | --- | --- |
| Later turn omits policy on full-access thread | Full | Full |
| Fork omits policy | **Read-only** | **Read-only** |
| Restart server, resume omits policy | **Read-only** | Full |
| Fork or cold resume explicitly requests full access | Full | Full |
| Client B starts read-only turn; client A later omits policy | **Read-only** | **Read-only** |
| Client A warm-resumes that loaded thread requesting full access | Request ignored; remains read-only | Same |
| Explicit subsequent turn requests full access | Full | Full |
| Server starts with full-access config; default thread/fork omit policy | Full | Full |

Additional traps observed in both versions:

- `codex --dangerously-bypass-approvals-and-sandbox app-server ...` accepts the root CLI flag but still uses the configured read-only server default. Use app-server config overrides.
- `thread/start` needs `sandbox: "danger-full-access"`; a mistaken `sandboxPolicy` field is silently ignored. `turn/start` uses `sandboxPolicy: {type: "dangerFullAccess"}`.
- `command/exec` without a policy uses **server configuration**, independently of a full-access thread. It is not a test of that thread's tool permissions.

## Reproduce and evidence

```sh
pnpm --filter @agent-spike/006-codex-permissions probe
SPIKE_CODEX_BIN="$HOME/.local/bin/codex" pnpm --filter @agent-spike/006-codex-permissions probe
```

Environment: macOS 26.6.2 arm64, Node 26.10.0; compiled Codex `0.0.0` from `6c372fbef45f730b6d8aa727b0ec8332365588db`; installed CLI `0.162.1`, resolved under `~/.codex/packages/standalone/releases/0.162.1-aarch64-apple-darwin/bin/`. Its upstream tag points to `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`; that source was inspected separately. SDK: none.

Complete successful matrices: `artifacts/006-codex-permissions/run-1791814602207/` (built) and `run-1791814604965/` (release), with invocation, RPC, fixture-request and result files. Typecheck/build and both runtime matrices passed. [Detailed source evidence](../../spikes/006-codex-permissions/details.md) explains the release/main difference and separates tested behavior from inspection.

## Launcher implications and limits

Use explicit server defaults plus explicit policy at thread start, fork, cold resume and turn start. Check returned effective permissions; serialize writers to one thread and observe settings changes. A server default is mutable, not an immutable policy constraint. `never` suppresses escalation requests; it does not itself grant filesystem access.

[Runtime configuration follow-up](006-codex-runtime-config.md): config writes affect defaults for newly constructed threads, but do not change existing threads' permissions/model, even with `reloadUserConfig: true` in our tests. CLI `-c` overrides still win, and direct commands retain startup policy. Turn overrides are **sticky thread state**, not automatically reverted after that turn.

The inspected source deliberately copies live parent permissions into spawned/resumed subagents. We did not execute child-agent, compaction, named-profile, managed-policy or long-duration cases. Managed requirements can also reject/fallback from requested profiles. The demonstrated cases can be handled in our launcher without a fork; immutable process-wide behavior or fixing upstream fork inheritance would need a separate, narrowly tested change.
